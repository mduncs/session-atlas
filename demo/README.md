# Demo archive

A small, entirely fictional Session Atlas archive you can open without pointing
Atlas at your own transcripts. Every session, person, path, and project here is
invented. The user home is `/Users/demo`.

```sh
bun scripts/demo-archive.ts --out /tmp/atlas-demo
bun src/cli.ts --config /tmp/atlas-demo/config.toml
```

The builder copies `demo/sources/` into `<out>/sources/`, writes
`<out>/config.toml` with only the Claude and Codex roots enabled, both inside
`<out>`, no provider, and one harmless launcher (`next-session`: `less
{payload}`, which opens on the payload's first screen). It then runs the real
provider-free `atlas index` and
`atlas layers all`, seeds the fixture layers and summaries (see below), and
prints a summary followed by a privacy scan. A rebuild replaces the previous
build, including any `exports/` the TUI wrote. It refuses an `--out` that overlaps the live Atlas
data or config directory, `~/.claude`, `~/.codex`, or this repository. It also
refuses a non-empty directory that it did not create.

Every CLI command works against the demo if you pass the same `--config`:

```sh
bun src/cli.ts ls --config /tmp/atlas-demo/config.toml
bun src/cli.ts search "ghost hour" --config /tmp/atlas-demo/config.toml
bun src/cli.ts read 11 --config /tmp/atlas-demo/config.toml
```

Set `ATLAS_SEARCH_LOG=0` if you don't want your searches recorded in the demo's
search log. Ages such as "5d ago" are relative to today. The sessions are dated
10 August to 24 September 2026.

## The story

Three side projects and some chores, across 36 sessions (22 Claude Code, 14
Codex):

- **tidepool**, a tide-chart PWA. It gets offline support and a new station
  picker, planned in one session and then implemented from the accepted plan
  in the next. Then comes the **ghost hour**: every high tide after November 1
  renders one hour late because each station stored a fixed UTC offset
  captured during daylight time. A four-hour marathon reproduces the bug,
  decides on IANA zones, migrates 413 stations with a worker, and pins both DST
  transitions in tests. Two weeks later that decision is revisited: Luxon is
  swapped for `Intl`, which shrinks the bundle by 22 kB.
- **ledgerline**, a Rust budgeting CLI. It gets an OFX importer and a
  wall-of-text catch-up message that becomes a TODO list. Money moves from
  `f64` to integer cents, which also fixes the negative zero bug. Budget
  rollover gets debt lines. A nightly Codex worker runs the bank-fixture suite
  four times, and a Codex session splits the CSV importer into per-bank
  modules using two spawned worker threads.
- **glasshouse**, a greenhouse sensor dashboard. The humidity history has the
  **same ghost hour**: naive local timestamps lose the DST hour. There is also
  a wandering hardware-planning conversation (ESP32-C3 vs Pico W, frost alert
  hysteresis, then tomatoes), two SDK-launched nightly anomaly digests, and a
  shared DST test fixture that both projects adopt.
- **chores**: pruning stale git worktrees, box-drawing characters that render
  double width through a CJK font fallback, a slow zsh prompt, a one-line cargo
  question, a tide-harmonics explainer, and a screenshot rename.

## Where each feature shows

| Feature | Try |
|---|---|
| Cross-harness search | `ghost hour` finds 5 sessions: Claude tidepool, Codex glasshouse, Claude glasshouse. Also try `off by one hour`, `blossom end rot`, `negative zero`, `MKT#4471` |
| Reader | `ghost hour, round two` (tools, two `/compact`s, a worker) |
| Summaries | Every session has a fixture tier-1 summary, so the header reads 0 pending. Story sessions add an anchored outline in the about pane (`ghost hour, round two` has one anchor per episode). The list shows each summary's topic line as the title, so titled sessions such as `ghost hour, round two` keep their name as the first phrase |
| Paragraph spacing | `ledgerline catch-up, BigBank memo…` (opens `ok so here's where I'm at with ledgerline…`): one unbroken message shown as five paragraphs |
| Episodes / about pane | `ghost hour, round two` (marathon, 4 episodes), `glasshouse v2 hardware…` (wanderer, 3), `ledgerline budget rollover` (conversation, 1) |
| Facets / tags rail | 7 facets; `ghost-hour`, `tidepool/service-worker` (nested), and `ledgerline/importer` |
| Human/agent lens | 26 human sessions and 10 agent sessions: 2 Claude subagents, 2 Claude SDK digests, 4 Codex `exec` runs, and 2 Codex spawned threads |
| Chains | `split importers by bank` plus its two spawned workers (a chain of 3) |
| Plan handoff | `station picker redesign plan…` (`I want to redesign the station picker…`), then `station picker build…` (`Implement the following plan: …`) |
| Decision revisited | `Luxon decision revisited…` (`remember we picked luxon for the ghost hour fix?`) |
| Export / continue | Mark a span with `x` … `x`, favorite it with `f`, then `e`: the preview offers `next-session`, and the export copies the `less <payload>` command to the clipboard |

## Fixture boundary

The **archive** (`atlas.db`, including sessions, messages, search, creators,
shapes, and episode spans) comes from the real ingest and provider-free layer
code running over real-format transcripts. The one exception is the
`summaries` table, below.

The **model-derived layers** are hand-authored fixture rows. Atlas normally
fills these with a model call, and the demo makes no provider calls. These
tables carry the fixture rows:

- `message_paragraphs`: paragraph breaks for the wall-of-text message, chosen
  from the same candidate units the paragraph task offers a model.
- `session_episodes.label`: episode names. The spans come from the real
  shape pass; the builder fails if the spans stop matching the story.
- `episode_tags`: facets and kebab-case detail tags. Each passes
  `normalizeTag`.
- `tag_merges`: one merge (`dst-offset-bug` → `ghost-hour`), three nests, and
  two demotions.

The **summaries** are also hand-written. Each of the 36 sessions has one
tier-1 row in `atlas.db`'s `summaries` table: a topic line in the tier-1 shape
(comma-separated phrases, 120 characters or fewer) and a one-to-three-sentence
body. Both restate facts from `demo/story.ts`. They are written as
`summarize` writes them (dialogue-turn coverage, not stale), so a later
`atlas index` keeps them. The 11 story sessions (the ghost-hour sessions,
the Luxon revisit, the station-picker pair, the ledgerline catch-up, rollover,
and importer split, and the glasshouse planning chat) also have a tier-2 row
with `summary_anchors`. Each anchor starts at an authored user message and runs
to the next anchor, in logical-message ordinals, so the about pane shows a
navigable outline labeled `cache/fixture`. The other sessions show their
tier-1 body as an unanchored summary.

Every one of these rows has `model = 'fixture'` (and `source = 'fixture'` in
`tag_merges`). `layer_meta.fixture_layers` and `layer_meta.fixture_summaries`
in `atlas.layers.db` state the boundary.

## Editing the story

`demo/story.ts` is the authored source. `demo/sources/` holds the rendered
Claude Code JSONL and Codex rollout files. After editing the story:

```sh
bun scripts/demo-archive.ts --emit-sources
bun test test/demo-archive.test.ts
```

The build refuses to run if `demo/sources/` has drifted from the story. The
privacy scan checks every built file and every text cell of both databases. It
rejects any `/Users/<name>` path other than `/Users/demo`, `/home/…` and
`/Volumes/…` paths, non-example email addresses, secret-shaped tokens, and the
builder's own home, git name, and git email. Add more strings to reject with
`ATLAS_DEMO_FORBID=a,b`. The build root's own path, which Atlas records as
source locations, is the only exemption, so build somewhere neutral such as
`/tmp/atlas-demo` for anything you publish.
