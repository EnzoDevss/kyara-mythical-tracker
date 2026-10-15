# Price history verification

Checked on October 14, 2026, using Python 3.11.9, Node 24.19.0 and Wrangler 4.151.0.

- **39 Python tests passed:** collection, validation, request pacing, retries, upload errors, history accumulation, unchanged/zero/missing prices, 30-day retention, new/removed cards, duplicate timestamps, corrupt history, failed reads, and preservation of the previous latest snapshot after a partial history upload failure.
- **30 JavaScript tests passed:** comparison calculations and existing routes, plus history routing, all three time ranges and boundaries, one KV read per history request, read-only access, missing data, corruption, chart summaries, single points, constant prices, and gaps.
- **Deployment dry run passed:** Worker bundled with the existing PRICES namespace and nine static asset files. No dependency or additional Cloudflare service was introduced.
- **Local browser checks passed:** 24-hour, 7-day, and 30-day ranges; both median metrics; card search and selection; a first observation; empty history; keyboard point inspection; all 200 table links; and a 390-pixel mobile viewport with no horizontal page overflow. No browser warnings or errors were logged.
- **Thirty-day fixture check passed:** a separate local-only KV emulator contained simulated history for the full 200-card pool. The largest record was approximately 744 KiB for 33 cards, comfortably below KV's per-value limit. The 30-day chart rendered 1,440 observations. Synthetic fixtures were kept outside the project and were never uploaded to production.
- **Account target checked:** the existing tracker Worker and PRICES namespace were found in the same Cloudflare account. Deployment uses that account explicitly to avoid ambiguity with the user's second account.
- **Cloud deployment passed:** version `34797969-03f1-435b-b449-387c5a5f9b01` is live at [the history page](https://market.kyara-prices.workers.dev/history). Code commit `1ca4358` passed the GitHub Check project workflow.
- **Live collection passed:** [Update prices run 38610445733](https://github.com/EnzoDevss/kyara-mythical-tracker/actions/runs/38610445733) completed successfully. The public history API returned Emilia's first observation at **2026-10-14 17:57:14 UTC**, with both market medians at **2,757 chakra**. The existing `ENABLE_SCHEDULE` repository variable was verified as `true`. Accumulation across multiple updates is covered by the persistence tests; the first production run starts the archive.

The original comparison was also checked against a complete live collection earlier on October 14: 77 Waifu Mythicals, 123 Husbando Mythicals, and 200 unique cards. The bundled seed remains that feature's explicitly labeled historical starter data; it is not a price-history archive.

History began with that first successful run of the updated collector. Future successful scheduled or manual collections append observations. GitHub controls actual schedule timing; the requested cadence is every 30 minutes, not an exact-time guarantee.
