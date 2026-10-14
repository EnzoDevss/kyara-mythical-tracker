"""History persistence tests. Every external request is simulated."""
import copy
import json
import unittest
import tempfile
from pathlib import Path
from datetime import datetime, timedelta, timezone
from test_updater import updater, snapshot, FakeClient, CREDENTIALS, FakeOpener, http_error


def at(hours=0):
    return (datetime(2026, 10, 14, 15, tzinfo=timezone.utc) + timedelta(hours=hours)).isoformat(timespec="seconds").replace("+00:00", "Z")


def collection(hours=0, value=2000):
    data = snapshot()
    data["collectedAt"] = at(hours)
    data["cards"][0]["median7d"] = value
    return data


class HistoryTests(unittest.TestCase):
    def test_records_every_update_even_unchanged_and_preserves_source(self):
        first = updater.append_history(None, collection(), 1)
        saved = copy.deepcopy(first)
        second = updater.append_history(first, collection(0.5), 1)
        self.assertEqual(first, saved)
        self.assertEqual(len(second["timestamps"]), 2)
        self.assertEqual(second["cards"]["1"]["median7d"], [2000, 2000])
        self.assertEqual(second["timestamps"][1] - second["timestamps"][0], 1800)

    def test_replaying_same_timestamp_does_not_duplicate_it(self):
        first = updater.append_history(None, collection(), 1)
        again = updater.append_history(first, collection(value=2100), 1)
        self.assertEqual(len(again["timestamps"]), 1)
        self.assertEqual(again["cards"]["1"]["median7d"], [2100])

    def test_prunes_only_points_outside_thirty_days(self):
        history = updater.append_history(None, collection(), 1)
        history = updater.append_history(history, collection(0.5, 2100), 1)
        history = updater.append_history(history, collection(720, 2200), 1)
        self.assertEqual(len(history["timestamps"]), 3)
        history = updater.append_history(history, collection(720.5, 2300), 1)
        self.assertEqual(history["cards"]["1"]["median7d"], [2100, 2200, 2300])

    def test_zero_and_null_remain_distinct(self):
        history = updater.append_history(None, collection(value=0), 1)
        history = updater.append_history(history, collection(0.5, None), 1)
        self.assertEqual(history["cards"]["1"]["median7d"], [0, None])

    def test_new_cards_have_no_invented_earlier_prices(self):
        history = updater.append_history(None, collection(), 1)
        data = collection(0.5)
        data["cards"].append({**data["cards"][0], "id": 9, "name": "New card"})
        history = updater.append_history(history, data, 1)
        self.assertEqual(history["cards"]["9"]["median7d"], [None, 2000])
        self.assertEqual(history["cards"]["9"]["firstSeenAt"], history["timestamps"][-1])

    def test_removed_cards_keep_history_until_it_ages_out(self):
        history = updater.append_history(None, collection(), 1)
        data = collection(0.5)
        data["cards"] = data["cards"][1:]
        history = updater.append_history(history, data, 1)
        self.assertEqual(history["cards"]["1"]["median7d"], [2000, None])
        data["collectedAt"] = at(721)
        history = updater.append_history(history, data, 1)
        self.assertNotIn("1", history["cards"])

    def test_corrupted_history_or_old_collection_is_not_overwritten(self):
        original = updater.append_history(None, collection(), 1)
        for corrupt in [
            lambda h: h.update(schemaVersion=2),
            lambda h: h.update(bucket=3),
            lambda h: h["timestamps"].append(h["timestamps"][0]),
            lambda h: h["cards"]["1"]["median7d"].append(5),
            lambda h: h["cards"]["1"]["median7d"].__setitem__(0, "2000"),
        ]:
            history = copy.deepcopy(original)
            corrupt(history)
            with self.assertRaises(updater.UpdateError):
                updater.append_history(history, collection(0.5), 1)
        with self.assertRaises(updater.UpdateError):
            updater.append_history(original, collection(-0.5), 1)

    def test_missing_history_is_only_a_404_not_a_network_or_auth_failure(self):
        for status in (403, 500):
            client = updater.JsonClient(opener=FakeOpener([http_error(status)]), sleep=lambda _: None)
            with self.assertRaises(updater.UpdateError):
                client.request_json("https://example.com", allow_missing=True, attempts=1)
        client = updater.JsonClient(opener=FakeOpener([http_error(404)]), sleep=lambda _: None)
        self.assertIsNone(client.request_json("https://example.com", allow_missing=True))
        client = updater.JsonClient(opener=FakeOpener([http_error(404)]), sleep=lambda _: None)
        with self.assertRaises(updater.UpdateError):
            client.request_json("https://example.com")

    def test_reads_all_buckets_before_any_writes(self):
        class Store(FakeClient):
            def request_json(self, url, **kwargs):
                if kwargs.get("method", "GET") == "GET" and url.endswith("history-v1-7"):
                    raise updater.UpdateError("read failed")
                return super().request_json(url, **kwargs)
        store = Store()
        with self.assertRaises(updater.UpdateError):
            updater.upload_history(store, collection(), CREDENTIALS)
        self.assertEqual(store.uploads, [])

    def test_cloud_updates_accumulate_in_existing_buckets(self):
        class Store(FakeClient):
            def __init__(self):
                super().__init__()
                self.values = {}
            def request_json(self, url, **kwargs):
                key = url.rsplit("/", 1)[-1]
                if kwargs.get("method", "GET") == "GET":
                    return copy.deepcopy(self.values.get(key))
                self.values[key] = json.loads(kwargs["data"])
                return super().request_json(url, **kwargs)
        store = Store()
        updater.upload_history(store, collection(), CREDENTIALS)
        updater.upload_history(store, collection(0.5, 2200), CREDENTIALS)
        self.assertEqual(len(store.uploads), 16)
        self.assertEqual(store.values["history-v1-1"]["cards"]["1"]["median7d"], [2000, 2200])

    def test_partial_history_write_failure_does_not_publish_latest(self):
        class Store(FakeClient):
            def request_json(self, url, **kwargs):
                if kwargs.get("method") == "PUT" and url.endswith("history-v1-4"):
                    raise updater.UpdateError("write failed")
                return super().request_json(url, **kwargs)
        store = Store()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            output.write_bytes(b"previous")
            with self.assertRaises(updater.UpdateError):
                updater.run_update(output, upload=True, environ=CREDENTIALS, client=store)
            self.assertEqual(output.read_bytes(), b"previous")
        self.assertEqual(len(store.uploads), 4)
        self.assertFalse(any(url.endswith("/latest") for url, _ in store.uploads))


if __name__ == '__main__':
    unittest.main()
