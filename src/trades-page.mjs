// Private page: served only after server-side authentication.
export default `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d0c11">
  <title>Trades · Kyara Market</title>
  <meta name="description" content="Find public Mythical, Legendary and all-rarity Fairy Tail trade offers, searched from highest market median to lowest.">
  <link rel="stylesheet" href="/styles.css?v=columns-3">
  <link rel="stylesheet" href="/history.css?v=hourly-1">
  <link rel="stylesheet" href="/trades.css?v=fairy-tail-2">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/png" href="/icons/app-192.png">
  <link rel="stylesheet" href="/install.css?v=banner-1">
  <script src="/install.js?v=banner-1" defer></script>
  <script type="module" src="/trades.js?v=fairy-tail-2"></script>
  <link rel="stylesheet" href="/auth.css?v=1">
</head>
<body>
  <a class="skip-link" href="#trade-results">Skip to trade offers</a>
  <div class="shell">
    <header class="masthead">
      <a class="brand" href="/" aria-label="Kyara Market Tracker home"><span class="brand-mark" aria-hidden="true">◆</span><span>KYARA<span class="brand-sub">MARKET TRACKER</span></span></a>
      <nav class="page-nav" aria-label="Main navigation"><a href="/">Market</a><a href="/history">Price history</a><a href="/trades" aria-current="page">Trades</a></nav>
    </header>
    <main>
      <form class="trade-lock" method="post" action="/api/auth/logout"><button class="button button-outline" type="submit">Lock Trades</button></form>
      <section class="trade-intro">
        <p class="eyebrow" id="trade-eyebrow">THE MYTHICAL TRADE BOARD</p>
        <h1>Find your<br><span>next exchange.</span></h1>
        <p class="hero-copy" id="trade-intro-copy">Search every Mythical, from highest 7-day median to lowest. Offers appear as each card is checked. Your refresh updates only your list.</p>
      </section>
      <div class="trade-tabs" role="tablist" aria-label="Trade category"><button type="button" role="tab" id="tab-mythical" aria-selected="true" aria-controls="trade-panel">Mythicals</button><button type="button" role="tab" id="tab-legendary" aria-selected="false" aria-controls="trade-panel" tabindex="-1">Legendaries</button><button type="button" role="tab" id="tab-fairy-tail" aria-selected="false" aria-controls="trade-panel" tabindex="-1">Fairy Tail</button></div>
      <div id="trade-panel" role="tabpanel" aria-labelledby="tab-mythical">
      <section class="scan-panel" aria-label="Search trade offers">
        <div class="scan-toolbar"><div><span class="status-pill pending" id="scan-badge">Ready to search</span><p id="price-note">Loading card catalog and saved prices…</p></div><div class="scan-actions"><button class="button button-outline" id="scan-stop" hidden>Stop scan</button><button class="button scan-button" id="scan-start" disabled>Refresh trades ↻</button></div></div>
        <progress id="scan-progress" value="0" max="203" aria-label="Mythicals searched"></progress>
        <p id="scan-status" role="status" aria-live="polite">Preparing the search list…</p>
        <p class="scan-explanation">Results may be reused for up to 15 seconds. Traffic is shared at up to 10 searches/second, with automatic pauses when needed. Offers can be taken or withdrawn after checking. Complete trades on Kyara.</p>
      </section>
      <section class="trade-list" id="trade-results" aria-labelledby="results-title">
        <div class="section-heading"><div><p class="eyebrow">AVAILABLE WHEN CHECKED</p><h2 id="results-title">Mythical offers</h2></div><p class="trade-count" id="trade-count">0 offers</p></div>
        <div class="trade-filters"><div><label class="trade-search-label" for="trade-search">Filter loaded offers</label>
        <input type="search" id="trade-search" placeholder="Search offered card, requested card, series, or player…" autocomplete="off"></div>
        <div id="trade-rarity-field" hidden><label class="trade-search-label" for="trade-rarity">Offered rarity</label><select id="trade-rarity"><option value="">All rarities</option><option value="M">Mythical</option><option value="L">Legendary</option><option value="E">Epic</option><option value="R">Rare</option><option value="U">Uncommon</option><option value="C">Common</option></select></div>
        <div><label class="trade-search-label" for="trade-sort">Sort loaded offers</label><select id="trade-sort"><option value="median-desc">Offered median: high to low</option><option value="median-asc">Offered median: low to high</option><option value="gain-desc">Potential gain: highest first</option><option value="percent-desc">Percentage gain: highest first</option></select></div></div>
        <div class="trade-checkboxes"><label class="trade-legendary-filter" id="trade-request-filter"><input type="checkbox" id="trade-legendary"> <span id="trade-request-filter-label">Requests at least one Legendary</span></label><label class="trade-legendary-filter"><input type="checkbox" id="trade-owned"> <span>Trades I can accept</span></label></div>
        <details class="owned-card-picker" id="owned-card-picker">
          <summary><span>Card I own</span><span id="owned-card-count">0 selected</span></summary>
          <div class="owned-card-controls"><label class="trade-search-label" for="owned-card-search">Search the wiki top 1,000</label><div class="owned-card-searchbox"><span id="owned-card-chips"></span><input type="search" id="owned-card-search" placeholder="Search character, series, or wiki rank…" autocomplete="off"></div><div class="owned-card-toolbar"><span id="owned-card-results" role="status">Loading the wiki top 1,000…</span><button class="button button-outline" id="owned-card-clear" type="button" disabled>Clear selection</button></div></div>
          <div id="owned-card-list" class="owned-card-list" role="group" aria-label="Cards you own, in wiki order"></div><p id="owned-card-empty" class="owned-card-empty" hidden>No cards match your search.</p>
          <p id="owned-card-note" class="trade-note">Saved only in this browser. Select the cards you own.</p>
        </details>
        <p class="trade-note" id="trade-epic-note" hidden>Cards outside the tracked top 1,000 also qualify for this filter and get a purple outline. Their actual rarity is unchanged, and missing prices remain unavailable.</p>
        <p class="trade-note">Each offer accepts <strong>one</strong> requested card. Potential gain = offered median minus the cheapest requested median; percentage gain uses that requested median as its base. Missing or stale prices prevent a reliable comparison and sort last. ◆ prices are saved 7-day medians, not guaranteed sale values. Kyara may not highlight older offers outside its own displayed list.</p>
        <div class="trade-empty" id="trade-empty">Press Refresh trades to search. Nothing runs automatically.</div>
        <div id="trade-offers"></div>
        <button class="button button-outline load-more" id="trade-more" hidden>Show more offers</button>
        <div id="scan-warnings" class="scan-warnings" role="status"></div>
      </section>
      </div>
    </main>
    <footer><p>An independent community tracker. Not affiliated with Kyara.</p><p>TRADE BOARD ◆</p></footer>
  </div>
</body>
</html>
`;
