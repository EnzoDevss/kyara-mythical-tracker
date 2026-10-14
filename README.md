# Kyara Mythical Tracker

A dashboard comparing the Mythical cards in Kyara's Waifus and Husbandos boosters. It shows each card's 7-day and 30-day market medians, sales counts, booster averages, and a recommendation based on the selected period.

**Start with [SETUP.md](SETUP.md)** to deploy it to your own Cloudflare account and connect the free updater. This package is ready for setup; it has not been deployed to your account.

## How it works

```text
Kyara public JSON endpoints
          |
          | Python collector on GitHub Actions (~every 30 minutes)
          v
Cloudflare KV: one complete snapshot, key "latest"
          |
          | Cloudflare Worker: GET /api/prices
          v
Dashboard on your free *.workers.dev address
```

The updater discovers the current cards from the catalog and both booster pools on each run. It fetches the Mythical prices, validates the result, and uploads a complete snapshot. A failed collection leaves the previously published snapshot in place.

The page checks the stored snapshot every five minutes while open. **Check for updates reloads that stored snapshot; it does not start another collection from Kyara.** To collect prices immediately, run the **Update prices** workflow manually on GitHub. The timestamp distinguishes the data's age from the time you opened the page.

`public/seed.json` is the bundled historical snapshot from October 14, 2026, for preview and initial setup. Its historical status remains visible until a successful collection replaces it.

## Comparison method

For each booster and selected period, add the individual cards' market medians and divide by the number of cards with a median. Missing medians remain missing; they are not treated as zero. The dashboard displays coverage so an incomplete price set cannot be mistaken for a complete pool comparison. The average is an equal-card-weight comparison, not a volume-weighted market price.

The recommendation covers Mythicals only. It assumes equal chances among Mythicals within each booster and comparable overall Mythical drop rates; those weights are not verified by this tracker. It excludes other rarities, fees, and booster costs. A historical median is not a guaranteed sale price.

## Cost and timing

Use the **Cloudflare Workers Free** plan, the provided `workers.dev` hostname, and a **public GitHub repository with the standard `ubuntu-latest` runner**. No paid domain, database, browser service, or always-on computer is needed. Standard GitHub runner usage is free in public repositories; the workflows do not create Actions artifacts or caches. [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

At 48 successful updates per day, the updater writes 48 KV values, below the free 1,000 writes/day allowance. The API's Worker requests and KV reads are each subject to their free 100,000/day quotas, shared with your other account usage. Static assets are free. This is intended for a personal dashboard, not unlimited public API traffic. [KV limits and pricing](https://developers.cloudflare.com/kv/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

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
| `src/worker.mjs` | Serves the latest KV snapshot at `/api/prices` |
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
