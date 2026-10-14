# Price history verification

Checked on October 14, 2026, using Python 3.11.9, Node 24.19.0 and Wrangler 4.151.0.

- **39 Python tests passed:** collection, validation, request pacing, retries, upload errors, history accumulation, unchanged/zero/missing prices, 30-day retention, new/removed cards, duplicate timestamps, corrupt history, failed reads, and preservation of the previous latest snapshot after a partial history upload failure.
- **30 JavaScript tests passed:** comparison calculations and existing routes, plus history routing, all three time ranges and boundaries, one KV read per history request, read-only access, missing data, corruption, chart summaries, single points, constant prices, and gaps.
- **Deployment dry run passed:** Worker bundled with the existing PRICES namespace and nine static asset files. No dependency or additional Cloudflare service was introduced.
- **Local browser checks passed:** 24-hour, 7-day, and 30-day ranges; both median metrics; card search and selection; a first observation; empty history; keyboard point inspection; all 200 table links; and a 390-pixel mobile viewport with no horizontal page overflow. No browser warnings or errors were logged.
- **Thirty-day fixture check passed:** a separate local-only KV emulator contained simulated history for the full 200-card pool. The largest record was approximately 744 KiB for 33 cards, comfortably below KV's per-value limit. The 30-day chart rendered 1,440 observations. Synthetic fixtures were kept outside the project and were never uploaded to production.
- **Account target checked:** the existing tracker Worker and PRICES namespace were found in the same Cloudflare account. Deployment uses that account explicitly to avoid ambiguity with the user's second account.

The original comparison was also checked against a complete live collection earlier on October 14: 77 Waifu Mythicals, 123 Husbando Mythicals, and 200 unique cards. The bundled seed remains that feature's explicitly labeled historical starter data; it is not a price-history archive.

History begins with the first successful run of the updated collector. Verify cloud persistence by inspecting two successful updated runs and the live `/api/history` observations. GitHub controls actual schedule timing; the requested cadence is every 30 minutes, not an exact-time guarantee.
