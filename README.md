# Kyara Market Tracker

A dashboard tracking the top 1,000 cards by Kyara wiki rank across rarities, alongside the original Waifu/Husbando Mythical comparison. It shows each card's 7-day and 30-day market medians, sales counts, booster averages, and a recommendation based on the selected period. The price history page charts each card over 24 hours, 7 days, or 30 days.

**Start with [SETUP.md](SETUP.md)** to deploy a new copy to your own Cloudflare account and connect the free updater. Existing installations use the same KV namespace, secrets, and schedule for history.

## How it works

```text
Kyara public JSON endpoints
          |
          | Python collector on GitHub Actions (~every 30 minutes)
          v
Cloudflare KV: "latest" + 8 compact history records
          |
          | Cloudflare Worker: GET /api/prices and /api/history
          v
Comparison and price history on your free *.workers.dev address
```

The updater discovers the current cards from the catalog and both booster pools on each run. With `--top 1000`, it selects wiki ranks 1–1000 and includes any additional Mythicals needed for complete booster coverage. It fetches both medians in one price request per character, with two reusable HTTPS connections and a shared two-per-second limit. Throttling honors Retry-After and slows the shared pace. Up to 1% isolated failures retain visibly stale prices; stale values are excluded from comparison averages and never recorded as fresh history. Widespread failures retain the previous snapshot. The workflow has a 25-minute timeout and the collector a 23-minute deadline.

The page checks the stored snapshot every five minutes while open. **Check for updates reloads that stored snapshot; it does not start another collection from Kyara.** To collect prices immediately, run the **Update prices** workflow manually on GitHub. The timestamp distinguishes the data's age from the time you opened the page.

`public/seed.json` is the bundled historical snapshot from October 14, 2026, for preview and initial setup. Its historical status remains visible until a successful collection replaces it.

## Price history

The market table includes wiki rank, rarity, both medians, sales and sortable 24h percentage changes. Search, rarity/booster filters and sorting run locally. Pagination renders 50 rows; CSV exports all matching cards across pages. Booster labels use the full Waifu/Husbando rosters across rarities; Both means listed in both or neither. The comparison panels continue to use only the Mythical cards in each booster. These labels reuse the existing roster requests and snapshot write. Top-1,000 snapshots contain precomputed percentages; the dashboard does not read history buckets to calculate them. Legacy snapshots still use the compatible changes endpoint.

Open **Price history** in the navigation, or follow a card's **Price history** link in the comparison table. Search by card or series, select a card, then choose **24 hours**, **7 days**, or **30 days**. The separate **Price tracked** control selects the 7-day or 30-day market median to plot. Chart windows do not recalculate those medians. Hover, tap, or use the arrow keys to inspect a point; the observations table lists exact values.

Every complete collection with `--upload` saves both market medians, even if unchanged. Manual runs add observations too. The collector retains a rolling 30 days and removes older points during subsequent updates. A brand-new installation starts empty: neither the seed nor previous snapshot-only updates contain recoverable price history. One observation displays as a dot until more arrive. Missing medians stay missing, and gaps over 90 minutes break the line.

History uses eight KV records (`history-v1-0` through `history-v1-7`), with each card assigned by its ID modulo eight. Each record shares timestamps across its cards, keeping storage and write counts low. Before writing, the collector reads and validates all eight records. Network, authorization, and malformed-data failures never count as empty history. Only a missing-key 404 starts a new record. It uploads history before publishing `latest`; if an upload fails midway, some history records may contain the new observation while the comparison keeps its previous complete snapshot. The next successful run preserves the saved observations. GitHub's concurrency group prevents overlapping collectors.

The read-only endpoint `/api/history?card=88572&range=24h` accepts `24h`, `7d`, and `30d`. The page checks for saved updates every five minutes while visible. No new database, Cloudflare permission, or GitHub secret is needed: the existing Workers KV Storage Edit token can also read the history records.

## Comparison method

For each booster and selected period, add the individual cards' market medians and divide by the number of cards with a median. Missing medians remain missing; they are not treated as zero. The dashboard displays coverage so an incomplete price set cannot be mistaken for a complete pool comparison. The average is an equal-card-weight comparison, not a volume-weighted market price.

The recommendation covers Mythicals only. It assumes equal chances among Mythicals within each booster and comparable overall Mythical drop rates; those weights are not verified by this tracker. It excludes other rarities, fees, and booster costs. A historical median is not a guaranteed sale price.

## Cost and timing

Use the **Cloudflare Workers Free** plan, the provided `workers.dev` hostname, and a **public GitHub repository with the standard `ubuntu-latest` runner**. No paid domain, database, browser service, or always-on computer is needed. Standard GitHub runner usage is free in public repositories; the workflows do not create Actions artifacts or caches. [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Each successful update reads eight history records and writes nine KV values (eight history records plus `latest`). At 48 updates per day, that is **432 writes/day**, below the free 1,000 writes/day allowance, plus 384 collector reads. Manual updates add nine writes each. The API's Worker requests and KV reads are each subject to their free 100,000/day quotas, shared with your other account usage. Static assets are free. This is intended for a personal dashboard, not unlimited public API traffic. [KV limits and pricing](https://developers.cloudflare.com/kv/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

GitHub schedules can run late or miss a run. Public-repository schedules can be disabled after 60 days without repository activity. The page keeps the last successful data and flags old snapshots. [GitHub scheduling behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## Data source

The collector uses the site's publicly reachable, undocumented JSON endpoints. No Kyara account, cookie, or API key is used:

- [Character catalog](https://kyara.games/api/characters)
- [Waifus pool](https://kyara.games/api/packs/waifu/characters)
- [Husbandos pool](https://kyara.games/api/packs/husbando/characters)
- [Market price example](https://kyara.games/api/market/prices/88572)

With 200 unique Mythicals, each run needs about 203 source requests before retries; a half-hour schedule is about 9,744 requests/day. Requests are paced, and failures or changed response formats do not replace the published data. These endpoints may change or be withdrawn. Kyara's [rules](https://kyara.games/regles) broadly prohibit bots/scripts and do not specifically explain read-only price trackers; public access does not establish permission for recurring collection.

## Project layout

| Path | Purpose |
| --- | --- |
| `public/` | Dashboard, styling, browser code, historical preview data |
| `src/worker.mjs`, `src/history.mjs` | Read-only snapshot and per-card history APIs |
| `public/history.html`, `public/history.js` | Card picker, range controls, charts, and observations table |
| `scripts/update_prices.py` | Standard-library Python collector and KV uploader |
| `tests/` | Collector, calculation, and Worker tests |
| `wrangler.jsonc` | Cloudflare Worker, assets, and KV binding configuration |
| `.github/workflows/update-prices.yml` | Manual and scheduled collection |
| `.github/workflows/check.yml` | Checks on pushes and pull requests |

Local checks, with Python and Node installed:

```powershell
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/*.test.mjs
```

Keep API tokens in GitHub Actions secrets. The web page and deployed Worker need no token because the Worker uses its KV binding. Only the scheduled upload job receives the Cloudflare upload credentials.

## Top-1,000 migration and storage

The workflow runs `python scripts/update_prices.py --top 1000 --output data/latest.json --upload` on the existing `13,43 * * * *` schedule. GitHub can delay scheduled jobs. Standard runners for this public repository use the existing free setup. No new cloud service, account, or secrets are required.

The table includes exactly the current wiki top 1,000 (rank 0 in the source becomes displayed #0001). Membership is refreshed every collection; stable character IDs preserve history when ranks change. Mythical pool comparison cards outside the top 1,000 can remain in the snapshot for complete comparisons without appearing in the ranked table.

The first successful top-card upload migrates the existing eight history keys in place. Schema 2 stores run-length encoded median arrays and one JSON string per card so chart reads only decode the selected card. The shared timestamp list retains every observation, including unchanged prices. Schema 1 is still readable. Cards leaving the tracked set keep their prior observations until the rolling 30-day cutoff removes them. New cards have no invented prior observations.

At 48 scheduled runs, the eight history keys plus latest still require 432 writes daily. Individual daily manual runs or failed/retried uploads add writes. A dashboard refresh reads one latest key, while a chart loads latest plus its single history bucket. All API endpoints remain read-only.

A local stress fixture for 1,000 cards and 1,441 observations (every half hour for 30 days inclusive), with both prices changing every time, occupied approximately 33 MB across eight history groups. This is a fixture measurement, not a promise about future catalog churn or actual storage. Large value sizes are checked before upload; history is never silently truncated.


## Trade offers

`/trades` is a manually refreshed, read-only viewer with separate Mythical and Legendary tabs. It discovers all current Mythicals and the current wiki top-1,000 Legendaries from the public catalog, and searches the selected rarity in descending saved 7-day median order, with stale/missing prices last. Each browser holds its own list and scan progress; opening a page or another visitor's refresh never starts a scan in your browser.

A single named SQLite-backed Durable Object coordinates the whole site. It starts at most ten offer searches per second, with at most three concurrent upstream requests, deduplicates in-flight searches and reuses successful per-card results for fifteen seconds. Throttling pauses all new searches and slows subsequent traffic; successful requests gradually restore pacing. Each streamed batch contains at most ten cards, below the free Worker's external subrequest limit. The pending queue is bounded. Stop cancels the browser's next batches; up to ten already submitted searches may still finish and enter the shared cache.

The trade search coordinator uses ephemeral memory only: no extra KV or database writes, no scheduled scanning, no trade mutations, and no Kyara credentials. One Mythical scan uses approximately 21 Worker/DO batch requests plus catalog/prices; searches served by cache skip Kyara. The catalog is shared for five minutes. Cloudflare Worker and Durable Object request/duration quotas still apply. The deployed SQLite namespace is required for the free-plan-compatible coordinator, but no SQLite queries are performed by trade searches.

Kyara's per-character response may itself be capped at 200 offers; the UI flags responses reaching that size. Offers may be withdrawn or taken after checking. Kyara's own UI may not focus an older offer absent from its current list, even with an offer link. All exchanges remain on Kyara. No claim of complete uncapped source coverage is made.


The Trades page has separate Mythical and Legendary tabs with independent local results, filters and sorting. Switching tabs stops an active scan and keeps collected results. Mythicals include all current Mythicals; Legendaries include only current wiki top-1,000 Legendaries. Both share the existing global request pacing and cache. The Mythical checkbox matches actual requested Legendaries. The Legendary checkbox matches requested Epics OR any requested card outside the tracked top 1,000; outside cards get an explicit label, not invented prices or rarity changes. Requested Mythicals, Legendaries and Epics always have red, gold and purple outlines respectively, independent of filters. In the Legendary tab, other requested cards outside the top 1,000 also retain their purple outline. Only a manual refresh searches the selected tab.

## Local card selection

The trade board's “Card I own” checklist uses the current tracked top 1,000 in wiki order, with character/series/rank search and multiple selections. Only card IDs are saved in this browser's localStorage (`kyara:owned-card-ids:v1`); they are never submitted to the server. Selections are shared between this browser's Mythical/Legendary tabs and survive reloads, including stable IDs that later leave the top 1,000. “Trades I can accept” keeps an offer when at least one requested card is selected and combines with the existing requested-rarity and text filters. It does not check Kyara availability or change price/gain calculations. No additional API requests or Kyara login are needed. Other visitors maintain their own browser selections; clearing site data removes them.

## Trades access

Market, Price history and their price/history APIs remain public. The Trades navigation link is always visible. The Worker serves a password form for `/trades` and `/trades.html` until a signed session is present, and rejects every unauthenticated `/api/trades/*` call. Trades HTML lives in `src/trades-page.mjs`, outside public assets, so asset URL aliases cannot expose it. API and Trades paths run through the Worker first; public static assets keep their normal fast serving path. Version preview URLs are disabled.

The password verifier (`TRADES_PASSWORD_HASH`, salted PBKDF2-SHA256) and independent random signing key (`TRADES_SESSION_SECRET`) are Cloudflare secrets. Nothing sensitive belongs in Git, public assets, query strings or browser storage. An eight-hour `__Host-` session cookie is Secure, HttpOnly and SameSite=Strict. Login and logout require same-origin POSTs. Changing either secret invalidates existing sessions. “Lock Trades” clears this browser's cookie; a previously copied session remains valid until expiry or secret rotation.

A separate `TRADES_LOGIN` Durable Object persists password attempt timestamps: five attempts per IP fingerprint per fifteen minutes, plus one hundred attempts globally per minute. It stores keyed fingerprints, not passwords or raw IP addresses. Limiter or secret outages fail closed. This small authentication storage is separate from the unchanged PRICES KV and ephemeral trade search cache. Users behind one public IP share the attempt allowance.

To provision a strong random password after deploying, set the correct Cloudflare account ID and run `node scripts/setup_trades_access.mjs "ABSOLUTE_PATH_OUTSIDE_PROJECT"`. The destination must be a new local file outside this checkout. The script generates a 192-bit password, saves it locally, and sends only its salted verifier plus a fresh signing secret to Wrangler over standard input. It never prints secrets. Keep the file private; do not commit it. To rotate access, repeat with a new destination file, which replaces both Cloudflare secrets and invalidates existing sessions. No shared password system prevents an authorized recipient from sharing their password or session; this gate protects this tracker, not Kyara's independently public API.
