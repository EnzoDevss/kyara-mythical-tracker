"""Offline regression tests; no calls to Kyara or Cloudflare are made."""

import copy
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "update_prices.py"
SPEC = importlib.util.spec_from_file_location("update_prices", MODULE_PATH)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)

STAMP = "2026-10-14T15:00:00Z"
CREDENTIALS = {"CLOUDFLARE_API_TOKEN": "test-token-never-print",
               "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
               "CLOUDFLARE_KV_NAMESPACE_ID": "b" * 32}


def price(card_id, median=2000):
    return {"characterId": card_id, "median7d": median, "median30d": median,
            "sales7d": 3, "sales30d": 5}


def responses():
    return {"/api/characters": [{"id": 1, "name": "Alpha", "series": "Example A", "rarity": "M"},
                                {"id": 2, "name": "Beta", "series": "Example B", "rarity": "M"},
                                {"id": 3, "name": "Common", "series": "Example B", "rarity": "C"}],
            "/api/packs/waifu/characters": [1, 3],
            "/api/packs/husbando/characters": [2, 3],
            "/api/market/prices/1": price(1),
            "/api/market/prices/2": price(2, 1000)}


class FakeClient:
    def __init__(self, payloads=None, upload_result=None):
        self.payloads = responses() if payloads is None else payloads
        self.calls = []
        self.uploads = []
        self.upload_result = {"success": True} if upload_result is None else upload_result

    def get_kyara(self, path):
        self.calls.append(path)
        value = self.payloads[path]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def request_json(self, url, **kwargs):
        if kwargs.get("method", "GET") == "GET":
            return None
        self.uploads.append((url, kwargs))
        return self.upload_result


def snapshot():
    return updater.collect_snapshot(FakeClient(), now=lambda: STAMP)


class FakeTime:
    def __init__(self):
        self.time = 0.0
        self.waits = []

    def now(self):
        return self.time

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.time += seconds


class FakeResponse(io.BytesIO):
    status = 200


class FakeOpener:
    def __init__(self, results):
        self.results = list(results)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        value = self.results.pop(0)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, bytes):
            return FakeResponse(value)
        return FakeResponse(json.dumps(value).encode())


def http_error(status, retry_after=None):
    headers = {} if retry_after is None else {"Retry-After": retry_after}
    return urllib.error.HTTPError("https://kyara.games/api/test", status, "test error", headers, io.BytesIO(b"ignored"))


class SchemaTests(unittest.TestCase):
    def test_discovery_filters_other_rarities_and_uses_exact_endpoints(self):
        client = FakeClient()
        result = updater.collect_snapshot(client, now=lambda: STAMP)
        self.assertEqual([card["id"] for card in result["cards"]], [1, 2])
        self.assertEqual(result["pools"][0]["cardIds"], [1])
        self.assertEqual(result["pools"][1]["cardIds"], [2])
        self.assertEqual(len(client.calls), 5)
        self.assertNotIn("/api/market/prices/3", client.calls)
        updater.validate_snapshot(result)

    def test_new_mythical_is_discovered_without_a_fixed_card_list(self):
        payloads = responses()
        payloads["/api/characters"].append({"id": 4, "name": "New", "series": None, "rarity": "M"})
        payloads["/api/packs/waifu/characters"].append(4)
        payloads["/api/market/prices/4"] = price(4)
        result = updater.collect_snapshot(FakeClient(payloads), now=lambda: STAMP)
        self.assertEqual(result["pools"][0]["cardIds"], [1, 4])
        self.assertEqual(result["cards"][-1]["series"], "")

    def test_shared_card_is_fetched_once(self):
        payloads = responses()
        payloads["/api/packs/husbando/characters"].append(1)
        client = FakeClient(payloads)
        result = updater.collect_snapshot(client, now=lambda: STAMP)
        self.assertEqual(len(result["cards"]), 2)
        self.assertEqual(client.calls.count("/api/market/prices/1"), 1)

    def test_null_and_zero_are_preserved(self):
        payload = {"characterId": 1, "median7d": None, "median30d": 0, "sales7d": None, "sales30d": 0}
        result = updater.parse_price(payload, 1)
        self.assertIsNone(result["median7d"])
        self.assertEqual(result["median30d"], 0)
        self.assertIsNone(result["sales7d"])
        self.assertEqual(result["sales30d"], 0)

    def test_bad_price_values_are_rejected(self):
        for field, invalid in [("median7d", True), ("median7d", "1200"), ("median7d", -1),
                               ("median30d", float("nan")), ("median30d", float("inf")),
                               ("sales7d", False), ("sales7d", 1.5), ("sales30d", -2)]:
            with self.subTest(field=field, invalid=invalid):
                payload = price(1)
                payload[field] = invalid
                with self.assertRaises(updater.UpdateError):
                    updater.parse_price(payload, 1)

    def test_missing_fields_are_not_treated_as_null(self):
        for field in ("characterId", *updater.PRICE_FIELDS):
            with self.subTest(field=field):
                payload = price(1)
                del payload[field]
                with self.assertRaises(updater.UpdateError):
                    updater.parse_price(payload, 1)

    def test_price_id_must_match_and_cannot_be_a_boolean(self):
        for invalid in (2, True, None, "1", 1.0):
            with self.subTest(invalid=invalid), self.assertRaises(updater.UpdateError):
                updater.parse_price(price(invalid), 1)

    def test_catalog_duplicates_and_bad_ids_are_rejected(self):
        base = responses()["/api/characters"]
        with self.assertRaises(updater.UpdateError):
            updater.parse_catalog(base + [base[0]])
        for invalid in (None, True, "1", 0, -1):
            data = copy.deepcopy(base)
            data[0]["id"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(updater.UpdateError):
                updater.parse_catalog(data)

    def test_pool_ids_must_exist_and_be_unique_and_integer(self):
        catalog = updater.parse_catalog(responses()["/api/characters"])
        for invalid in ([], [1, 1], [1, 999], [1, True], [1, "2"], [3], {"ids": [1]}):
            with self.subTest(invalid=invalid), self.assertRaises(updater.UpdateError):
                updater.parse_pool(invalid, "waifu", catalog)

    def test_snapshot_requires_exact_pool_card_coverage(self):
        mutations = [lambda data: data["cards"].append(copy.deepcopy(data["cards"][0])),
                     lambda data: data["pools"][0]["cardIds"].append(1),
                     lambda data: data["pools"][0]["cardIds"].append(999),
                     lambda data: data["cards"].pop(),
                     lambda data: data["pools"].pop(),
                     lambda data: data["pools"][1].update(id="waifu"),
                     lambda data: data["pools"][0].update(cardIds=[2])]
        for mutate in mutations:
            data = snapshot()
            mutate(data)
            with self.assertRaises(updater.UpdateError):
                updater.validate_snapshot(data)

    def test_snapshot_rejects_metadata_or_timestamp_corruption(self):
        for field, invalid in [("schemaVersion", True), ("schemaVersion", 2),
                               ("source", "other"), ("currency", "USD"),
                               ("collectedAt", "2026-10-14T15:00:00"),
                               ("collectedAt", "2026-10-13T15:00:00Z")]:
            data = snapshot()
            data[field] = invalid
            with self.subTest(field=field), self.assertRaises(updater.UpdateError):
                updater.validate_snapshot(data)

    def test_nonstandard_json_and_duplicate_keys_are_rejected(self):
        for raw in (b'{"price":NaN}', b'{"a":1,"a":2}', b'<html>blocked</html>', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises(updater.UpdateError):
                updater.decode_json(raw)


class ReliabilityTests(unittest.TestCase):
    def test_partial_failure_preserves_existing_file_and_does_not_upload(self):
        payloads = responses()
        payloads["/api/market/prices/2"] = updater.UpdateError("unavailable")
        client = FakeClient(payloads)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            output.write_bytes(b"previous successful snapshot")
            with self.assertRaises(updater.UpdateError):
                updater.run_update(output, upload=True, environ=CREDENTIALS, client=client)
            self.assertEqual(output.read_bytes(), b"previous successful snapshot")
            self.assertEqual(client.uploads, [])
            self.assertEqual([item.name for item in Path(directory).iterdir()], ["latest.json"])

    def test_upload_failure_preserves_existing_file(self):
        client = FakeClient(upload_result={"success": False, "errors": [{"message": "private detail"}]})
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            output.write_bytes(b"previous")
            with self.assertRaises(updater.UpdateError):
                updater.run_update(output, upload=True, environ=CREDENTIALS, client=client)
            self.assertEqual(output.read_bytes(), b"previous")
            self.assertEqual(len(client.uploads), 1)

    def test_invalid_credentials_fail_before_any_network_or_output(self):
        for credentials in ({}, {**CREDENTIALS, "CLOUDFLARE_ACCOUNT_ID": "bad/id"}):
            client = FakeClient()
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "not-created" / "latest.json"
                with self.assertRaises(updater.UpdateError):
                    updater.run_update(output, upload=True, environ=credentials, client=client)
                self.assertEqual(client.calls, [])
                self.assertFalse(output.parent.exists())

    def test_complete_snapshot_is_written_after_eight_history_buckets(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "data" / "latest.json"
            updater.run_update(output, upload=True, environ=CREDENTIALS, client=client)
            updater.validate_snapshot(updater.decode_json(output.read_bytes()))
            self.assertEqual(len(client.uploads), 9)
            self.assertTrue(all(f"/values/history-v1-{i}" in client.uploads[i][0] for i in range(8)))
            url, arguments = client.uploads[-1]
            self.assertTrue(url.endswith("/values/latest"))
            self.assertEqual(arguments["method"], "PUT")
            self.assertEqual(arguments["data"], output.read_bytes())
            self.assertEqual(arguments["attempts"], 1)

    def test_failed_atomic_replace_keeps_previous_file_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            output.write_bytes(b"previous")
            with patch.object(updater.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    updater.atomic_write(output, b"new")
            self.assertEqual(output.read_bytes(), b"previous")
            self.assertEqual([item.name for item in Path(directory).iterdir()], ["latest.json"])

    def test_validate_only_has_no_network_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            output.write_text(json.dumps(snapshot()), encoding="utf-8")
            with patch.object(updater, "JsonClient", side_effect=AssertionError("network client created")):
                self.assertEqual(updater.main(["--validate-only", str(output)]), 0)

    def test_upload_rejection_does_not_print_response_body_or_token(self):
        client = FakeClient(upload_result={"success": False, "errors": [{"message": CREDENTIALS["CLOUDFLARE_API_TOKEN"]}]})
        with patch.object(updater, "JsonClient", return_value=client), patch.dict(updater.os.environ, CREDENTIALS), io.StringIO() as output:
            with redirect_stderr(output):
                result = updater.main(["--upload"])
            self.assertEqual(result, 1)
            self.assertNotIn(CREDENTIALS["CLOUDFLARE_API_TOKEN"], output.getvalue())


class HttpTests(unittest.TestCase):
    def make_client(self, results):
        timer = FakeTime()
        opener = FakeOpener(results)
        client = updater.JsonClient(opener=opener, sleep=timer.sleep, clock=timer.now, wall_clock=lambda: 0)
        return client, timer, opener

    def test_requests_are_paced(self):
        client, timer, opener = self.make_client([{}, {}, {}])
        for _ in range(3):
            client.get_kyara("/api/test")
        self.assertEqual(timer.waits, [1.0, 1.0])
        self.assertEqual(len(opener.requests), 3)

    def test_429_honors_retry_after(self):
        client, timer, opener = self.make_client([http_error(429, "25"), {"ok": True}])
        self.assertEqual(client.get_kyara("/api/test"), {"ok": True})
        self.assertEqual(timer.waits, [25.0])
        self.assertEqual(len(opener.requests), 2)

    def test_retry_after_http_date_is_supported(self):
        client, timer, _ = self.make_client([http_error(503, "Thu, 01 Jan 1970 00:01:00 GMT"), {}])
        client.get_kyara("/api/test")
        self.assertEqual(timer.waits, [60.0])

    def test_long_cooldown_aborts_without_retrying_early(self):
        client, timer, opener = self.make_client([http_error(429, "3600")])
        with self.assertRaises(updater.UpdateError):
            client.get_kyara("/api/test")
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(timer.waits, [])

    def test_repeated_5xx_stops_after_three_attempts(self):
        client, timer, opener = self.make_client([http_error(500), http_error(503), http_error(502)])
        with self.assertRaises(updater.UpdateError):
            client.get_kyara("/api/test")
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(timer.waits, [10.0, 20.0])

    def test_denied_access_and_nonretryable_errors_stop_immediately(self):
        for status in (401, 403, 404, 302):
            client, timer, opener = self.make_client([http_error(status)])
            with self.subTest(status=status), self.assertRaises(updater.UpdateError):
                client.get_kyara("/api/test")
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(timer.waits, [])

    def test_malformed_success_response_is_not_retried(self):
        client, timer, opener = self.make_client([b"<html>blocked</html>"])
        with self.assertRaises(updater.UpdateError):
            client.get_kyara("/api/test")
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(timer.waits, [])

    def test_network_error_retries_are_bounded(self):
        client, timer, opener = self.make_client([urllib.error.URLError("not logged") for _ in range(3)])
        with self.assertRaises(updater.UpdateError):
            client.get_kyara("/api/test")
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(timer.waits, [10.0, 20.0])

    def test_redirect_handler_never_forwards_request(self):
        result = updater.NoRedirectHandler().redirect_request(None, None, 302, "redirect", {}, "https://other.example")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
