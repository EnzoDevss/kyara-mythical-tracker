"""Migration and reliability checks for the mixed-rarity collector."""
import copy
import json
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
from test_updater import updater, FakeClient, responses, price, snapshot, CREDENTIALS
from test_history import collection


def catalog():
    payloads = responses()
    for i, card in enumerate(payloads["/api/characters"]):
        card["rank"] = i
    payloads["/api/characters"][2]["rarity"] = "L"
    payloads["/api/market/prices/3"] = price(3, 50)
    return payloads


class TopCards(unittest.TestCase):
    def test_fairy_tail_prices_include_every_rank_and_rarity_without_duplicate_requests(self):
        payloads = catalog()
        payloads['/api/characters'][2]['series'] = 'Fairy Tail'
        payloads['/api/characters'].append({'id': 4, 'name': 'Outside Fairy Tail', 'series': 'Fairy Tail', 'rarity': 'C', 'rank': 5000})
        payloads['/api/market/prices/4'] = {**price(4, None), 'sales7d': 0, 'sales30d': 0}
        client = FakeClient(payloads)
        data = updater.collect_snapshot(client, now=lambda: '2026-10-19T12:00:00Z', top_count=3)
        self.assertEqual(data['extraSeries'], ['Fairy Tail'])
        self.assertEqual(len(data['cards']), 4)
        self.assertEqual(len([c for c in data['cards'] if c['inTop']]), 3)
        self.assertEqual(client.calls.count('/api/market/prices/3'), 1)
        self.assertEqual(client.calls.count('/api/market/prices/4'), 1)
        outside = next(c for c in data['cards'] if c['id'] == 4)
        self.assertFalse(outside['inTop'])
        self.assertIsNone(outside['median7d'])
        self.assertEqual(data['pools'][0]['cardIds'], [1])
        updater.validate_snapshot(data)
        outside['series'] = 'Unrelated series'
        with self.assertRaises(updater.UpdateError):
            updater.validate_snapshot(data)

    def test_persistent_transport_reuses_connection_and_preserves_http_status(self):
        class Response:
            status = 200
            headers = {}
            def read(self): return b''
        class Connection:
            def __init__(self, *args, **kwargs): self.calls = 0
            def request(self, *args, **kwargs): self.calls += 1
            def getresponse(self): return response
        response = Response()
        connection = Connection()
        with patch.object(updater.http.client, 'HTTPSConnection', return_value=connection):
            opener = updater.PersistentOpener()
            request = urllib.request.Request('https://kyara.games/api/test')
            opener.open(request)
            opener.open(request)
            self.assertEqual(connection.calls, 2)
            response.status = 429
            response.headers = {'Retry-After': '90'}
            with self.assertRaises(urllib.error.HTTPError) as raised:
                opener.open(request)
            self.assertEqual(raised.exception.code, 429)
            self.assertEqual(raised.exception.headers['Retry-After'], '90')

    def test_rank_selects_cards_once_and_preserves_comparison_membership(self):
        client = FakeClient(catalog())
        data = updater.collect_snapshot(client, now=lambda: "2026-10-14T15:00:00Z", top_count=3)
        self.assertEqual(len(data["cards"]), 3)
        self.assertEqual(data["cards"][2]["rarity"], "L")
        self.assertEqual(data["cards"][2]["rank"], 3)
        self.assertEqual(data["pools"][0]["cardIds"], [1])
        self.assertEqual(client.calls.count("/api/market/prices/1"), 1)
        updater.validate_snapshot(data)
        data["cards"][2]["rank"] = 2
        with self.assertRaises(updater.UpdateError):
            updater.validate_snapshot(data)

    def test_outside_top_comparison_card_remains_available(self):
        data = updater.collect_snapshot(FakeClient(catalog()), now=lambda: "2026-10-14T15:00:00Z", top_count=1)
        self.assertEqual(len(data["cards"]), 2)
        self.assertEqual([c["id"] for c in data["cards"] if c["inTop"]], [1])

    def test_full_booster_labels_are_separate_from_mythical_comparison_pools(self):
        payloads = catalog()
        payloads['/api/packs/husbando/characters'] = [2]
        client = FakeClient(payloads)
        data = updater.collect_snapshot(client, now=lambda: '2026-10-14T15:00:00Z', top_count=3)
        cards = {c['id']: c for c in data['cards']}
        self.assertEqual(cards[3]['boosters'], ['waifu'])
        self.assertEqual(cards[2]['boosters'], ['husbando'])
        self.assertEqual(data['pools'], snapshot()['pools'])
        self.assertEqual(client.calls.count('/api/packs/waifu/characters'), 1)
        self.assertEqual(len(client.calls), 6)

    def test_isolated_failure_carries_price_but_no_new_history_observation(self):
        payloads = catalog()
        payloads["/api/market/prices/1"] = updater.UpdateError("network unavailable")
        data = updater.collect_snapshot(FakeClient(payloads), now=lambda: "2026-10-14T15:30:00Z", top_count=3, previous=snapshot())
        card = data["cards"][0]
        self.assertTrue(card["stale"])
        self.assertEqual(card["median7d"], 2000)
        old = updater.append_history(None, collection(), 1)
        history = updater.append_history(old, data, 1)
        self.assertEqual(history["cards"]["1"]["median7d"], [2000, None])
        updater.snapshot_changes(history, data)
        self.assertIsNone(card["change24h"]["median7d"])

    def test_widespread_failure_aborts(self):
        payloads = catalog()
        for i in [1, 2]:
            payloads[f"/api/market/prices/{i}"] = updater.UpdateError("network failure")
        with self.assertRaises(updater.UpdateError):
            updater.collect_snapshot(FakeClient(payloads), top_count=3)

    def test_legacy_migration_preserves_every_value_and_new_cards_have_no_backfill(self):
        legacy = updater.append_history(None, collection(value=0), 1)
        legacy = updater.append_history(legacy, collection(.5, None), 1)
        legacy = updater.append_history(legacy, collection(1, 2100.5), 1)
        compact = updater.compact_history(legacy)
        self.assertEqual(updater.expand_history(compact, 1), legacy)
        data = collection(1.5)
        data["cards"].append({**data["cards"][0], "id": 9})
        continued = updater.append_history(updater.expand_history(compact, 1), data, 1)
        self.assertEqual(continued["cards"]["9"]["median7d"], [None, None, None, 2000])
        updater.snapshot_changes(continued, data)
        self.assertIsNone(data["cards"][-1]["change24h"]["median7d"])

    def test_compact_upload_uses_eight_writes_and_precomputes_percentages(self):
        class Store(FakeClient):
            def request_json(self, url, **kwargs):
                if kwargs.get("method", "GET") == "GET":
                    return updater.append_history(None, collection(), int(url[-1]))
                return super().request_json(url, **kwargs)
        client = Store()
        data = collection(.5, 2200)
        data["selection"] = "wiki-top"
        updater.upload_history(client, data, CREDENTIALS)
        self.assertEqual(len(client.uploads), 8)
        self.assertEqual(data["cards"][0]["change24h"]["median7d"], 10)
        saved = json.loads(client.uploads[1][1]["data"])
        self.assertEqual(saved["schemaVersion"], 2)
        self.assertIsInstance(saved["cards"]["1"], str)
        saved["cards"]["1"] = '{"median7d":[[1,20]]}'
        with self.assertRaises(updater.UpdateError):
            updater.expand_history(saved, 1)


if __name__ == "__main__":
    unittest.main()
