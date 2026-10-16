# Kyara Market — Older Trade Helper

Experimental local extension for desktop Chrome or Edge. No store publication or developer account required.

## Install

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (the folder containing `manifest.json`).
4. Refresh the tracker's Trades page and click **Open Kyara** on an offer. If a Kyara tab was already open, reload it.
5. Look for the helper message at the top. It reports whether the selected offer was returned.

The extension must be installed in the browser where you open Kyara. It does not run inside the tracker's installed web app or a different browser. It can be disabled or removed from the browser's extensions page.

## What it does

Tracker links include `trackerCard=<character ID>`. Only on `https://kyara.games/marche?onglet=offres` with that marker, the helper replaces Kyara's normal read-only `GET /api/trades/offers` with `GET /api/trades/offers?characterId=<ID>`. Kyara's own interface renders the response and uses its existing `offre=<offer ID>` highlighting.

No extra polling or scanning. No automatic acceptance, cancellation, posting, messages, login, or account changes. It does not read browser storage, copy account tokens, or transmit data to the tracker or another service. Existing request options remain unchanged.

It has no background worker, external connections, or permissions beyond a content script matching Kyara's market page. No authentication or write requests are modified. Normal Kyara links without the marker behave normally.

## Limits and validation

Public API access and current source inspection confirm that older active offers can be retrieved by character ID and that Kyara already renders this offer format. Automated tests cover request rewriting, untouched mutation/authentication requests, response preservation, and marker validation. Actual loading of this extension and rendering in a signed-in desktop browser still require a manual check. No trade has been executed during development.

Kyara can change its client or API; a character response may still be capped. An ended or missing offer cannot be restored. This extension is not an official Kyara feature, and no claim of approval by Kyara is made.
