/**
 * The demo archive's story: hand-written, entirely fictional agent sessions
 * across three small projects (tidepool, ledgerline, glasshouse) and a few
 * one-off chores, August-September 2026. `scripts/demo-archive.ts` emits these
 * as real Claude Code and Codex on-disk transcripts under demo/sources/.
 *
 * Nothing here names a real person, machine, or account. The user home is
 * /Users/demo and every project is invented.
 */

export type Harness = "claude" | "codex";
/** How the session was opened: typed at a CLI, or launched by a program. */
export type Launch = "cli" | "subagent" | "sdk" | "exec" | "thread_spawn";

export type Event =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: "sh" | "read" | "edit" | "grep"; arg: string; detail?: string; out: string }
  /** Claude only: a Task call whose worker transcript is the session `child`. */
  | { kind: "task"; child: string; description: string; prompt: string; result: string }
  /** Codex only: spawn a worker thread (the child session names this one as parent). */
  | { kind: "spawn"; child: string; prompt: string; result: string }
  /** Claude only: the user types /compact; the harness writes a boundary and a hidden summary. */
  | { kind: "compact"; command: string; summary: string }
  | { kind: "gap"; minutes: number };

export interface SessionSpec {
  key: string;
  harness: Harness;
  launch: Launch;
  cwd: string;
  /** ISO start time (UTC). Workers omit it: they start when their parent spawns them. */
  start?: string;
  model: string;
  /** Claude /rename title or Codex session_index thread name. */
  title?: string;
  /** Parent session key for subagent / thread_spawn workers. */
  parent?: string;
  events: Event[];
}

const HOME = "/Users/demo";
export const PROJECTS = {
  tidepool: `${HOME}/code/tidepool`,
  ledgerline: `${HOME}/code/ledgerline`,
  glasshouse: `${HOME}/code/glasshouse`,
  dotfiles: `${HOME}/dotfiles`,
  photos: `${HOME}/Pictures/screens`,
} as const;

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-4-5-20251001";
export const CODEX = "gpt-5-codex";

const u = (text: string): Event => ({ kind: "user", text });
const a = (text: string): Event => ({ kind: "assistant", text });
const sh = (arg: string, out: string): Event => ({ kind: "tool", name: "sh", arg, out });
const read = (arg: string, out: string): Event => ({ kind: "tool", name: "read", arg, out });
const grep = (arg: string, out: string): Event => ({ kind: "tool", name: "grep", arg, out });
const edit = (arg: string, detail: string): Event => ({ kind: "tool", name: "edit", arg, detail, out: `Updated ${arg}` });
const gap = (minutes: number): Event => ({ kind: "gap", minutes });

/** The wall-of-text message the paragraph layer spaces out (ledgerline-catchup). */
export const WALL_OF_TEXT = "ok so here's where I'm at with ledgerline and I need you to help me not lose the thread. the OFX importer works for my credit union but the big bank CSV export has these weird memo fields that sometimes contain the payee and sometimes don't, so half my grocery spending lands in uncategorized. I tried writing a rule that matches on the amount pattern but that feels fragile and I'd rather match on the merchant id if we can recieve it from the file at all. separately the monthly report is really slow when I point it at three years of history, like four seconds, which seems wrong for a few thousand rows. I suspect we're re-parsing every file on each run instead of caching the parsed ledger somewhere. also I want budgets to roll over, so if I underspend on dining out in august the leftover should carry into september, but overspending should not silently eat next month either, it should show as a debt line. and the negative zero thing in the report is still there for empty categories which is embarassing when I screenshot it. last thing, I'd like a dry run flag on import so I can see what the rules would do before anything gets written. can you look at the importer first and tell me what the memo fields actually contain before we change anything?";

/** Paragraph starts the fixture layer places in WALL_OF_TEXT (matched against candidate units). */
export const WALL_BREAKS_AT = ["separately the monthly report", "also I want budgets", "and the negative zero thing", "can you look at the importer"];

export const SESSIONS: SessionSpec[] = [
  // ─── tidepool: a tide-chart PWA ──────────────────────────────────────────
  {
    key: "tidepool-offline", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-11T16:05:00Z", model: SONNET,
    events: [
      u("can you make the tidepool chart work offline? when I'm at the beach with no signal it just shows a spinner"),
      a("Let me look at how the chart fetches predictions and whether a service worker is registered."),
      grep("serviceWorker", "src/main.ts:14:  // TODO: register service worker"),
      read("src/api/predictions.ts", "export async function fetchPredictions(station: string, day: string) {\n  const res = await fetch(`/api/predictions?station=${station}&day=${day}`);\n  return res.json();\n}"),
      a("Nothing is cached today, so every chart render is a network round trip. I'll add a service worker with a stale-while-revalidate strategy for `/api/predictions` and precache the app shell. Predictions for the next 7 days get cached when you open a station, so the beach case works as long as you looked once at home."),
      edit("src/sw.ts", "new service worker: precache shell, SWR for /api/predictions"),
      edit("src/main.ts", "register /sw.js after load"),
      sh("npm run build && npx playwright test offline.spec.ts", "✓ offline.spec.ts:8:3 › chart renders from cache with network disabled (2.1s)\n1 passed"),
      a("Done. With the network disabled in the test the chart renders from cache. One caveat: the cache key includes the day, so after a week offline you'd see an empty chart rather than stale tides."),
      u("that's fine. can it show a little 'offline, cached 2 days ago' badge?"),
      edit("src/components/ChartHeader.tsx", "add CachedBadge reading the Date header of the cached response"),
      a("Added a badge that reads the cached response's `Date` header: \"offline · cached 2 days ago\". It only appears when the fetch fell back to cache."),
    ],
  },
  {
    key: "tidepool-picker-plan", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-13T15:20:00Z", model: OPUS,
    events: [
      u("I want to redesign the station picker. right now it's a 400-item dropdown. plan it first, don't write code yet"),
      a("I'll read the current picker and the station data before proposing anything."),
      read("src/components/StationPicker.tsx", "<select onChange={...}>{stations.map(s => <option>{s.name}</option>)}</select>"),
      read("data/stations.json", "[{\"id\":\"mry\",\"name\":\"Monterey\",\"lat\":36.605,\"lon\":-121.888,\"utcOffset\":-7}, ...412 more]"),
      a("Plan:\n1. Replace the dropdown with a search field plus a \"near me\" list sorted by distance (geolocation, falls back to last-used).\n2. Fuzzy match on name and region; show the next high tide inline in each result.\n3. Keep the last five stations as chips above the search.\n4. Extract station lookup into `src/stations/index.ts` so the chart and picker share it.\n\nOne thing I noticed: every station carries a fixed `utcOffset`. That will need a look later, but it's out of scope for the picker."),
      u("love it. go with that plan"),
    ],
  },
  {
    key: "tidepool-picker-build", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-13T15:41:00Z", model: OPUS,
    events: [
      u("Implement the following plan:\n\n# Station picker redesign\n1. Replace the dropdown with a search field plus a \"near me\" list sorted by distance.\n2. Fuzzy match on name and region; show the next high tide inline.\n3. Keep the last five stations as chips above the search.\n4. Extract station lookup into src/stations/index.ts."),
      a("Starting with step 4, since the picker and chart both need the shared lookup. I'll have a worker map every place that reads station fields first."),
      { kind: "task", child: "tidepool-picker-explore", description: "Find station field reads",
        prompt: "List every file and line in /Users/demo/code/tidepool/src that reads a field of a station object (id, name, lat, lon, utcOffset). Report as file:line with the field name. Do not edit anything.",
        result: "7 reads: ChartHeader.tsx:22 name, Chart.tsx:41 utcOffset, Chart.tsx:88 utcOffset, StationPicker.tsx:9 name, api/predictions.ts:3 id, geo.ts:12 lat, geo.ts:13 lon." },
      edit("src/stations/index.ts", "new: loadStations, byId, nearest(lat, lon, n), search(query)"),
      edit("src/components/StationPicker.tsx", "search field, near-me list, recent chips"),
      sh("npm test -- stations", "✓ stations/search.test.ts (6 tests)\n✓ stations/nearest.test.ts (3 tests)\nTest Files  2 passed"),
      a("The picker is in: search with fuzzy matching, a near-me list with the next high tide inline, and recent-station chips. `Chart.tsx` still reads `utcOffset` directly in two places. I left those alone as planned."),
      u("nice, the near me list is great on my phone"),
    ],
  },
  {
    key: "tidepool-picker-explore", harness: "claude", launch: "subagent", parent: "tidepool-picker-build",
    cwd: PROJECTS.tidepool, model: HAIKU,
    events: [
      u("List every file and line in /Users/demo/code/tidepool/src that reads a field of a station object (id, name, lat, lon, utcOffset). Report as file:line with the field name. Do not edit anything."),
      grep("station\\.(id|name|lat|lon|utcOffset)", "src/components/ChartHeader.tsx:22: station.name\nsrc/components/Chart.tsx:41: station.utcOffset\nsrc/components/Chart.tsx:88: station.utcOffset\nsrc/components/StationPicker.tsx:9: s.name\nsrc/api/predictions.ts:3: station.id\nsrc/geo.ts:12: station.lat\nsrc/geo.ts:13: station.lon"),
      a("7 reads: ChartHeader.tsx:22 name, Chart.tsx:41 utcOffset, Chart.tsx:88 utcOffset, StationPicker.tsx:9 name, api/predictions.ts:3 id, geo.ts:12 lat, geo.ts:13 lon."),
    ],
  },
  {
    key: "tidepool-ghost-hour", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-18T17:30:00Z", model: OPUS,
    events: [
      u("weird one: if I scroll the tide chart to anything after nov 1, every high tide is off by one hour. before nov 1 it's fine. I'm calling it the ghost hour"),
      a("Off by exactly one hour starting November 1 is the signature of a daylight saving transition. US DST ends on Sunday, November 1, 2026. Let me check how the chart converts prediction times."),
      read("src/components/Chart.tsx", "const local = new Date(p.t + station.utcOffset * 3600_000);"),
      a("Found the ghost hour. Predictions arrive in UTC and the chart adds `station.utcOffset`, a fixed number. Monterey's offset was captured in July as -7 (PDT). After November 1 the real offset is -8 (PST), so every tide after the transition renders one hour late. It will flip the other way on March 8."),
      u("so the station data is just wrong half the year"),
      a("Right. A fixed offset can't represent a zone with DST. The durable fix is to store an IANA zone per station (`America/Los_Angeles`) and convert each timestamp with the zone rules. That touches the station data, the chart, and the cached predictions, so it's worth a proper session."),
      u("ok. not tonight. write down what you found in NOTES.md so I don't lose it"),
      edit("NOTES.md", "ghost hour: fixed utcOffset captured in PDT; off by one hour after DST ends Nov 1; fix = IANA zone per station"),
      a("Written to NOTES.md under \"ghost hour\"."),
    ],
  },
  {
    key: "tidepool-ghost-hour-marathon", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-19T15:00:00Z", model: OPUS, title: "ghost hour, round two",
    events: [
      // Episode 1: reproduce
      u("ghost hour, round two. read NOTES.md and let's reproduce it properly before touching anything"),
      read("NOTES.md", "## ghost hour\nfixed utcOffset captured in PDT; off by one hour after DST ends Nov 1; fix = IANA zone per station"),
      a("I'll write a failing test first: Monterey's first high tide on November 2, 2026 in local time, compared with the published table."),
      edit("src/components/Chart.test.ts", "failing test: Monterey high tide 2026-11-02 local 05:47"),
      sh("npm test -- Chart", "✗ Chart.test.ts › Monterey high tide after DST\n  expected 05:47, received 06:47\nTests  1 failed"),
      u("there it is. does it also break the tide table view or just the chart?"),
      grep("utcOffset", "src/components/Chart.tsx:41\nsrc/components/Chart.tsx:88\nsrc/views/TideTable.tsx:17\nsrc/sw.ts:52"),
      a("Both, plus one surprise: `sw.ts:52` bakes the offset into the cache key, so cached predictions carry the wrong local times too."),
      u("of course the service worker is involved. what about southern hemisphere stations"),
      a("Same bug, opposite season. A Sydney-style station would be off during their summer instead. Any fix has to use zone rules, not a sign flip."),
      u("show me how many stations are affected"),
      sh("jq '[.[] | select(.utcOffset != null)] | length' data/stations.json", "413"),
      a("All 413 stations carry a fixed offset. Every one is wrong for part of the year."),
      { kind: "compact", command: "/compact keep the failing Monterey test and the list of utcOffset reads", summary: "Reproduced the ghost hour with a failing Monterey test (expected 05:47, got 06:47). utcOffset is read in Chart.tsx:41, Chart.tsx:88, TideTable.tsx:17, and sw.ts:52 (cache key). All 413 stations carry fixed offsets." },
      // Episode 2: decide the model
      u("ok so the fix. IANA zone per station like you said, or compute offset from lat/lon at runtime?"),
      a("Store the zone. Lat/lon to zone needs a boundary dataset (tens of megabytes) and is wrong at borders. Stations don't move, so resolve the zone once at data-build time and keep `zone: \"America/Los_Angeles\"` in stations.json. At render time, format with `Intl.DateTimeFormat` using that zone, or use Luxon if you want arithmetic."),
      u("what does luxon cost us in bundle size"),
      sh("npx bundlephobia luxon", "luxon@3.5.0  minified 71.2 kB  gzip 22.4 kB"),
      a("About 22 kB gzipped. For a PWA that's noticeable but not terrible. Luxon makes the DST edges explicit, which is the whole problem here."),
      u("fine, luxon for now. we can revisit if the bundle gets fat. decision: stations get a zone field, utcOffset goes away"),
      a("Recorded in NOTES.md as a decision: stations carry an IANA `zone`, `utcOffset` is removed, Luxon handles conversion."),
      edit("NOTES.md", "decision 2026-08-19: IANA zone per station, drop utcOffset, use Luxon"),
      gap(170),
      // Episode 3: migrate data and cache
      u("back. let's migrate stations.json. can a worker do the zone lookup for all 413 while we do the chart?"),
      { kind: "task", child: "tidepool-zone-worker", description: "Resolve station zones",
        prompt: "For each station in /Users/demo/code/tidepool/data/stations.json, resolve its IANA time zone from lat/lon using scripts/zone-lookup.ts (already vendored). Write the result as a new `zone` field and delete `utcOffset`. Report any station whose zone is ambiguous.",
        result: "Resolved 413/413 zones. 2 near a zone border were checked by hand: Point Roberts (America/Vancouver) and Nogales-area inland gauge removed (not tidal). utcOffset deleted." },
      edit("src/components/Chart.tsx", "convert with DateTime.fromMillis(p.t, { zone: station.zone })"),
      edit("src/views/TideTable.tsx", "same conversion as Chart"),
      edit("src/sw.ts", "cache key drops offset; bump CACHE_VERSION to 4 so old entries are evicted"),
      u("wait, will people with the old cache still see the ghost hour after they update?"),
      a("No. Bumping `CACHE_VERSION` makes the new worker delete version-3 caches on activate, so stale local times can't survive the update. The first load after updating refetches predictions."),
      u("good. run the monterey test"),
      sh("npm test -- Chart", "✓ Chart.test.ts › Monterey high tide after DST (05:47)\nTests  1 passed"),
      a("Passing. The first high tide on November 2 now renders at 05:47."),
      gap(55),
      { kind: "compact", command: "/compact", summary: "Stations now carry IANA zones (413/413 resolved by a worker), utcOffset removed, Chart and TideTable convert with Luxon, SW cache version bumped to 4. Monterey test passes." },
      // Episode 4: regression tests
      u("last part: I want tests that pin both transitions so the ghost hour never comes back"),
      edit("src/time/dst.test.ts", "table-driven: Mar 8 2026 spring-forward and Nov 1 2026 fall-back for Monterey, Seattle, and a southern-hemisphere station"),
      sh("npm test -- dst", "✓ dst.test.ts (9 tests)\n  ✓ spring-forward 2026-03-08 has no 02:00-02:59 local tide labels\n  ✓ fall-back 2026-11-01 labels the repeated hour once each\nTests  9 passed"),
      a("Nine table-driven cases cover March 8 (spring forward, the missing hour) and November 1 (fall back, the repeated hour) for three stations. The fall-back case asserts that the repeated 01:00 hour gets two distinct labels instead of collapsing."),
      u("what does the chart show during the repeated hour btw"),
      a("Both 01:xx readings appear in order, with the second labeled \"01:12 PST\" so the axis doesn't look like time went backwards."),
      u("perfect. commit it all"),
      sh("git add -A && git commit -m 'Store IANA zones per station; fix ghost hour after DST'", "[main 4e1c2a7] Store IANA zones per station; fix ghost hour after DST\n 9 files changed, 214 insertions(+), 61 deletions(-)"),
      a("Committed as 4e1c2a7."),
    ],
  },
  {
    key: "tidepool-zone-worker", harness: "claude", launch: "subagent", parent: "tidepool-ghost-hour-marathon",
    cwd: PROJECTS.tidepool, model: SONNET,
    events: [
      u("For each station in /Users/demo/code/tidepool/data/stations.json, resolve its IANA time zone from lat/lon using scripts/zone-lookup.ts (already vendored). Write the result as a new `zone` field and delete `utcOffset`. Report any station whose zone is ambiguous."),
      sh("npx tsx scripts/zone-lookup.ts data/stations.json --write", "resolved 411/413\nambiguous: point-roberts (48.97,-123.06), nogales-gauge (31.34,-110.94)"),
      a("Two ambiguous results. Point Roberts is a US exclave that follows Pacific time with Vancouver, so America/Vancouver is correct. The Nogales entry is an inland river gauge with no tides; it was imported by mistake."),
      sh("npx tsx scripts/zone-lookup.ts data/stations.json --write --override point-roberts=America/Vancouver --drop nogales-gauge", "resolved 413/413 (1 dropped)"),
      a("Resolved 413/413 zones. 2 near a zone border were checked by hand: Point Roberts (America/Vancouver) and Nogales-area inland gauge removed (not tidal). utcOffset deleted."),
    ],
  },
  {
    key: "tidepool-luxon-revisit", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-09-02T19:10:00Z", model: SONNET,
    events: [
      u("remember we picked luxon for the ghost hour fix? the bundle is 22kb gzip bigger and lighthouse is mad. can we drop it and use Intl instead?"),
      grep("from \"luxon\"", "src/components/Chart.tsx:2\nsrc/views/TideTable.tsx:3\nsrc/time/format.ts:1"),
      a("Luxon is only used for formatting in a zone, which `Intl.DateTimeFormat` does natively. The one place we did arithmetic (\"next high tide in 3h\") works on UTC milliseconds anyway. I'll replace it with a 30-line `src/time/zoned.ts`."),
      edit("src/time/zoned.ts", "formatInZone(ms, zone, opts) and zoneAbbrev(ms, zone) via Intl.DateTimeFormat"),
      sh("npm test -- dst && npm run build", "✓ dst.test.ts (9 tests)\ndist/assets/index.js  148.3 kB │ gzip: 47.9 kB  (was 70.3 kB)"),
      a("Decision revisited: Luxon is gone, the nine DST tests still pass, and the gzipped bundle dropped from 70.3 kB to 47.9 kB. NOTES.md now says the zone model stays, the library changed."),
      u("love when a revisit is just deleting code"),
    ],
  },
  {
    key: "tidepool-lighthouse", harness: "codex", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-09-14T20:02:00Z", model: CODEX, title: "tidepool lighthouse regression",
    events: [
      u("lighthouse perf score on tidepool dropped to 71 after the chart refactor. why?"),
      sh("npx lighthouse http://localhost:4173 --only-categories=performance --output=json | jq '.audits[\"largest-contentful-paint\"].displayValue, .audits[\"total-blocking-time\"].displayValue'", "\"3.4 s\"\n\"410 ms\""),
      sh("npx vite-bundle-visualizer --json | jq '.[0:3]'", "[{\"name\":\"chart.js/auto\",\"gzip\":61230},{\"name\":\"src/components/Chart.tsx\",\"gzip\":4102},{\"name\":\"react-dom\",\"gzip\":42110}]"),
      a("The refactor switched to `chart.js/auto`, which registers every chart type and plugin (61 kB gzip). Tidepool only draws a line chart. Importing `LineController`, `LineElement`, `PointElement`, `LinearScale`, and `TimeScale` explicitly should cut most of it."),
      u("do it"),
      { kind: "tool", name: "edit", arg: "src/components/Chart.tsx", detail: "register only line chart pieces instead of chart.js/auto", out: "Success. Updated the following files:\nM src/components/Chart.tsx" },
      sh("npm run build && npx lighthouse http://localhost:4173 --only-categories=performance --quiet | tail -1", "Performance: 94"),
      a("Back to 94. LCP is 1.6 s and total blocking time 90 ms."),
    ],
  },
  {
    key: "tidepool-axis-labels", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-09-21T16:40:00Z", model: SONNET,
    events: [
      u("tide chart y-axis labels overlap on small phones, like 'ft' collides with the numbers. quick fix?"),
      read("src/components/Chart.tsx", "scales: { y: { ticks: { callback: v => `${v} ft` } } }"),
      a("The unit is repeated on every tick, which crowds narrow screens. I'll move \"ft\" into the axis title and limit ticks to 5 below 400 px."),
      edit("src/components/Chart.tsx", "y.title = 'ft'; ticks.maxTicksLimit = width < 400 ? 5 : 8"),
      a("Fixed. On a 360 px viewport the axis now shows 5 bare numbers with \"ft\" once at the top."),
    ],
  },

  // ─── ledgerline: a CLI budgeting tool (Rust) ─────────────────────────────
  {
    key: "ledgerline-ofx", harness: "codex", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-08-10T18:30:00Z", model: CODEX, title: "ledgerline OFX import",
    events: [
      u("start the ledgerline importer. my credit union exports OFX. I want `ll import statement.ofx` to append transactions to ledger.toml"),
      sh("ls && cat Cargo.toml", "Cargo.toml  src\n[package]\nname = \"ledgerline\"\nversion = \"0.1.0\"\nedition = \"2021\""),
      a("Empty crate so far. I'll add an `import` subcommand, an OFX parser for `<STMTTRN>` blocks, and a ledger writer that skips transactions whose FITID is already present so re-imports are idempotent."),
      { kind: "tool", name: "edit", arg: "src/import/ofx.rs", detail: "parse STMTTRN: FITID, DTPOSTED, TRNAMT, NAME, MEMO", out: "Success. Updated the following files:\nA src/import/ofx.rs" },
      { kind: "tool", name: "edit", arg: "src/main.rs", detail: "clap subcommand: import <file>", out: "Success. Updated the following files:\nM src/main.rs" },
      sh("cargo test", "running 4 tests\ntest import::ofx::parses_credit_union_sample ... ok\ntest import::ofx::skips_duplicate_fitid ... ok\ntest ledger::appends_in_date_order ... ok\ntest ledger::roundtrips_toml ... ok\n\ntest result: ok. 4 passed"),
      a("`ll import statement.ofx` works. Duplicate FITIDs are skipped, so importing the same statement twice is safe."),
    ],
  },
  {
    key: "ledgerline-catchup", harness: "claude", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-08-15T21:12:00Z", model: OPUS,
    events: [
      u(WALL_OF_TEXT),
      a("That's five threads, so I'll take them in the order you asked: memo fields first, nothing changed yet."),
      sh("head -5 fixtures/banks/bigbank-2026-07.csv", "Date,Description,Amount,Memo\n07/02/2026,POS PURCHASE,-54.21,MKT#4471 GREENLEAF GROCERY\n07/03/2026,GREENLEAF GROCERY,-12.80,\n07/05/2026,POS PURCHASE,-31.07,MKT#4471\n07/06/2026,ACH CREDIT,2100.00,PAYROLL"),
      a("The memo holds a merchant code (`MKT#4471`) when the description is generic (`POS PURCHASE`), and is empty when the description already names the merchant. So a rule should match `MKT#4471` in the memo OR `GREENLEAF` in the description. The merchant code is the stable key you wanted. The other four (slow report, rollover, negative zero, dry run) are separate changes; want them as a list in TODO.md?"),
      u("yes put them in TODO.md, in that order"),
      edit("TODO.md", "1. rules match memo merchant codes  2. cache parsed ledger  3. budget rollover with debt line  4. fix negative zero in report  5. import --dry-run"),
      a("Added to TODO.md in that order."),
    ],
  },
  {
    key: "ledgerline-rollover", harness: "codex", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-08-22T17:00:00Z", model: CODEX, title: "ledgerline budget rollover",
    events: [
      u("TODO item 3: budget rollover. underspend carries forward, overspend shows as a debt line next month"),
      read("src/budget.rs", "pub struct Budget { pub category: String, pub monthly: f64 }"),
      grep("monthly", "src/budget.rs:3\nsrc/report.rs:41\nsrc/report.rs:77"),
      read("src/report.rs", "let remaining = budget.monthly - spent;"),
      a("Budgets are a flat monthly number and the report subtracts spending per month in isolation. Rollover needs state across months. I'll compute it from history rather than store it, so edits to past transactions just work."),
      u("agreed, compute it. but money as f64 makes me nervous"),
      grep("f64", "src/budget.rs:3\nsrc/ledger.rs:12\nsrc/report.rs:41\nsrc/report.rs:52"),
      read("src/ledger.rs", "pub struct Txn { pub date: NaiveDate, pub amount: f64, pub payee: String }"),
      sh("rg -c 'f64' src | sort", "src/budget.rs:1\nsrc/ledger.rs:2\nsrc/report.rs:3"),
      a("It should. Six places use f64 for money. I'd switch to integer cents (`i64`) before building rollover on top, otherwise carried balances accumulate float error."),
      u("do the cents switch first then"),
      { kind: "tool", name: "edit", arg: "src/money.rs", detail: "Cents(i64) newtype with Display and parse", out: "Success. Updated the following files:\nA src/money.rs" },
      { kind: "tool", name: "edit", arg: "src/ledger.rs", detail: "amount: Cents", out: "Success. Updated the following files:\nM src/ledger.rs" },
      sh("cargo test", "test result: ok. 11 passed"),
      u("nice. now rollover"),
      { kind: "tool", name: "edit", arg: "src/budget.rs", detail: "carry(month) folds prior months: surplus carries, deficit becomes debt", out: "Success. Updated the following files:\nM src/budget.rs" },
      { kind: "tool", name: "edit", arg: "src/report.rs", detail: "render carried and debt lines", out: "Success. Updated the following files:\nM src/report.rs" },
      sh("cargo test budget", "test budget::surplus_carries_forward ... ok\ntest budget::deficit_becomes_debt_line ... ok\ntest budget::no_history_means_no_carry ... ok\ntest result: ok. 3 passed"),
      u("show me what august to september looks like with my real ledger"),
      sh("cargo run -q -- report --month 2026-09 --ledger ~/ledger.toml | head -8", "category        budget   carried   spent    left\ndining out      200.00    +38.50    61.20  177.30\ngroceries       450.00      0.00   112.93  337.07\ntransit          90.00   -12.40    40.00   37.60\n  debt from 2026-08: transit -12.40"),
      sh("cargo run -q -- report --month 2026-08 --ledger ~/ledger.toml | grep -E 'dining|transit'", "dining out      200.00      0.00   161.50   38.50\ntransit          90.00      0.00   102.40  -12.40"),
      sh("cargo clippy -q", ""),
      a("August dining out left $38.50, which carries into September. Transit went $12.40 over in August, so September shows it as a debt line instead of silently shrinking the budget."),
      u("the debt line should be red"),
      read("src/report.rs", "writeln!(out, \"  debt from {}: {} {}\", month, cat, amt)?;"),
      grep("colored", "Cargo.toml:9: colored = \"2\""),
      { kind: "tool", name: "edit", arg: "src/report.rs", detail: "debt lines use .red() when stdout is a tty", out: "Success. Updated the following files:\nM src/report.rs" },
      a("Debt lines are red on a terminal and plain when piped."),
      u("what happens if I change a budget mid year"),
      read("src/budget.rs", "pub fn carry(&self, history: &[Month]) -> Cents"),
      sh("cargo test budget::mid_year", "running 0 tests"),
      { kind: "tool", name: "edit", arg: "src/budget.rs", detail: "budgets become dated: Vec<(from, Cents)>; carry uses the amount in force each month", out: "Success. Updated the following files:\nM src/budget.rs" },
      sh("cargo test budget", "test budget::mid_year_change_applies_from_its_month ... ok\ntest result: ok. 4 passed"),
      a("Budgets are now dated. Changing dining out to 250 from October applies from October; carry for earlier months still uses 200."),
      u("and the negative zero thing, is that fixed by cents too?"),
      sh("cargo run -q -- report --month 2026-09 --ledger ~/ledger.toml | grep 'gifts'", "gifts             0.00      0.00     0.00    0.00"),
      grep("-0.00", "(no matches)"),
      sh("cargo test report::empty_category_prints_zero", "test report::empty_category_prints_zero ... ok"),
      a("Yes. `-0.00` came from formatting `0.0 * -1.0`. Integer cents have no negative zero, so empty categories print 0.00. I added a test so it stays fixed."),
      u("ha, two TODO items for one. run clippy, fmt and the whole suite before we commit"),
      sh("cargo fmt --check", ""),
      sh("cargo clippy -q -- -D warnings", ""),
      sh("cargo test -q", "test result: ok. 23 passed"),
      a("fmt, clippy, and all 23 tests are clean."),
      u("ship it"),
      sh("git commit -am 'Money as cents; budget rollover with dated budgets and debt lines'", "[main 9b21f0e] Money as cents; budget rollover with dated budgets and debt lines\n 7 files changed, 302 insertions(+), 88 deletions(-)"),
      sh("git log --oneline -3", "9b21f0e Money as cents; budget rollover with dated budgets and debt lines\n51c0a2d Import: skip duplicate FITIDs\n2e7d9c4 Initial OFX importer"),
      sh("cargo build --release -q && ls -la target/release/ll", "-rwxr-xr-x  1 demo  staff  3.1M Aug 22 18:04 target/release/ll"),
      a("Committed as 9b21f0e. TODO items 3 and 4 are done."),
    ],
  },
  ...[
    { key: "ledgerline-banks-0825", start: "2026-08-25T09:00:00Z", failing: 2 },
    { key: "ledgerline-banks-0826", start: "2026-08-26T09:00:00Z", failing: 1 },
    { key: "ledgerline-banks-0827", start: "2026-08-27T09:00:00Z", failing: 0 },
    { key: "ledgerline-banks-0919", start: "2026-09-19T09:00:00Z", failing: 0 },
  ].map(({ key, start, failing }): SessionSpec => ({
    key, harness: "codex", launch: "exec", cwd: PROJECTS.ledgerline, start, model: CODEX,
    events: [
      u("Run the ledgerline bank fixture suite (`cargo test -p ledgerline --test banks`) and report every failing bank export with the first differing line. Do not modify source files."),
      sh("cargo test -p ledgerline --test banks", failing === 2
        ? "test banks::bigbank_2026_07 ... FAILED\ntest banks::creditunion_2026_07 ... ok\ntest banks::coastal_savings_2026_06 ... FAILED\n\ntest result: FAILED. 1 passed; 2 failed"
        : failing === 1
          ? "test banks::bigbank_2026_07 ... ok\ntest banks::creditunion_2026_07 ... ok\ntest banks::coastal_savings_2026_06 ... FAILED\n\ntest result: FAILED. 2 passed; 1 failed"
          : "test banks::bigbank_2026_07 ... ok\ntest banks::creditunion_2026_07 ... ok\ntest banks::coastal_savings_2026_06 ... ok\n\ntest result: ok. 3 passed"),
      a(failing === 2
        ? "2 failing exports:\n- bigbank_2026_07: line 3, expected payee `GREENLEAF GROCERY`, got `POS PURCHASE` (memo merchant code not applied)\n- coastal_savings_2026_06: line 1, header `Posting Date` not recognized"
        : failing === 1
          ? "1 failing export:\n- coastal_savings_2026_06: line 1, header `Posting Date` not recognized"
          : "All 3 bank exports pass. No failures to report."),
    ],
  })),
  {
    key: "ledgerline-importers-split", harness: "codex", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-09-16T16:00:00Z", model: CODEX, title: "split importers by bank",
    events: [
      u("the csv importer is one giant match on header names. split it into one module per bank behind a trait, and farm the two bank ports out to workers so this goes faster"),
      read("src/import/csv.rs", "match headers.as_slice() { [\"Date\",\"Description\",\"Amount\",\"Memo\"] => ..., [\"Posting Date\",\"Payee\",\"Debit\",\"Credit\"] => ..., _ => bail!(\"unknown bank\") }"),
      { kind: "tool", name: "edit", arg: "src/import/mod.rs", detail: "trait BankImporter { fn sniff(headers) -> bool; fn parse(row) -> Txn }", out: "Success. Updated the following files:\nM src/import/mod.rs" },
      a("The `BankImporter` trait is in. Spawning one worker per bank."),
      { kind: "spawn", child: "ledgerline-port-bigbank", prompt: "Port the BigBank branch of src/import/csv.rs to src/import/banks/bigbank.rs implementing BankImporter. Keep the memo merchant-code rule. Run `cargo test --test banks bigbank` and report.", result: "bigbank.rs done, memo merchant codes preserved, 3 tests pass." },
      { kind: "spawn", child: "ledgerline-port-coastal", prompt: "Port the Coastal Savings branch of src/import/csv.rs to src/import/banks/coastal.rs implementing BankImporter. Debit/Credit columns become one signed amount. Run `cargo test --test banks coastal` and report.", result: "coastal.rs done, Debit/Credit folded into signed cents, 2 tests pass." },
      sh("cargo test", "test result: ok. 19 passed"),
      a("Both ports landed and the whole suite passes. `csv.rs` is now a 20-line dispatcher that asks each importer to sniff the headers."),
      u("clean. adding a new bank is one file now"),
    ],
  },
  {
    key: "ledgerline-port-bigbank", harness: "codex", launch: "thread_spawn", parent: "ledgerline-importers-split",
    cwd: PROJECTS.ledgerline, model: CODEX,
    events: [
      u("Port the BigBank branch of src/import/csv.rs to src/import/banks/bigbank.rs implementing BankImporter. Keep the memo merchant-code rule. Run `cargo test --test banks bigbank` and report."),
      { kind: "tool", name: "edit", arg: "src/import/banks/bigbank.rs", detail: "BigBank importer; payee from memo MKT# code when description is generic", out: "Success. Updated the following files:\nA src/import/banks/bigbank.rs" },
      sh("cargo test --test banks bigbank", "test result: ok. 3 passed"),
      a("bigbank.rs done, memo merchant codes preserved, 3 tests pass."),
    ],
  },
  {
    key: "ledgerline-port-coastal", harness: "codex", launch: "thread_spawn", parent: "ledgerline-importers-split",
    cwd: PROJECTS.ledgerline, model: CODEX,
    events: [
      u("Port the Coastal Savings branch of src/import/csv.rs to src/import/banks/coastal.rs implementing BankImporter. Debit/Credit columns become one signed amount. Run `cargo test --test banks coastal` and report."),
      { kind: "tool", name: "edit", arg: "src/import/banks/coastal.rs", detail: "Coastal importer; signed cents from Debit/Credit", out: "Success. Updated the following files:\nA src/import/banks/coastal.rs" },
      sh("cargo test --test banks coastal", "test result: ok. 2 passed"),
      a("coastal.rs done, Debit/Credit folded into signed cents, 2 tests pass."),
    ],
  },
  {
    key: "ledgerline-dry-run", harness: "codex", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-09-08T18:45:00Z", model: CODEX,
    events: [
      u("last TODO: `ll import --dry-run` should print what each rule would do without writing ledger.toml"),
      { kind: "tool", name: "edit", arg: "src/main.rs", detail: "--dry-run flag; import returns a plan; writer skipped when dry", out: "Success. Updated the following files:\nM src/main.rs\nM src/import/mod.rs" },
      sh("cargo run -q -- import fixtures/banks/bigbank-2026-07.csv --dry-run | head -4", "would add 2026-07-02  -54.21  GREENLEAF GROCERY  groceries   (rule: memo MKT#4471)\nwould add 2026-07-03  -12.80  GREENLEAF GROCERY  groceries   (rule: payee GREENLEAF)\nwould add 2026-07-05  -31.07  GREENLEAF GROCERY  groceries   (rule: memo MKT#4471)\nwould skip 2026-07-06  2100.00  PAYROLL          (duplicate FITID)"),
      a("Dry run prints one line per transaction with the rule that matched, and nothing is written."),
    ],
  },
  {
    key: "ledgerline-rules-readme", harness: "claude", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-09-12T15:30:00Z", model: SONNET,
    events: [
      u("can you write the README section for rules files? people keep asking how the memo matching works"),
      read("src/rules.rs", "pub enum Matcher { Payee(Regex), Memo(Regex), AmountRange(Cents, Cents) }"),
      edit("README.md", "## Rules files: matchers (payee, memo, amount range), first match wins, --dry-run to preview"),
      a("Added a \"Rules files\" section: the three matchers, first-match-wins ordering, a worked example for memo merchant codes like `MKT#4471`, and a pointer to `ll import --dry-run` for previewing."),
      u("perfect, short and useful"),
    ],
  },

  // ─── glasshouse: a greenhouse sensor dashboard ───────────────────────────
  {
    key: "glasshouse-sparklines", harness: "claude", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-08-12T14:15:00Z", model: SONNET,
    events: [
      u("for glasshouse I want tiny soil moisture sparklines per bed. which charting lib? it's a svelte app"),
      a("For sparklines, skip a charting library. Twelve beds times one polyline each is trivially rendered as inline SVG, which keeps the bundle at zero extra kilobytes and styles with CSS. A library earns its place only if you later need axes, tooltips, and zoom on the detail view; uPlot is the lightest good option for that."),
      u("inline svg it is. can you sketch the component"),
      edit("src/lib/Sparkline.svelte", "props: points, min, max; renders <polyline> scaled to a 120x24 viewBox"),
      a("`Sparkline.svelte` takes `points`, `min`, and `max` and draws a 120x24 polyline. The dry threshold renders as a faint horizontal line."),
    ],
  },
  {
    key: "glasshouse-ghost-hour", harness: "codex", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-08-27T19:20:00Z", model: CODEX, title: "glasshouse humidity ghost hour",
    events: [
      u("glasshouse humidity history has a ghost hour. march 8 has a one hour gap and nov 1 last year has a doubled hour where the line zigzags back. same family as the tidepool DST offset bug I think"),
      sh("sqlite3 data/readings.db \"select ts from readings where ts like '2026-03-08 0%' limit 6\"", "2026-03-08 01:45:00\n2026-03-08 01:50:00\n2026-03-08 01:55:00\n2026-03-08 03:00:00\n2026-03-08 03:05:00"),
      a("It is. Readings are stored as naive local strings. On March 8 the clock jumps from 01:59 to 03:00, so there is no 02:xx, which is the gap. On November 1 the 01:xx hour happens twice and both land on the same naive timestamps, so the line doubles back. Storing local time without an offset loses exactly the hour DST moves."),
      u("so store utc"),
      a("Store UTC epoch milliseconds, and keep the greenhouse's IANA zone in config for display. Historic rows can be migrated: for the repeated November hour, sensor sequence numbers tell us which reading came first."),
      { kind: "tool", name: "edit", arg: "migrations/004_utc_readings.sql", detail: "add ts_utc INTEGER; backfill from local ts + zone, disambiguate fall-back by seq", out: "Success. Updated the following files:\nA migrations/004_utc_readings.sql" },
      sh("npm run migrate && npm test -- history", "migrated 412,880 readings (61 fall-back rows disambiguated by seq)\n✓ history.test.ts › no gap rendered across 2026-03-08\n✓ history.test.ts › no doubled hour across 2025-11-02"),
      a("Migrated 412,880 readings; 61 rows in the repeated hour were ordered by sequence number. The chart no longer shows a gap or a zigzag. Same root cause as tidepool: a fixed or missing offset standing in for a zone."),
    ],
  },
  {
    key: "glasshouse-planning", harness: "claude", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-08-28T15:00:00Z", model: OPUS,
    events: [
      // Episode 1: boards and sensors
      u("thinking about the hardware for glasshouse v2. esp32-c3 or pico w for the soil sensor nodes?"),
      a("ESP32-C3. Its deep sleep draws about 5 µA against the Pico W's roughly 1.3 mA dormant with Wi-Fi state kept, which is the difference between a year on two AA cells and a few weeks. The Pico W is nicer to program, but battery nodes live or die on sleep current."),
      u("and capacitive vs resistive moisture probes"),
      a("Capacitive. Resistive probes electrolyse and corrode within a season, and their readings drift as they do. Buy capacitive v2.0 boards and check that the 555 timer is the TLC555, since the cheap NE555 clones need 5 V."),
      u("how many nodes for 12 beds"),
      a("One node per bed pair (six nodes) if the beds are adjacent, since each C3 has enough ADC channels for two probes. Put the air temperature and humidity sensor on a seventh node at bench height, away from the glazing."),
      u("ok six plus one. what about calibration"),
      a("Two-point per probe: read it in dry air, then in a glass of water, and store both in the node config. Moisture percent is then a linear map between the two, which is good enough for irrigation decisions."),
      gap(150),
      // Episode 2: alerts
      u("alerts next. I got woken up twice last week by frost alerts that were just one bad reading"),
      a("Alert on a condition held over time, not a single sample: frost when temperature stays below 2 °C for 10 minutes. Add hysteresis so it clears only above 3 °C, otherwise a reading hovering at 2.0 flaps the alert on and off."),
      u("what about when a node goes silent"),
      a("Treat silence as its own alert with a longer window: no reading from a node for 30 minutes means \"node offline,\" which is different from \"frost.\" Sleeping nodes report every 5 minutes, so 30 minutes is six missed check-ins."),
      u("should alerts go to my phone or just the dashboard"),
      a("Phone for frost and node-offline, dashboard only for everything else. The rule of thumb: page for things that need action within the hour."),
      u("makes sense, frost can kill seedlings overnight"),
      a("Exactly. Frost and offline page you; dry-soil and high-humidity just colour the bed tile."),
      gap(200),
      // Episode 3: tomatoes and drip
      u("totally different question, my tomatoes have blossom end rot again. is that watering?"),
      a("Usually, yes. Blossom end rot is a calcium delivery problem, and it's most often caused by uneven watering rather than too little calcium in the soil. Swings between dry and soaked stop calcium reaching the fruit."),
      u("could glasshouse run a drip valve to keep it even"),
      a("Yes. A 12 V solenoid valve on a relay from one node, opened when the bed's moisture drops below its threshold and closed after a fixed volume. Cap it at a few cycles per day so a failed probe can't flood the bed."),
      u("what threshold for tomatoes"),
      a("Start by opening the valve at 35% and stopping at 50% on your calibrated scale, then adjust by how the soil feels at finger depth for a week."),
      u("ordering a valve tonight"),
    ],
  },
  {
    key: "glasshouse-digest-0903", harness: "claude", launch: "sdk", cwd: PROJECTS.glasshouse,
    start: "2026-09-03T06:00:00Z", model: HAIKU,
    events: [
      u("Summarize anomalies in the glasshouse sensor log logs/2026-09-02.jsonl: readings outside calibrated range, gaps longer than 15 minutes, and duplicate timestamps. Reply with a short markdown digest."),
      sh("jq -c 'select(.moisture < 0 or .moisture > 100)' logs/2026-09-02.jsonl | wc -l", "3"),
      a("**Glasshouse digest, 2026-09-02**\n- 3 out-of-range moisture readings, all from node bed-7/8 between 02:10 and 02:25 (probe likely reseated)\n- 1 gap: node air-1 silent 03:40 to 04:05 (25 min)\n- 0 duplicate timestamps"),
    ],
  },
  {
    key: "glasshouse-digest-0904", harness: "claude", launch: "sdk", cwd: PROJECTS.glasshouse,
    start: "2026-09-04T06:00:00Z", model: HAIKU,
    events: [
      u("Summarize anomalies in the glasshouse sensor log logs/2026-09-03.jsonl: readings outside calibrated range, gaps longer than 15 minutes, and duplicate timestamps. Reply with a short markdown digest."),
      sh("jq -c 'select(.moisture < 0 or .moisture > 100)' logs/2026-09-03.jsonl | wc -l", "0"),
      a("**Glasshouse digest, 2026-09-03**\n- 0 out-of-range readings\n- 0 gaps longer than 15 minutes\n- 0 duplicate timestamps\nAll seven nodes reported on schedule."),
    ],
  },
  {
    key: "glasshouse-frost-alert", harness: "codex", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-09-09T20:30:00Z", model: CODEX, title: "frost alert hysteresis",
    events: [
      u("implement the frost alert we planned: below 2C for 10 min fires, clears above 3C"),
      { kind: "tool", name: "edit", arg: "src/lib/alerts.ts", detail: "heldBelow(series, 2, 10min) fires; clears when latest > 3; state machine per node", out: "Success. Updated the following files:\nM src/lib/alerts.ts" },
      sh("npm test -- alerts", "✓ alerts.test.ts (5 tests)\n  ✓ single cold reading does not fire\n  ✓ 10 minutes below 2°C fires\n  ✓ hovering at 2.0-2.9 does not flap"),
      a("Frost alert fires after 10 minutes below 2 °C and clears above 3 °C. The flapping case from last week is covered by a test."),
    ],
  },
  {
    key: "glasshouse-dst-fixtures", harness: "claude", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-09-18T17:05:00Z", model: OPUS,
    events: [
      u("tidepool and glasshouse both had the ghost hour. can we make one shared DST test fixture both repos use so the next project gets it for free?"),
      a("Yes. A tiny package with the transition instants and the expected local labels, no runtime code. Each repo's tests import the table and assert against its own formatter."),
      edit("packages/dst-fixtures/index.ts", "transitions for America/Los_Angeles, America/New_York, Australia/Sydney 2025-2027 with expected local labels"),
      sh("npm test -- dst", "✓ dst-fixtures › glasshouse history formatter (18 cases)"),
      a("`@demo/dst-fixtures` exports the spring-forward and fall-back instants for three zones from 2025 to 2027, with the labels a correct formatter must produce. Glasshouse passes all 18 cases. Tidepool can import the same table in place of its hand-written one."),
      u("do tidepool too while you're here"),
      sh("cd ../tidepool && npm i ../glasshouse/packages/dst-fixtures && npm test -- dst", "✓ dst.test.ts (18 cases from @demo/dst-fixtures)"),
      a("Tidepool now runs the same 18 cases. The ghost hour has one test table across both projects."),
    ],
  },
  {
    key: "glasshouse-dark-mode", harness: "claude", launch: "cli", cwd: PROJECTS.glasshouse,
    start: "2026-09-24T21:15:00Z", model: SONNET,
    events: [
      u("glasshouse needs a dark mode, I check it at night and it's blinding"),
      edit("src/app.css", "color tokens on :root; prefers-color-scheme: dark overrides; sparkline stroke uses currentColor"),
      a("Added colour tokens with a dark override that follows the system setting. Sparklines use `currentColor`, so they switch too. Bed tiles keep their dry/wet tint at lower saturation in dark mode."),
    ],
  },

  // ─── one-off chores ──────────────────────────────────────────────────────
  {
    key: "chore-worktrees", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-14T22:10:00Z", model: SONNET,
    events: [
      u("I have a pile of stale git worktrees for tidepool. clean them up but don't touch anything with uncommitted changes"),
      sh("git worktree list", "/Users/demo/code/tidepool           4e1c2a7 [main]\n/Users/demo/code/tidepool-wt/picker  9a0b1c2 [picker]\n/Users/demo/code/tidepool-wt/sw      prunable\n/Users/demo/code/tidepool-wt/luxon   3f4e5d6 [luxon-spike]"),
      sh("git -C ../tidepool-wt/picker status --short; git -C ../tidepool-wt/luxon status --short", " M src/components/StationPicker.tsx"),
      a("`sw` is already gone on disk (prunable). `luxon` is clean. `picker` has an uncommitted change to StationPicker.tsx, so I'll leave it."),
      sh("git worktree prune && git worktree remove ../tidepool-wt/luxon", ""),
      a("Pruned `sw`, removed `luxon`. Kept `picker` because it has uncommitted work."),
    ],
  },
  {
    key: "chore-box-drawing", harness: "claude", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-09-05T17:50:00Z", model: OPUS,
    events: [
      u("the ledgerline report table renders its box drawing lines double width in my terminal, the columns drift right. only in one font"),
      a("That usually means the font's fallback for U+2500 box drawing characters comes from a CJK font, where they're double width. Which font, and does `ll report` use `─` or ASCII?"),
      u("it's the nerd font patched iosevka. and yes it uses ─"),
      sh("printf '\\u2500\\u2502\\u250c' | wc -m; fc-list ':charset=2500' family | head -3", "3\nIosevka Term\nNoto Sans CJK JP\nMenlo"),
      a("The patched Iosevka you're using is the proportional-width variant, which lacks the box block, so the terminal falls back to Noto Sans CJK and renders them double width. Two fixes: switch to the `Iosevka Term` build (it includes box drawing at single width), or give ledgerline a `--ascii` table style. I'd do both, since you won't be the last."),
      u("do the ascii flag"),
      edit("src/report.rs", "--ascii: +, -, | borders; LEDGERLINE_ASCII=1 env default"),
      a("`ll report --ascii` (or `LEDGERLINE_ASCII=1`) draws borders with `+ - |`. Columns line up in any font."),
    ],
  },
  {
    key: "chore-zsh-prompt", harness: "codex", launch: "cli", cwd: PROJECTS.dotfiles,
    start: "2026-09-10T08:20:00Z", model: CODEX, title: "slow zsh prompt",
    events: [
      u("why does my zsh prompt take like 800ms in big repos"),
      sh("zsh -xi -c exit 2>&1 | ts -s '%.s' | sort -k1 -n | tail -3", "0.61 +vcs_info:... git status --porcelain --untracked-files=all\n0.74 +_prompt_node_version:2> node --version\n0.79 +precmd"),
      a("Two costs: `vcs_info` runs `git status` with all untracked files on every prompt (610 ms in a big repo), and a prompt segment shells out to `node --version` (130 ms). Set `check-for-changes` to use `--untracked-files=no`, and read the node version from `.nvmrc` instead of running node."),
      { kind: "tool", name: "edit", arg: "zsh/prompt.zsh", detail: "untracked-files=no; node version from .nvmrc", out: "Success. Updated the following files:\nM zsh/prompt.zsh" },
      a("The prompt is now about 60 ms in the same repo."),
    ],
  },
  {
    key: "chore-cargo-single-test", harness: "claude", launch: "cli", cwd: PROJECTS.ledgerline,
    start: "2026-09-23T19:02:00Z", model: SONNET,
    events: [
      u("what's the cargo flag to run a single test by exact name?"),
      a("`cargo test budget::surplus_carries_forward -- --exact`. The name before `--` is a substring filter; `--exact` after it makes it match only that full path."),
    ],
  },
  {
    key: "chore-harmonics-explainer", harness: "claude", launch: "cli", cwd: PROJECTS.tidepool,
    start: "2026-08-30T16:30:00Z", model: OPUS,
    events: [
      u("I keep forgetting how tide prediction works. explain harmonic constituents like I'm a programmer, short"),
      a("A tide prediction is a sum of sine waves. Each constituent is one astronomical rhythm with a fixed period: M2 is the principal lunar tide (12.42 h), S2 the solar one (12.00 h), K1 and O1 are the daily lunar-solar pair. For a given station, measurements give each constituent an amplitude and a phase. Prediction is then `h(t) = mean + Σ amplitude·cos(speed·t + phase)`, a loop over about 37 terms. Spring and neap tides are just M2 and S2 drifting in and out of phase every 14.8 days."),
      u("so the station data is basically a list of amplitudes and phases"),
      a("Exactly, plus the datum and the station's zone for display. Which is why a wrong zone gives you a perfect prediction at the wrong time: the ghost hour."),
      u("save that to docs/harmonics.md"),
      edit("docs/harmonics.md", "short explainer: constituents, h(t) formula, spring/neap"),
    ],
  },
  {
    key: "chore-screenshot-rename", harness: "claude", launch: "cli", cwd: PROJECTS.photos,
    start: "2026-09-01T12:40:00Z", model: SONNET,
    events: [
      u("rename my screenshots from 'Screenshot 2026-08-14 at 10.02.11.png' to '2026-08-14_10-02-11.png'. dry run first"),
      sh("for f in Screenshot*.png; do n=$(echo \"$f\" | sed -E 's/Screenshot ([0-9-]+) at ([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.png/\\1_\\2-\\3-\\4.png/'); echo \"$f -> $n\"; done | head -3", "Screenshot 2026-08-14 at 10.02.11.png -> 2026-08-14_10-02-11.png\nScreenshot 2026-08-14 at 10.05.40.png -> 2026-08-14_10-05-40.png\nScreenshot 2026-08-15 at 21.30.02.png -> 2026-08-15_21-30-02.png"),
      a("The mapping looks right for all 214 files. Say go and I'll run it with `mv -n` so nothing gets overwritten."),
      u("go"),
      sh("for f in Screenshot*.png; do mv -n \"$f\" \"$(echo \"$f\" | sed -E 's/Screenshot ([0-9-]+) at ([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.png/\\1_\\2-\\3-\\4.png/')\"; done; ls Screenshot*.png 2>/dev/null | wc -l", "0"),
      a("All 214 renamed; none left with the old prefix."),
    ],
  },
];

// ─── fixture interpretation layers ───────────────────────────────────────
// Hand-authored stand-ins for model output. The builder writes them with
// model = "fixture" so nobody mistakes them for a real labelling pass.

export interface EpisodeLabel {
  /** Prefix of the user's first message in the episode, used to find the provider-free span. */
  startsWith: string;
  label: string;
  facet: string;
  tags: string[];
}

export const EPISODE_LABELS: Record<string, EpisodeLabel[]> = {
  "tidepool-ghost-hour-marathon": [
    { startsWith: "ghost hour, round two", label: "Reproduce ghost hour at Monterey", facet: "code", tags: ["tidepool", "ghost-hour", "debugging"] },
    { startsWith: "ok so the fix", label: "Decide IANA zones over fixed offsets", facet: "design", tags: ["tidepool", "ghost-hour", "iana-timezones"] },
    { startsWith: "back. let's migrate", label: "Migrate stations and bust SW cache", facet: "code", tags: ["tidepool", "tidepool-service-worker", "station-data"] },
    { startsWith: "last part", label: "Pin both DST transitions in tests", facet: "code", tags: ["tidepool", "dst-regression-tests"] },
  ],
  "glasshouse-planning": [
    { startsWith: "thinking about the hardware", label: "ESP32-C3 vs Pico W sensor nodes", facet: "research", tags: ["glasshouse", "esp32-c3", "soil-moisture-probes"] },
    { startsWith: "alerts next", label: "Frost alert windows and hysteresis", facet: "design", tags: ["glasshouse", "glasshouse-alerts"] },
    { startsWith: "totally different question", label: "Blossom end rot and a drip valve", facet: "life", tags: ["tomatoes", "drip-irrigation"] },
  ],
  "ledgerline-rollover": [
    { startsWith: "TODO item 3", label: "Cents money type and budget rollover", facet: "code", tags: ["ledgerline", "budget-rollover", "integer-cents"] },
  ],
};

/** Whole-session (episode -1) tags for short human sessions, as the tiny-tags pass would write. */
export const SESSION_TAGS: Record<string, { facet: string; tags: string[] }> = {
  "tidepool-offline": { facet: "code", tags: ["tidepool", "tidepool-service-worker", "offline-first"] },
  "tidepool-picker-plan": { facet: "design", tags: ["tidepool", "station-picker"] },
  "tidepool-picker-build": { facet: "code", tags: ["tidepool", "station-picker"] },
  "tidepool-ghost-hour": { facet: "code", tags: ["tidepool", "ghost-hour", "dst-offset-bug"] },
  "tidepool-luxon-revisit": { facet: "code", tags: ["tidepool", "ghost-hour", "bundle-size"] },
  "tidepool-lighthouse": { facet: "code", tags: ["tidepool", "bundle-size", "lighthouse"] },
  "tidepool-axis-labels": { facet: "design", tags: ["tidepool", "chart-axis"] },
  "ledgerline-ofx": { facet: "code", tags: ["ledgerline", "ledgerline-importer", "ofx"] },
  "ledgerline-catchup": { facet: "code", tags: ["ledgerline", "ledgerline-importer", "memo-matching"] },
  "ledgerline-importers-split": { facet: "code", tags: ["ledgerline", "ledgerline-importer", "refactor"] },
  "ledgerline-dry-run": { facet: "code", tags: ["ledgerline", "ledgerline-importer"] },
  "ledgerline-rules-readme": { facet: "writing", tags: ["ledgerline", "readme"] },
  "glasshouse-sparklines": { facet: "design", tags: ["glasshouse", "sparklines"] },
  "glasshouse-ghost-hour": { facet: "code", tags: ["glasshouse", "ghost-hour", "dst-offset-bug"] },
  "glasshouse-frost-alert": { facet: "code", tags: ["glasshouse", "glasshouse-alerts"] },
  "glasshouse-dst-fixtures": { facet: "code", tags: ["glasshouse", "ghost-hour", "dst-regression-tests"] },
  "glasshouse-dark-mode": { facet: "design", tags: ["glasshouse", "dark-mode"] },
  "chore-worktrees": { facet: "ops", tags: ["git-worktrees"] },
  "chore-box-drawing": { facet: "code", tags: ["font-fallback", "box-drawing"] },
  "chore-zsh-prompt": { facet: "ops", tags: ["zsh-prompt", "dotfiles"] },
  "chore-cargo-single-test": { facet: "learning", tags: ["cargo"] },
  "chore-harmonics-explainer": { facet: "learning", tags: ["tide-harmonics", "tidepool"] },
  "chore-screenshot-rename": { facet: "ops", tags: ["file-renaming"] },
};

/** Tag consolidation decisions, as the rubric checker would log them. */
export const TAG_MERGES: { from: string; to: string; action: "merge" | "nest" | "demote"; reason: string }[] = [
  { from: "dst-offset-bug", to: "ghost-hour", action: "merge", reason: "same bug under the user's own name" },
  { from: "tidepool-service-worker", to: "tidepool", action: "nest", reason: "subtopic of tidepool keeps its detail" },
  { from: "ledgerline-importer", to: "ledgerline", action: "nest", reason: "subtopic of ledgerline" },
  { from: "glasshouse-alerts", to: "glasshouse", action: "nest", reason: "subtopic of glasshouse" },
  { from: "debugging", to: "facet:code", action: "demote", reason: "generic activity, as broad as a facet" },
  { from: "refactor", to: "facet:code", action: "demote", reason: "generic activity, as broad as a facet" },
];

/**
 * Tier-1 summaries as a provider pass would store them: `topic` follows the
 * tier-1 contract (comma-separated phrases, <= 120 chars) and becomes the list
 * title; `body` is the prose the about pane shows. Titled sessions keep their
 * title as the first phrase so the story's names survive on screen.
 */
export const SUMMARIES: Record<string, { topic: string; body: string }> = {
  "tidepool-offline": {
    topic: "tidepool offline mode, service worker, stale-while-revalidate predictions, cached badge",
    body: "Added a service worker to tidepool that precaches the app shell and serves tide predictions stale-while-revalidate, so the chart renders at the beach without signal. A header badge says when the chart is showing cached data, e.g. \"offline · cached 2 days ago\".",
  },
  "tidepool-picker-plan": {
    topic: "station picker redesign plan, fuzzy search, near-me list, recent chips",
    body: "Planned a replacement for tidepool's 400-item station dropdown: fuzzy search, a near-me list sorted by distance with the next high tide inline, recent-station chips, and a shared src/stations module. No code was written; the plan also flagged each station's fixed utcOffset as a later concern.",
  },
  "tidepool-picker-build": {
    topic: "station picker build, shared stations module, fuzzy search, near-me list",
    body: "Implemented the station picker plan: a shared src/stations lookup, fuzzy search, a near-me list, and recent-station chips, with the stations tests passing. A worker mapped the seven station field reads first; the two utcOffset reads in Chart.tsx were left alone as planned.",
  },
  "tidepool-picker-explore": {
    topic: "station field reads, tidepool src grep, 7 file:line hits",
    body: "Worker task for the picker build: listed every read of a station field in tidepool/src. Found 7 reads, including two utcOffset reads in Chart.tsx.",
  },
  "tidepool-ghost-hour": {
    topic: "ghost hour, tide chart off by one hour after Nov 1, fixed utcOffset, DST",
    body: "Diagnosed the ghost hour: tide times after November 1 render an hour late because each station stores a fixed utcOffset captured during daylight time. The durable fix is an IANA zone per station; the finding went into NOTES.md for a later session.",
  },
  "tidepool-ghost-hour-marathon": {
    topic: "ghost hour, round two: Monterey repro, IANA zones, Luxon, SW cache v4, DST tests",
    body: "Fixed the ghost hour end to end. A failing Monterey test (expected 05:47, got 06:47) reproduced it; all 413 stations then moved from a fixed utcOffset to IANA zones, with Luxon converting times and a service-worker cache bump evicting stale ones. Nine table-driven tests pin the March 8 and November 1 transitions, committed as 4e1c2a7.",
  },
  "tidepool-zone-worker": {
    topic: "station zone lookup, 413 IANA zones, Point Roberts, Nogales gauge dropped",
    body: "Worker task: resolved an IANA zone for all 413 tidepool stations and deleted utcOffset. Point Roberts was set to America/Vancouver by hand and a non-tidal Nogales gauge was dropped.",
  },
  "tidepool-luxon-revisit": {
    topic: "Luxon decision revisited, Intl.DateTimeFormat, bundle 70.3 to 47.9 kB gzip",
    body: "Revisited the ghost-hour decision to use Luxon after Lighthouse complained about bundle size. Luxon was replaced by a small Intl.DateTimeFormat helper; the nine DST tests still pass and the gzipped bundle fell from 70.3 kB to 47.9 kB. The zone model stayed, only the library changed.",
  },
  "tidepool-lighthouse": {
    topic: "tidepool lighthouse regression, chart.js/auto, line-chart-only imports, score 71 to 94",
    body: "Tidepool's Lighthouse performance score fell to 71 after the chart refactor because chart.js/auto pulled in every chart type. Registering only the line chart pieces brought it back to 94.",
  },
  "tidepool-axis-labels": {
    topic: "tide chart y-axis, overlapping labels on small phones, ft axis title",
    body: "Fixed overlapping y-axis labels on narrow phones by moving \"ft\" into the axis title and limiting ticks to 5 below 400 px.",
  },
  "ledgerline-ofx": {
    topic: "ledgerline OFX import, ll import subcommand, FITID dedupe",
    body: "Started ledgerline's importer: `ll import statement.ofx` parses credit-union OFX transactions and appends them to ledger.toml. Duplicate FITIDs are skipped, so re-importing a statement is safe.",
  },
  "ledgerline-catchup": {
    topic: "ledgerline catch-up, BigBank memo merchant codes, slow report, rollover, TODO list",
    body: "A long catch-up on ledgerline covering five threads: memo matching, a slow monthly report, budget rollover, negative zero in reports, and an import dry run. The BigBank memo holds a merchant code like MKT#4471 when the description is generic, which makes a stable rule key. The five items went into TODO.md in order.",
  },
  "ledgerline-rollover": {
    topic: "ledgerline budget rollover, integer cents, dated budgets, red debt lines, negative zero",
    body: "Switched ledgerline money from f64 to integer cents, then built budget rollover computed from history: underspend carries forward and overspend shows as a red debt line the next month. Budgets became dated for mid-year changes, and cents also fixed the -0.00 in empty categories. Committed as 9b21f0e with all 23 tests passing.",
  },
  "ledgerline-banks-0825": {
    topic: "bank fixture suite, 2 failing exports, BigBank memo payee, Coastal header",
    body: "Scheduled run of the ledgerline bank fixture suite: 2 of 3 exports failed. BigBank's memo merchant code was not applied and Coastal Savings' Posting Date header was not recognized.",
  },
  "ledgerline-banks-0826": {
    topic: "bank fixture suite, 1 failing export, Coastal Savings header",
    body: "Scheduled run of the ledgerline bank fixture suite: BigBank now passes, and Coastal Savings still fails on its Posting Date header.",
  },
  "ledgerline-banks-0827": {
    topic: "bank fixture suite, all 3 exports pass",
    body: "Scheduled run of the ledgerline bank fixture suite: all 3 bank exports pass.",
  },
  "ledgerline-banks-0919": {
    topic: "bank fixture suite, all 3 exports pass after importer split",
    body: "Scheduled run of the ledgerline bank fixture suite after the importer split: all 3 bank exports pass.",
  },
  "ledgerline-importers-split": {
    topic: "split importers by bank, BankImporter trait, BigBank and Coastal ports",
    body: "Split ledgerline's CSV importer into one module per bank behind a BankImporter trait, with two spawned workers porting BigBank and Coastal Savings in parallel. The suite passes with 19 tests, and adding a bank is now one file.",
  },
  "ledgerline-port-bigbank": {
    topic: "BigBank importer port, BankImporter trait, memo merchant codes",
    body: "Worker thread: ported the BigBank CSV branch to src/import/banks/bigbank.rs, keeping the memo merchant-code rule. 3 tests pass.",
  },
  "ledgerline-port-coastal": {
    topic: "Coastal Savings importer port, Debit/Credit to signed cents",
    body: "Worker thread: ported the Coastal Savings CSV branch to src/import/banks/coastal.rs, folding Debit and Credit into one signed amount. 2 tests pass.",
  },
  "ledgerline-dry-run": {
    topic: "ll import --dry-run, rule preview, nothing written",
    body: "Added `ll import --dry-run`, which prints each transaction with the rule that would match it and writes nothing to ledger.toml. That closed the last ledgerline TODO item.",
  },
  "ledgerline-rules-readme": {
    topic: "ledgerline README, rules files, memo matching, first match wins",
    body: "Wrote the README section on rules files: payee, memo, and amount-range matchers, first-match-wins ordering, a memo merchant-code example, and a pointer to `ll import --dry-run`.",
  },
  "glasshouse-sparklines": {
    topic: "glasshouse soil moisture sparklines, inline SVG over a chart library, Svelte",
    body: "Chose inline SVG over a charting library for glasshouse's per-bed soil moisture sparklines. Sparkline.svelte draws a 120x24 polyline with the dry threshold as a faint line.",
  },
  "glasshouse-ghost-hour": {
    topic: "glasshouse humidity ghost hour, naive local timestamps, UTC migration, DST",
    body: "Glasshouse humidity history had a one-hour gap on March 8 and a doubled hour on November 1 because readings were stored as naive local time. Readings moved to UTC epoch milliseconds, with 412,880 rows migrated and 61 fall-back rows ordered by sequence number. Same root cause as the tidepool ghost hour.",
  },
  "glasshouse-planning": {
    topic: "glasshouse v2 hardware, ESP32-C3 sensor nodes, frost alert hysteresis, blossom end rot",
    body: "A wandering planning session for glasshouse v2: ESP32-C3 nodes with capacitive probes, six bed nodes plus an air node, and two-point calibration. Then frost alerts held for 10 minutes with hysteresis and node-offline paging. It ended on tomato blossom end rot and a moisture-driven drip valve.",
  },
  "glasshouse-digest-0903": {
    topic: "glasshouse sensor digest 2026-09-02, out-of-range moisture, node gap",
    body: "Scheduled digest of the 2026-09-02 sensor log: 3 out-of-range moisture readings from bed-7/8 and one 25-minute gap from node air-1. No duplicate timestamps.",
  },
  "glasshouse-digest-0904": {
    topic: "glasshouse sensor digest 2026-09-03, no anomalies",
    body: "Scheduled digest of the 2026-09-03 sensor log: no anomalies, and all seven nodes reported on schedule.",
  },
  "glasshouse-frost-alert": {
    topic: "frost alert hysteresis, 10 minutes below 2 C, clears above 3 C",
    body: "Implemented the planned glasshouse frost alert: it fires after 10 minutes below 2 °C and clears above 3 °C. Tests cover the single cold reading and the hovering case that caused false alarms.",
  },
  "glasshouse-dst-fixtures": {
    topic: "shared DST test fixtures, ghost hour, tidepool and glasshouse, 18 cases",
    body: "Turned both ghost-hour fixes into one shared test table: @demo/dst-fixtures lists spring-forward and fall-back instants for three zones from 2025 to 2027 with the expected labels. Glasshouse and tidepool now run the same 18 cases.",
  },
  "glasshouse-dark-mode": {
    topic: "glasshouse dark mode, CSS color tokens, prefers-color-scheme",
    body: "Added a glasshouse dark mode with colour tokens that follow the system setting. Sparklines use currentColor and bed tiles keep a softer dry/wet tint.",
  },
  "chore-worktrees": {
    topic: "stale tidepool git worktrees, prune, keep uncommitted picker worktree",
    body: "Cleaned up stale tidepool worktrees: pruned the missing sw worktree and removed the clean luxon one. The picker worktree was kept because it has uncommitted changes.",
  },
  "chore-box-drawing": {
    topic: "box drawing double width, Iosevka font fallback, ll report --ascii",
    body: "Report borders drifted because the patched Iosevka font lacks box-drawing glyphs and the terminal fell back to a double-width CJK font. Added `ll report --ascii` (or LEDGERLINE_ASCII=1) so columns line up in any font.",
  },
  "chore-zsh-prompt": {
    topic: "slow zsh prompt, vcs_info untracked files, node version from .nvmrc, 800 to 60 ms",
    body: "The zsh prompt took about 800 ms in big repos because vcs_info scanned untracked files and a segment ran node --version. Skipping untracked files and reading .nvmrc brought it to about 60 ms.",
  },
  "chore-cargo-single-test": {
    topic: "cargo test by exact name, --exact flag",
    body: "Quick answer: `cargo test <path> -- --exact` runs one test by its full name; without --exact the name is a substring filter.",
  },
  "chore-harmonics-explainer": {
    topic: "tide harmonic constituents, M2 S2 K1 O1, prediction formula, docs/harmonics.md",
    body: "A short programmer's explainer of tide prediction as a sum of harmonic constituents with per-station amplitudes and phases. It ties back to the ghost hour: a wrong zone gives a correct prediction at the wrong time. Saved to docs/harmonics.md.",
  },
  "chore-screenshot-rename": {
    topic: "screenshot renaming, dated filenames, dry run then mv -n, 214 files",
    body: "Renamed 214 screenshots to YYYY-MM-DD_HH-MM-SS.png after a dry run of the mapping, using mv -n so nothing was overwritten.",
  },
};

export interface Tier2Anchor {
  /** Prefix of the user message that opens the range; the range runs to the next anchor or the session end. */
  from: string;
  topic: string;
  body: string;
}

/**
 * Tier-2 (anchored) summaries for the sessions the story leans on, so their
 * about pane shows a navigable outline instead of the tier-1 fallback.
 */
export const TIER2: Record<string, { body: string; anchors: Tier2Anchor[] }> = {
  "tidepool-ghost-hour-marathon": {
    body: "A four-hour fix for the ghost hour. The bug was reproduced with a failing Monterey test, the fix chose an IANA zone per station over fixed offsets, a worker migrated all 413 stations, and table-driven tests now pin both 2026 DST transitions. Committed as 4e1c2a7.",
    anchors: [
      { from: "ghost hour, round two", topic: "Reproduce with a failing Monterey test", body: "Monterey's November 2 high tide renders at 06:47 instead of 05:47. utcOffset is read in Chart, TideTable, and the service-worker cache key, and all 413 stations carry a fixed offset." },
      { from: "ok so the fix", topic: "Decide: IANA zone per station, Luxon for now", body: "Zones are resolved once at data-build time rather than from lat/lon at runtime. Luxon (22 kB gzip) is accepted for now, to be revisited if the bundle grows." },
      { from: "back. let's migrate", topic: "Migrate 413 stations, bump the SW cache to v4", body: "A worker resolved every station's zone. Chart and TideTable convert with Luxon, and CACHE_VERSION 4 evicts stale local times. The Monterey test passes." },
      { from: "last part", topic: "Pin both DST transitions in tests, commit", body: "Nine table-driven cases cover March 8 and November 1 for three stations, and the repeated hour gets two distinct labels. Committed as 4e1c2a7." },
    ],
  },
  "tidepool-ghost-hour": {
    body: "First sighting of the ghost hour: every tide after November 1 renders an hour late. The cause is a fixed utcOffset captured during daylight time; the fix is deferred to a later session.",
    anchors: [
      { from: "weird one", topic: "Diagnose the one-hour shift after Nov 1", body: "Predictions arrive in UTC and Chart.tsx adds a fixed station.utcOffset of -7, which is wrong after DST ends." },
      { from: "so the station data", topic: "Fixed offsets cannot represent DST", body: "The durable fix is an IANA zone per station, touching station data, the chart, and cached predictions." },
      { from: "ok. not tonight", topic: "Park the finding in NOTES.md", body: "NOTES.md gets a ghost hour entry: fixed offset captured in PDT, wrong after November 1, fix with IANA zones." },
    ],
  },
  "tidepool-luxon-revisit": {
    body: "Revisits the ghost-hour decision to use Luxon. Intl.DateTimeFormat covers the zone formatting, so Luxon is removed; the DST tests still pass and the bundle shrinks by 22 kB gzip.",
    anchors: [
      { from: "remember we picked luxon", topic: "Replace Luxon with Intl.DateTimeFormat", body: "A 30-line src/time/zoned.ts replaces Luxon. The nine DST tests pass and the gzipped bundle drops from 70.3 kB to 47.9 kB; the zone model stays." },
    ],
  },
  "tidepool-picker-plan": {
    body: "Plans the station picker redesign without writing code, and notes each station's fixed utcOffset as a later concern.",
    anchors: [
      { from: "I want to redesign the station picker", topic: "Plan: search, near-me list, recent chips", body: "Fuzzy search on name and region, a near-me list with the next high tide inline, recent-station chips, and a shared src/stations module. Accepted as written." },
    ],
  },
  "tidepool-picker-build": {
    body: "Implements the accepted station picker plan, starting with a shared stations module after a worker maps every station field read.",
    anchors: [
      { from: "Implement the following plan", topic: "Shared stations module and the new picker", body: "src/stations/index.ts provides search and nearest; StationPicker gains search, a near-me list, and recent chips. The two utcOffset reads in Chart.tsx are left alone." },
    ],
  },
  "ledgerline-catchup": {
    body: "One long catch-up message covering five ledgerline threads. The memo fields are examined first, and the rest become a TODO list.",
    anchors: [
      { from: "ok so here's where I'm at", topic: "Memo fields hold merchant codes like MKT#4471", body: "BigBank puts a merchant code in the memo when the description is a generic POS PURCHASE, which makes a stable rule key." },
      { from: "yes put them in TODO.md", topic: "Five items into TODO.md in order", body: "Memo matching, a cached ledger for the slow report, budget rollover with a debt line, negative zero, and import --dry-run." },
    ],
  },
  "ledgerline-rollover": {
    body: "TODO item 3, budget rollover, built on a switch from f64 to integer cents. The cents switch also fixed negative zero, and the work was committed as 9b21f0e.",
    anchors: [
      { from: "TODO item 3", topic: "Compute rollover from history", body: "Budgets were a flat monthly number, so rollover is computed from past months rather than stored." },
      { from: "agreed, compute it", topic: "Money from f64 to integer cents", body: "Six f64 money fields become a Cents(i64) newtype before any carried balance is built on top." },
      { from: "nice. now rollover", topic: "Surplus carries, deficit becomes a debt line", body: "August dining out leaves $38.50 carried into September; transit's $12.40 overspend shows as a debt line." },
      { from: "the debt line should be red", topic: "Red debt lines and dated budgets", body: "Debt lines are red on a terminal, and budgets become dated so mid-year changes apply from their month." },
      { from: "and the negative zero thing", topic: "Cents fix -0.00; full suite and commit", body: "Integer cents have no negative zero. fmt, clippy, and 23 tests pass, committed as 9b21f0e." },
    ],
  },
  "ledgerline-importers-split": {
    body: "Splits the CSV importer into one module per bank behind a BankImporter trait, with two spawned workers porting the banks in parallel.",
    anchors: [
      { from: "the csv importer is one giant match", topic: "BankImporter trait, BigBank and Coastal ports", body: "Spawned workers port BigBank (keeping memo merchant codes) and Coastal Savings (signed cents). All 19 tests pass and csv.rs is a 20-line dispatcher." },
    ],
  },
  "glasshouse-ghost-hour": {
    body: "The tidepool ghost hour, again: glasshouse stored naive local timestamps, which lose the hour DST moves. Readings now store UTC and the history was migrated.",
    anchors: [
      { from: "glasshouse humidity history", topic: "Gap on Mar 8, doubled hour on Nov 1", body: "Naive local strings skip 02:xx on March 8 and repeat 01:xx on November 1, so the chart gaps and zigzags." },
      { from: "so store utc", topic: "Store UTC, migrate 412,880 readings", body: "Readings move to UTC epoch milliseconds with the greenhouse zone in config; 61 repeated-hour rows are ordered by sequence number." },
    ],
  },
  "glasshouse-dst-fixtures": {
    body: "Turns both ghost-hour fixes into one shared DST test table that tidepool and glasshouse import.",
    anchors: [
      { from: "tidepool and glasshouse both had the ghost hour", topic: "Shared @demo/dst-fixtures table", body: "Spring-forward and fall-back instants for three zones from 2025 to 2027 with expected labels. Glasshouse passes all 18 cases." },
      { from: "do tidepool too", topic: "Tidepool adopts the same 18 cases", body: "Tidepool's hand-written table is replaced by the shared package." },
    ],
  },
  "glasshouse-planning": {
    body: "A wandering glasshouse v2 conversation: sensor hardware, then alerting, then tomatoes.",
    anchors: [
      { from: "thinking about the hardware", topic: "ESP32-C3 nodes, capacitive probes, calibration", body: "ESP32-C3 for its 5 µA deep sleep, capacitive probes, six bed nodes plus an air node, and two-point calibration." },
      { from: "alerts next", topic: "Frost alerts: held window and hysteresis", body: "Frost fires after 10 minutes below 2 °C and clears above 3 °C; node-offline is its own alert. Both page the phone." },
      { from: "totally different question", topic: "Blossom end rot and a drip valve", body: "Uneven watering causes it; a relay-driven drip valve opening at 35% and closing at 50% keeps moisture even." },
    ],
  },
};
