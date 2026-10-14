#!/usr/bin/env python3
"""Collect a complete Kyara Mythical-price snapshot using only the standard library.

Run from the repository root:
    python scripts/update_prices.py --output data/latest.json
    python scripts/update_prices.py --output data/latest.json --upload
    python scripts/update_prices.py --validate-only data/latest.json

Upload uses CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_KV_NAMESPACE_ID, writing a single KV key named ``latest``.
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
USER_AGENT = "KyaraMythicalPriceTracker/1.0 (read-only public price comparison)"


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
        require(card.get("rarity") == "M", f"Snapshot card {card_id} is not Mythical.")
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
    require(referenced == card_ids, "Snapshot contains cards outside the selected pools.")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward credentials or follow a changed API location silently."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


class JsonClient:
    def __init__(self, *, opener: Any = None, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic,
                 wall_clock: Callable[[], float] = time.time) -> None:
        self.opener = opener if opener is not None else urllib.request.build_opener(NoRedirectHandler())
        self.sleep = sleep
        self.clock = clock
        self.wall_clock = wall_clock
        self.last_request_at: float | None = None

    def _pace(self) -> None:
        if self.last_request_at is not None:
            wait = REQUEST_INTERVAL_SECONDS - (self.clock() - self.last_request_at)
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
                     headers: dict[str, str] | None = None, label: str = "Kyara", attempts: int = 3) -> Any:
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
                if status in (401, 403):
                    raise UpdateError(f"{label} denied access (HTTP {status}); no retry was made.") from None
                retryable = status == 429 or 500 <= status <= 599
                if not retryable or attempt + 1 == attempts:
                    raise UpdateError(f"{label} request failed (HTTP {status}); snapshot was not replaced.") from None
                self.sleep(self._retry_wait(retry_after, attempt))
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt + 1 == attempts:
                    raise UpdateError(f"{label} network request failed; snapshot was not replaced.") from None
                self.sleep(self._retry_wait(None, attempt))
        raise UpdateError(f"{label} request did not complete.")

    def get_kyara(self, path: str) -> Any:
        return self.request_json(KYARA_BASE + path)


def collect_snapshot(client: JsonClient, now: Callable[[], str] = utc_now) -> dict[str, Any]:
    started = now()
    catalog = parse_catalog(client.get_kyara("/api/characters"))
    pools = [parse_pool(client.get_kyara(f"/api/packs/{pool_id}/characters"), pool_id, catalog)
             for pool_id in POOL_NAMES]
    catalog_updated = now()
    ids = sorted({card_id for pool in pools for card_id in pool["cardIds"]})
    cards = []
    for card_id in ids:
        price = parse_price(client.get_kyara(f"/api/market/prices/{card_id}"), card_id)
        entry = catalog[card_id]
        cards.append({"id": card_id, "name": entry["name"], "rarity": "M",
                      "series": entry["series"] or "", **price,
                      "sourceUrl": f"{KYARA_BASE}/wiki/{card_id}"})
    snapshot = {"schemaVersion": 1, "source": "kyara-public-api", "collectionStartedAt": started,
                "catalogUpdatedAt": catalog_updated, "collectedAt": now(), "currency": "chakra",
                "pools": pools, "cards": cards}
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


def upload_snapshot(client: JsonClient, encoded: bytes, credentials: dict[str, str]) -> None:
    account = credentials["CLOUDFLARE_ACCOUNT_ID"]
    namespace = credentials["CLOUDFLARE_KV_NAMESPACE_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}/values/latest"
    # One upload attempt: a failed/ambiguous PUT is left for the next scheduled
    # run, avoiding repeated writes against the free KV allowance.
    result = client.request_json(url, method="PUT", data=encoded,
                                 headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_API_TOKEN"],
                                          "Content-Type": "application/json"},
                                 label="Cloudflare", attempts=1)
    require(isinstance(result, dict) and result.get("success") is True,
            "Cloudflare did not confirm a successful KV write; local snapshot was not replaced.")


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
               client: JsonClient | None = None) -> dict[str, Any]:
    # Fail configuration before contacting Kyara or modifying any file.
    credentials = upload_credentials(os.environ if environ is None else environ) if upload else None
    client = client if client is not None else JsonClient()
    snapshot = collect_snapshot(client)
    encoded = (json.dumps(snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    if credentials is not None:
        upload_snapshot(client, encoded, credentials)
    atomic_write(Path(output), encoded)
    return snapshot


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=Path("data/latest.json"), help="Atomic local output (default: data/latest.json).")
    parser.add_argument("--upload", action="store_true", help="Publish the complete snapshot to Cloudflare KV key 'latest'.")
    parser.add_argument("--validate-only", type=Path, metavar="PATH", help="Validate an existing snapshot without network access or writes.")
    args = parser.parse_args(argv)
    if args.validate_only is not None and args.upload:
        parser.error("--validate-only cannot be combined with --upload")
    try:
        if args.validate_only is not None:
            validate_snapshot(decode_json(args.validate_only.read_bytes()))
            print("Snapshot validation passed.")
        else:
            snapshot = run_update(args.output, upload=args.upload)
            counts = ", ".join(f"{pool['name']}: {len(pool['cardIds'])}" for pool in snapshot["pools"])
            print(f"Saved {len(snapshot['cards'])} Mythical prices ({counts}) at {snapshot['collectedAt']}.")
            if args.upload:
                print("Cloudflare KV accepted the complete snapshot (key: latest).")
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
