#!/usr/bin/env python3
"""Collect a complete Kyara Mythical-price snapshot using only the standard library.

Run from the repository root:
    python scripts/update_prices.py --output data/latest.json
    python scripts/update_prices.py --output data/latest.json --upload
    python scripts/update_prices.py --validate-only data/latest.json

Upload uses CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_KV_NAMESPACE_ID, writing ``latest`` and eight compact history keys.
The output is replaced only after every API response passes validation and,
when requested, Cloudflare accepts the complete snapshot. No partial snapshot
is published. This uses undocumented, public endpoints; schema/access changes
stop collection instead of silently producing an incomplete report.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
import http.client
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable

KYARA_BASE = "https://kyara.games"
POOL_NAMES = {"waifu": "Waifus", "husbando": "Husbandos"}
PRICE_FIELDS = ("median7d", "median30d", "sales7d", "sales30d")
REQUEST_INTERVAL_SECONDS = 1.0
MAX_RETRY_WAIT_SECONDS = 120.0
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
HISTORY_BUCKETS = 8
HISTORY_SECONDS = 30 * 24 * 60 * 60
USER_AGENT = "KyaraMythicalPriceTracker/1.0 (read-only public price comparison)"


class PersistentOpener:
    """One reusable HTTPS connection per host per worker; never follows redirects."""
    def __init__(self):
        self.local = threading.local()

    def open(self, request, timeout=30):
        url = urlsplit(request.full_url)
        require(url.scheme == "https", "Only HTTPS API requests are supported.")
        if not hasattr(self.local, "connections"):
            self.local.connections = {}
        connections = self.local.connections
        connection = connections.setdefault(url.netloc, http.client.HTTPSConnection(url.netloc, timeout=timeout))
        try:
            connection.request(request.get_method(), url.path + ("?" + url.query if url.query else ""),
                               body=request.data, headers=dict(request.header_items()))
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                headers, status = response.headers, response.status
                response.read()
                raise urllib.error.HTTPError(request.full_url, status, "API error", headers, None)
            return response
        except urllib.error.HTTPError:
            raise
        except (OSError, http.client.HTTPException):
            connection.close()
            connections.pop(url.netloc, None)
            raise urllib.error.URLError("Connection interrupted") from None


class UpdateError(Exception):
    """An expected, safely printable collection/validation/upload failure."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise UpdateError(message)


def positive_id(value: Any, label: str) -> int:
    require(type(value) is int and 0 < value <= MAX_SAFE_INTEGER,
            f"{label}: expected a positive integer ID.")
    return value


def nonempty_string(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()),
            f"{label}: expected a nonempty string.")
    return value


def number_or_null(value: Any, label: str, *, integer: bool = False) -> Any:
    if value is None:
        return None
    accepted = type(value) is int if integer else type(value) in (int, float)
    require(accepted, f"{label}: expected {'an integer' if integer else 'a number'} or null.")
    require(0 <= value <= MAX_SAFE_INTEGER and math.isfinite(value),
            f"{label}: expected a finite, nonnegative value.")
    return value


def reject_constant(_value: str) -> None:
    raise UpdateError("Response contains a nonstandard JSON number.")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, "Response contains duplicate JSON object keys.")
        result[key] = value
    return result


def decode_json(data: bytes) -> Any:
    try:
        return json.loads(data.decode("utf-8-sig"), parse_constant=reject_constant,
                          object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as exc:
        raise UpdateError("Response is not valid UTF-8 JSON.") from exc


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(value: Any, label: str) -> datetime:
    require(isinstance(value, str), f"{label}: expected an ISO UTC timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UpdateError(f"{label}: invalid ISO timestamp.") from exc
    require(parsed.utcoffset() is not None and parsed.utcoffset().total_seconds() == 0,
            f"{label}: timestamp must explicitly use UTC.")
    return parsed


def parse_catalog(payload: Any) -> dict[int, dict[str, Any]]:
    require(isinstance(payload, list) and bool(payload), "Character catalog must be a nonempty array.")
    catalog: dict[int, dict[str, Any]] = {}
    for item in payload:
        require(isinstance(item, dict), "Character catalog contains a non-object entry.")
        card_id = positive_id(item.get("id"), "Catalog id")
        require(card_id not in catalog, f"Character catalog contains duplicate ID {card_id}.")
        nonempty_string(item.get("rarity"), f"Catalog rarity for {card_id}")
        if item["rarity"] == "M":
            nonempty_string(item.get("name"), f"Catalog name for {card_id}")
            require("series" in item and (item["series"] is None or isinstance(item["series"], str)),
                    f"Catalog series for {card_id}: expected a string or null.")
        catalog[card_id] = item
    return catalog


def parse_pool(payload: Any, pool_id: str, catalog: dict[int, dict[str, Any]]) -> dict[str, Any]:
    require(isinstance(payload, list) and bool(payload), f"{pool_id} pool must be a nonempty ID array.")
    seen: set[int] = set()
    mythical_ids: list[int] = []
    for value in payload:
        card_id = positive_id(value, f"{pool_id} pool ID")
        require(card_id not in seen, f"{pool_id} pool contains duplicate ID {card_id}.")
        require(card_id in catalog, f"{pool_id} pool ID {card_id} is missing from the catalog.")
        seen.add(card_id)
        if catalog[card_id]["rarity"] == "M":
            mythical_ids.append(card_id)
    require(bool(mythical_ids), f"{pool_id} pool contains no Mythicals; refusing an empty snapshot.")
    return {"id": pool_id, "name": POOL_NAMES[pool_id], "cardIds": sorted(mythical_ids)}


def parse_price(payload: Any, expected_id: int) -> dict[str, Any]:
    require(isinstance(payload, dict), f"Price response for {expected_id} must be an object.")
    actual_id = positive_id(payload.get("characterId"), f"Price response characterId for {expected_id}")
    require(actual_id == expected_id, f"Price response ID does not match requested card {expected_id}.")
    result = {}
    for field in PRICE_FIELDS:
        require(field in payload, f"Price response for {expected_id} is missing {field}.")
        result[field] = number_or_null(payload[field], f"{field} for {expected_id}", integer=field.startswith("sales"))
    return result


def validate_snapshot(snapshot: Any) -> None:
    require(isinstance(snapshot, dict), "Snapshot must be an object.")
    require(type(snapshot.get("schemaVersion")) is int and snapshot["schemaVersion"] == 1,
            "Unsupported snapshot schemaVersion.")
    require(snapshot.get("source") == "kyara-public-api", "Unexpected snapshot source.")
    require(snapshot.get("currency") == "chakra", "Unexpected snapshot currency.")
    started = parse_timestamp(snapshot.get("collectionStartedAt"), "collectionStartedAt")
    catalog_time = parse_timestamp(snapshot.get("catalogUpdatedAt"), "catalogUpdatedAt")
    completed = parse_timestamp(snapshot.get("collectedAt"), "collectedAt")
    require(started <= catalog_time <= completed, "Snapshot timestamps are out of order.")
    cards = snapshot.get("cards")
    require(isinstance(cards, list) and bool(cards), "Snapshot cards must be a nonempty array.")
    card_ids: set[int] = set()
    for card in cards:
        require(isinstance(card, dict), "Snapshot cards contain a non-object entry.")
        card_id = positive_id(card.get("id"), "Snapshot card ID")
        require(card_id not in card_ids, f"Snapshot contains duplicate card ID {card_id}.")
        card_ids.add(card_id)
        nonempty_string(card.get("name"), f"Snapshot name for {card_id}")
        if "boosters" in card:
            require(isinstance(card["boosters"], list) and all(isinstance(x, str) and x in POOL_NAMES for x in card["boosters"])
                    and len(set(card["boosters"])) == len(card["boosters"]), "Invalid booster membership.")
        require(card.get("rarity") in (("M", "L", "E", "R", "U", "C") if snapshot.get("selection") == "wiki-top" else ("M",)),
                f"Snapshot card {card_id} has an invalid rarity.")
        require(isinstance(card.get("series"), str), f"Snapshot series for {card_id} must be a string.")
        require(card.get("sourceUrl") == f"{KYARA_BASE}/wiki/{card_id}",
                f"Snapshot source URL for {card_id} is invalid.")
        parse_price({**card, "characterId": card_id}, card_id)
    pools = snapshot.get("pools")
    require(isinstance(pools, list) and len(pools) == len(POOL_NAMES), "Snapshot must contain exactly two pools.")
    seen_pools: set[str] = set()
    referenced: set[int] = set()
    for pool in pools:
        require(isinstance(pool, dict), "Snapshot pools contain a non-object entry.")
        pool_id = pool.get("id")
        require(isinstance(pool_id, str) and pool_id in POOL_NAMES and pool_id not in seen_pools,
                "Snapshot contains an unknown or duplicate pool.")
        seen_pools.add(pool_id)
        require(pool.get("name") == POOL_NAMES[pool_id], f"Unexpected name for pool {pool_id}.")
        ids = pool.get("cardIds")
        require(isinstance(ids, list) and bool(ids), f"Snapshot pool {pool_id} must contain card IDs.")
        seen: set[int] = set()
        for value in ids:
            card_id = positive_id(value, f"Snapshot pool {pool_id} ID")
            require(card_id not in seen, f"Snapshot pool {pool_id} contains duplicate IDs.")
            require(card_id in card_ids, f"Snapshot pool {pool_id} references a missing card.")
            seen.add(card_id)
        referenced.update(seen)
    if snapshot.get("selection") == "wiki-top":
        ranked = [card for card in cards if card.get("inTop")]
        require(type(snapshot.get("topCount")) is int and 1 <= snapshot["topCount"] <= 1000
                and len(ranked) == snapshot["topCount"], "Top-card coverage is incomplete.")
        require(sorted(card.get("rank") for card in ranked) == list(range(1, snapshot["topCount"] + 1)),
                "Wiki ranks are missing or duplicated.")
        by_id = {card["id"]: card for card in cards}
        require(all(by_id[i]["rarity"] == "M" for i in referenced), "Comparison pools must contain Mythicals only.")
        require(all(c.get("inTop") or c["id"] in referenced for c in cards), "Unexpected unranked card.")
    else:
        require(referenced == card_ids, "Snapshot contains cards outside the selected pools.")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward credentials or follow a changed API location silently."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


class JsonClient:
    def __init__(self, *, opener: Any = None, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic,
                 wall_clock: Callable[[], float] = time.time, interval: float = REQUEST_INTERVAL_SECONDS,
                 persistent: bool = False) -> None:
        self.opener = opener if opener is not None else PersistentOpener() if persistent else urllib.request.build_opener(NoRedirectHandler())
        self.sleep = sleep
        self.clock = clock
        self.wall_clock = wall_clock
        self.last_request_at: float | None = None
        self.interval = interval
        self.lock = threading.Lock()
        self.cooldown_until = 0.0
        self.deadline = float("inf")

    def _pace(self) -> None:
        with self.lock:
            require(self.clock() < self.deadline, "Collection deadline reached; previous snapshot retained.")
            target = max(self.cooldown_until, (self.last_request_at + self.interval) if self.last_request_at is not None else 0)
            wait = target - self.clock()
            if wait > 0:
                self.sleep(wait)
            self.last_request_at = self.clock()

    def _retry_wait(self, retry_after: str | None, attempt: int) -> float:
        wait = 10.0 * 2**attempt
        if retry_after:
            try:
                server_wait = float(retry_after)
            except ValueError:
                try:
                    server_wait = parsedate_to_datetime(retry_after).timestamp() - self.wall_clock()
                except (ValueError, TypeError, OverflowError):
                    server_wait = 0
            require(math.isfinite(server_wait), "API returned an invalid Retry-After value.")
            wait = max(wait, server_wait)
        require(wait <= MAX_RETRY_WAIT_SECONDS,
                "API requested a long cooldown; stopping this run instead of retrying early.")
        return wait

    def request_json(self, url: str, *, method: str = "GET", data: bytes | None = None,
                     headers: dict[str, str] | None = None, label: str = "Kyara", attempts: int = 3,
                     allow_missing: bool = False) -> Any:
        request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        request_headers.update(headers or {})
        for attempt in range(attempts):
            self._pace()
            request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
            try:
                with self.opener.open(request, timeout=30) as response:
                    require(200 <= response.status < 300, f"{label} returned a non-success status.")
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
                    require(len(raw) <= MAX_RESPONSE_BYTES, f"{label} response exceeded the size limit.")
                    return decode_json(raw)
            except urllib.error.HTTPError as exc:
                status = exc.code
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                exc.close()
                if status == 404 and allow_missing and method == "GET":
                    return None
                if status in (401, 403):
                    raise UpdateError(f"{label} denied access (HTTP {status}); no retry was made.") from None
                retryable = status == 429 or 500 <= status <= 599
                if not retryable or attempt + 1 == attempts:
                    raise UpdateError(f"{label} request failed (HTTP {status}); snapshot was not replaced.") from None
                wait = self._retry_wait(retry_after, attempt)
                if status == 429:
                    with self.lock:
                        self.cooldown_until = max(self.cooldown_until, self.clock() + wait)
                        self.interval = max(self.interval, 1.0)
                self.sleep(wait)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt + 1 == attempts:
                    raise UpdateError(f"{label} network request failed; snapshot was not replaced.") from None
                self.sleep(self._retry_wait(None, attempt))
        raise UpdateError(f"{label} request did not complete.")

    def get_kyara(self, path: str) -> Any:
        return self.request_json(KYARA_BASE + path)


def collect_snapshot(client: JsonClient, now: Callable[[], str] = utc_now, *, top_count: int | None = None,
                     previous: dict[str, Any] | None = None) -> dict[str, Any]:
    started = now()
    catalog = parse_catalog(client.get_kyara("/api/characters"))
    full_pools = {pool_id: client.get_kyara(f"/api/packs/{pool_id}/characters") for pool_id in POOL_NAMES}
    pools = [parse_pool(full_pools[pool_id], pool_id, catalog) for pool_id in POOL_NAMES]
    # Keep the original comparison pools Mythical-only. Full memberships are display metadata.
    booster_ids = {pool_id: set(values) for pool_id, values in full_pools.items()}
    catalog_updated = now()
    ids = sorted({card_id for pool in pools for card_id in pool["cardIds"]})
    ranked_ids = set()
    if top_count is not None:
        require(type(top_count) is int and 1 <= top_count <= 1000 and len(catalog) >= top_count, "Invalid top-card count.")
        ranked = sorted(catalog.values(), key=lambda c: c.get("rank", MAX_SAFE_INTEGER))[:top_count]
        require([c.get("rank") for c in ranked] == list(range(top_count)), "Catalog wiki ranks are invalid.")
        ranked_ids = {c["id"] for c in ranked}
        ids = sorted(set(ids) | ranked_ids)
    previous_cards = {c["id"]: c for c in (previous or {}).get("cards", [])}
    stopped = threading.Event()
    failures = []
    def collect_card(card_id):
        require(not stopped.is_set(), "Collection stopped after API failures.")
        entry = catalog[card_id]
        try:
            payload = client.get_kyara(f"/api/market/prices/{card_id}")
        except UpdateError as exc:
            # Isolated transport failures may carry forward a visibly stale value.
            if top_count is None or "denied access" in str(exc) or "deadline" in str(exc):
                stopped.set()
                raise
            failures.append(card_id)
            if len(failures) > max(1, len(ids) // 100):
                stopped.set()
                raise UpdateError("Too many price requests failed; previous snapshot retained.") from None
            old = previous_cards.get(card_id, {})
            price = {key: old.get(key) for key in PRICE_FIELDS}
            observed = old.get("priceCollectedAt", (previous or {}).get("collectedAt"))
            stale = True
        else:
            # Schema failures are fatal, not disguised as missing prices.
            try:
                price = parse_price(payload, card_id)
            except UpdateError:
                stopped.set()
                raise
            observed, stale = now(), False
        card = {"id": card_id, "name": nonempty_string(entry.get("name"), "Catalog name"),
                "rarity": entry["rarity"], "series": entry.get("series") or "", **price,
                "sourceUrl": f"{KYARA_BASE}/wiki/{card_id}"}
        if top_count is not None:
            card.update(rank=entry["rank"] + 1, inTop=card_id in ranked_ids,
                        priceCollectedAt=observed, stale=stale,
                        boosters=[pool_id for pool_id in POOL_NAMES if card_id in booster_ids[pool_id]])
        return card
    cards = []
    if top_count is not None and hasattr(client, "lock"):
        with ThreadPoolExecutor(max_workers=2) as executor:
            for index, card in enumerate(executor.map(collect_card, ids), 1):
                cards.append(card)
                if index % 100 == 0:
                    print(f"Collected {index}/{len(ids)} cards.", flush=True)
    else:
        cards = [collect_card(card_id) for card_id in ids]
    snapshot = {"schemaVersion": 1, "source": "kyara-public-api", "collectionStartedAt": started,
                "catalogUpdatedAt": catalog_updated, "collectedAt": now(), "currency": "chakra",
                "pools": pools, "cards": cards}
    if top_count is not None:
        snapshot.update(selection="wiki-top", topCount=top_count, failedCards=len(failures))
    validate_snapshot(snapshot)
    return snapshot


def upload_credentials(environ: Any) -> dict[str, str]:
    names = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_KV_NAMESPACE_ID")
    values = {name: str(environ.get(name, "")).strip() for name in names}
    missing = [name for name, value in values.items() if not value]
    require(not missing, "Missing upload configuration: " + ", ".join(missing) + ".")
    for name in names[1:]:
        require(bool(re.fullmatch(r"[0-9a-fA-F]{32}", values[name])), f"{name} must be a 32-character hexadecimal ID.")
    require(not any(c.isspace() for c in values["CLOUDFLARE_API_TOKEN"]), "CLOUDFLARE_API_TOKEN contains whitespace.")
    return values


def kv_url(credentials: dict[str, str], key: str) -> str:
    account = credentials["CLOUDFLARE_ACCOUNT_ID"]
    namespace = credentials["CLOUDFLARE_KV_NAMESPACE_ID"]
    return f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}/values/{key}"


def upload_snapshot(client: JsonClient, encoded: bytes, credentials: dict[str, str], key: str = "latest") -> None:
    url = kv_url(credentials, key)
    # One upload attempt: a failed/ambiguous PUT is left for the next scheduled
    # run, avoiding repeated writes against the free KV allowance.
    result = client.request_json(url, method="PUT", data=encoded,
                                 headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_API_TOKEN"],
                                          "Content-Type": "application/json"},
                                 label="Cloudflare", attempts=1)
    require(isinstance(result, dict) and result.get("success") is True,
            "Cloudflare did not confirm a successful KV write; local snapshot was not replaced.")


def validate_history(history: Any, bucket: int) -> None:
    require(isinstance(history, dict) and history.get("schemaVersion") == 1
            and history.get("bucket") == bucket and history.get("bucketCount") == HISTORY_BUCKETS,
            "Stored history has an unsupported format; refusing to overwrite it.")
    stamp = int(parse_timestamp(history.get("updatedAt"), "History updatedAt").timestamp())
    times = history.get("timestamps")
    require(isinstance(times, list) and bool(times), "History timestamps are missing.")
    require(all(type(t) is int and 0 < t <= MAX_SAFE_INTEGER for t in times)
            and all(a < b for a, b in zip(times, times[1:])) and times[-1] == stamp,
            "History timestamps must be ordered and unique.")
    cards = history.get("cards")
    require(isinstance(cards, dict), "History cards must be an object.")
    for key, card in cards.items():
        require(isinstance(key, str) and bool(re.fullmatch(r"[1-9][0-9]*", key))
                and int(key) <= MAX_SAFE_INTEGER and int(key) % HISTORY_BUCKETS == bucket,
                "History contains a card in the wrong bucket.")
        require(isinstance(card, dict), "History contains an invalid card.")
        nonempty_string(card.get("name"), "History card name")
        require(isinstance(card.get("series"), str), "History series must be text.")
        first, last = card.get("firstSeenAt"), card.get("lastSeenAt")
        require(type(first) is int and type(last) is int and 0 < first <= last <= stamp,
                "History card timestamps are invalid.")
        for field in ("median7d", "median30d"):
            values = card.get(field)
            require(isinstance(values, list) and len(values) == len(times), "History prices and times are misaligned.")
            for value in values:
                number_or_null(value, "History price")


def encode_runs(values):
    return [[i, value] for i, value in enumerate(values) if i == 0 or value != values[i - 1]]


def expand_history(history, bucket):
    """Read legacy dense history and the compact format without inventing samples."""
    if history is None or history.get("schemaVersion") == 1:
        return history
    require(history.get("schemaVersion") == 2 and isinstance(history.get("cards"), dict)
            and isinstance(history.get("timestamps"), list), "Unsupported compact history.")
    result = {**history, "schemaVersion": 1, "cards": {}}
    length = len(history["timestamps"])
    for key, raw in history["cards"].items():
        require(isinstance(raw, str), "Compact history card must be encoded text.")
        card = decode_json(raw.encode("utf-8"))
        for field in ("median7d", "median30d"):
            runs = card.get(field)
            require(isinstance(runs, list) and runs and isinstance(runs[0], list)
                    and runs[0][0] == 0, "Invalid history runs.")
            values = []
            for i, pair in enumerate(runs):
                require(isinstance(pair, list) and len(pair) == 2 and type(pair[0]) is int
                        and 0 <= pair[0] < length and pair[0] == len(values), "Invalid history run index.")
                number_or_null(pair[1], "History run price")
                end = runs[i + 1][0] if i + 1 < len(runs) else length
                require(type(end) is int and pair[0] < end <= length, "Invalid history run end.")
                values.extend([pair[1]] * (end - pair[0]))
            card[field] = values
        result["cards"][key] = card
    validate_history(result, bucket)
    return result


def compact_history(history):
    cards = {}
    for key, before in history["cards"].items():
        card = {**before, **{field: encode_runs(before[field]) for field in ("median7d", "median30d")}}
        cards[key] = json.dumps(card, ensure_ascii=False, separators=(",", ":"))
    return {**history, "schemaVersion": 2, "cards": cards}


def snapshot_changes(history, snapshot):
    stamp = int(parse_timestamp(snapshot["collectedAt"], "collectedAt").timestamp())
    for card in snapshot["cards"]:
        saved = history["cards"].get(str(card["id"]))
        if not saved:
            continue
        indices = [i for i, t in enumerate(history["timestamps"])
                   if stamp - 86400 <= t <= stamp and saved["firstSeenAt"] <= t <= saved["lastSeenAt"]]
        card["change24h"] = {}
        for field in ("median7d", "median30d"):
            first = saved[field][indices[0]] if indices else None
            last = saved[field][indices[-1]] if indices else None
            card["change24h"][field] = ((last - first) / first * 100
                if not card.get("stale") and len(indices) >= 2 and first is not None and first > 0 and last is not None else None)


def append_history(previous: Any, snapshot: dict[str, Any], bucket: int) -> dict[str, Any]:
    """One shared timeline per bucket keeps 30 days compact, without losing any samples."""
    stamp = int(parse_timestamp(snapshot["collectedAt"], "collectedAt").timestamp())
    cutoff = stamp - HISTORY_SECONDS
    if previous is not None:
        validate_history(previous, bucket)
        require(previous["timestamps"][-1] <= stamp, "New collection is older than stored history; refusing to overwrite it.")
    old = previous or {"timestamps": [], "cards": {}}
    # Replaying the same collection replaces that timestamp instead of duplicating it.
    indices = [i for i, t in enumerate(old["timestamps"]) if cutoff <= t < stamp]
    times = [old["timestamps"][i] for i in indices] + [stamp]
    current = {str(c["id"]): c for c in snapshot["cards"] if c["id"] % HISTORY_BUCKETS == bucket and not c.get("stale")}
    cards = {}
    for key in sorted(set(old["cards"]) | set(current), key=int):
        before, card = old["cards"].get(key), current.get(key)
        if card is None and before["lastSeenAt"] < cutoff:
            continue
        cards[key] = {
            "name": card["name"] if card else before["name"],
            "series": card["series"] if card else before["series"],
            "firstSeenAt": before["firstSeenAt"] if before else stamp,
            "lastSeenAt": stamp if card else before["lastSeenAt"],
        }
        for field in ("median7d", "median30d"):
            cards[key][field] = ([before[field][i] for i in indices] if before else [None] * len(indices)) + [card[field] if card else None]
    result = {"schemaVersion": 1, "bucket": bucket, "bucketCount": HISTORY_BUCKETS,
              "updatedAt": snapshot["collectedAt"], "timestamps": times, "cards": cards}
    validate_history(result, bucket)
    return result


def upload_history(client: JsonClient, snapshot: dict[str, Any], credentials: dict[str, str]) -> None:
    pending = []
    # Read/validate every bucket before writing anything. A failed read is never an empty history.
    for bucket in range(HISTORY_BUCKETS):
        key = f"history-v1-{bucket}"
        previous = client.request_json(kv_url(credentials, key),
                                       headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_API_TOKEN"]},
                                       label="Cloudflare history", allow_missing=True)
        previous = expand_history(previous, bucket)
        history = append_history(previous, snapshot, bucket)
        if snapshot.get("selection") == "wiki-top":
            snapshot_changes(history, snapshot)
            history = compact_history(history)
        encoded = (json.dumps(history, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        require(len(encoded) <= MAX_RESPONSE_BYTES, "History exceeds the supported size; refusing to truncate it.")
        pending.append((key, encoded))
    for key, encoded in pending:
        upload_snapshot(client, encoded, credentials, key)
    print(f"Saved 30-day price history ({HISTORY_BUCKETS} KV writes).", flush=True)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".kyara-", suffix=".tmp", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def run_update(output: Path, *, upload: bool = False, environ: Any = None,
               client: JsonClient | None = None, top_count: int | None = None) -> dict[str, Any]:
    # Fail configuration before contacting Kyara or modifying any file.
    credentials = upload_credentials(os.environ if environ is None else environ) if upload else None
    client = client if client is not None else JsonClient(interval=0.5 if top_count else 1.0, persistent=bool(top_count))
    previous = None
    if credentials is not None and top_count:
        previous = client.request_json(kv_url(credentials, "latest"),
            headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_API_TOKEN"]}, label="Cloudflare snapshot", allow_missing=True)
        if previous is not None:
            validate_snapshot(previous)
    if hasattr(client, "deadline"):
        client.deadline = client.clock() + 23 * 60
    snapshot = collect_snapshot(client, top_count=top_count, previous=previous)
    if credentials is not None:
        upload_history(client, snapshot, credentials)
    encoded = (json.dumps(snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    if credentials is not None:
        upload_snapshot(client, encoded, credentials)
    atomic_write(Path(output), encoded)
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=Path("data/latest.json"), help="Atomic local output (default: data/latest.json).")
    parser.add_argument("--upload", action="store_true", help="Append 30-day history and publish the complete snapshot to Cloudflare KV.")
    parser.add_argument("--top", type=int, default=None, help="Track the top N wiki-ranked cards (maximum 1000), plus comparison Mythicals.")
    parser.add_argument("--validate-only", type=Path, metavar="PATH", help="Validate an existing snapshot without network access or writes.")
    args = parser.parse_args(argv)
    if args.validate_only is not None and args.upload:
        parser.error("--validate-only cannot be combined with --upload")
    try:
        if args.validate_only is not None:
            validate_snapshot(decode_json(args.validate_only.read_bytes()))
            print("Snapshot validation passed.")
        else:
            snapshot = run_update(args.output, upload=args.upload, top_count=args.top)
            counts = ", ".join(f"{pool['name']}: {len(pool['cardIds'])}" for pool in snapshot["pools"])
            print(f"Saved {len(snapshot['cards'])} card prices ({counts}) at {snapshot['collectedAt']}.")
            if args.upload:
                print("Cloudflare KV accepted the history and complete snapshot (9 writes, including latest).")
        return 0
    except UpdateError as exc:
        print(f"Update stopped: {exc}", file=sys.stderr)
    except OSError:
        # Avoid printing arbitrary exception details from external libraries or
        # transport configuration that might contain secrets.
        print("Update stopped: file or network I/O failed. Check paths and connectivity.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
