# Verification before delivery

Checked locally on October 14, 2026, using Python 3.11.9, Node 24.19.0 and Wrangler 4.151.0.

- **28 Python tests passed:** discovery of new Mythicals, shared cards, malformed responses, missing/zero prices, request pacing, retries, access denial, upload errors, and preservation of the previous complete snapshot.
- **19 JavaScript tests passed:** comparison math, median windows, missing prices, CSV escaping, the bundled reference data, Worker routing, and storage failure handling.
- **Cloudflare deployment dry run passed:** Worker bundled successfully with static assets and the PRICES KV binding. No account deployment was made.
- **One complete live collection passed:** started at 16:07:17 UTC and completed at 16:10:40 UTC. Discovered 77 Waifu Mythicals and 123 Husbando Mythicals, with 200 unique card price records and complete 7-day price coverage. No Kyara login, cookie, or API key was used.
- **Local integration passed:** loaded that collection into Wrangler's local KV emulator and served it through `/api/prices`. The dashboard changed from its starter-data label to the fresh collection timestamp. The 7-day averages were 1,890.43 chakra for Waifus and 1,805.38 for Husbandos, a 4.71% lead for Waifus under equal card weighting.
- **Browser checks passed:** 7/30-day selection, character search, booster filter, price sorting, empty search results, refreshing, and CSV export. The export contained 200 rows and eight columns. No browser warning or error was logged during these checks.

The bundled seed remains the earlier, explicitly labeled starter snapshot. Live verification data was kept outside the project so it cannot be mistaken for an active updater.

Your Cloudflare account permissions, deployed URL, and GitHub runner access to Kyara must still be verified during setup. The first manual GitHub workflow run is the end-to-end cloud check. No schedule has been enabled and no recurring job has been started on your behalf.
