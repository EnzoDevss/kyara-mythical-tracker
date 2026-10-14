# Kyara Mythical Tracker

A dashboard comparing the Mythical cards in Kyara's Waifus and Husbandos boosters. It shows each card's 7-day and 30-day market medians, sales counts, booster averages, and a recommendation based on the selected period. The price history page charts each card over 24 hours, 7 days, or 30 days.

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

The updater discovers the current cards from the catalog and both booster pools on each run. It fetches the Mythical prices, validates the result, and uploads a complete snapshot. A failed collection leaves the previously published snapshot in place.

The page checks the stored snapshot every five minutes while open. **Check for updates reloads that stored snapshot; it does not start another collection from Kyara.** To collect prices immediately, run the **Update prices** workflow manually on GitHub. The timestamp distinguishes the data's age from the time you opened the page.

`public/seed.json` is the bundled historical snapshot from October 14, 2026, for preview and initial setup. Its historical status remains visible until a successful collection replaces it.

## Price history

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
