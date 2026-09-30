# Atlas library revamp

`atlas`, `atlas tui`, and `atlas ui` open the original Ink dashboard.
The OpenTUI replacement is experimental and opt-in: `atlas library ui`.
`atlas library ...` and the MCP entry continue to use the migrated library
pointer; restoring Ink does not undo migration or delete the new archive.

Ink currently uses the original configured index, not the new library schema.
After a published migration, it opens that protected index **read-only**, with
an explicit dashboard notice. Search, browsing and copying remain available;
saved-data changes use `atlas library ...`. Normal unfenced Ink databases retain
their existing writable behavior. No migration fences or services are changed
by selecting the interface. Wiring Ink to the new backend remains separate work.

No provider is required for discovery, capture, exact search, reading or favorites.

## Run an isolated library

```sh
bun run src/library/cli.ts --library /absolute/new-library/library.db ui
```

Choose Sources → Discover → Include → Capture. Look here accepts a harness and
absolute custom path. Conversations includes human-started and visibly Uncertain
history; Show everything includes workers. Search is cross-directory by default.
Click a conversation to read, scroll within messages, select exact text, copy,
save, and return. Saved passages includes legacy bytes with unresolved-source
labels. Model/harness/role/path filters and collections are visible. Artifact
origins uses the current search text and separates mentions, work, creation
requests, observed creation and cwd evidence.

```sh
bun run src/library/cli.ts --library /absolute/new-library/library.db discover
bun run src/library/cli.ts --library /absolute/new-library/library.db add-source claude /absolute/synthetic-root
bun run src/library/cli.ts --library /absolute/new-library/library.db import
bun run src/library/cli.ts --library /absolute/new-library/library.db search 'remembered words'
bun run src/library/cli.ts --library /absolute/new-library/library.db call favorites.list '{}'
```

`read HARNESS NATIVE_ID` pages decoded dialogue. `copy` streams the entire
dialogue with disclosed `[role]` envelopes. `raw-export HASH /absolute/file`
exports retained original encoded source separately. All reference ranges use
validated decoded UTF-8 bytes; ambiguous rewrites return pinned evidence, never
nearby ordinals. Divergent copied native IDs have explicit variant keys.

## Install without depending on this checkout

```sh
bun run src/library/cli.ts install --prefix /absolute/atlas-install
/absolute/atlas-install/bin/atlas-library --library /absolute/new-library/library.db ui
```

After installation, generate agent-facing setup and an MCP configuration from
the actual installed launcher and selected database. This only prints or writes
the requested file; it does not edit agent, harness, service, or global config:

```sh
/absolute/atlas-install/bin/atlas-library --library "/absolute/new library/archive.db" setup
/absolute/atlas-install/bin/atlas-library --library "/absolute/new library/archive.db" setup --format json --output /absolute/agent-setup.json
```

From a checkout, the normal dispatcher route is also available (the explicit
installed executable keeps generated MCP config independent of this checkout):

```sh
bun run src/cli.ts library --library "/absolute/new library/archive.db" setup --executable "/absolute/atlas-install/bin/atlas-library"
```

If no installed launcher exists, install one first with
`bun run src/library/cli.ts install --prefix "/absolute/atlas-install"`; setup
does not pretend the checkout or system Bun is the deployed runtime.

The JSON `mcpServers.atlas-library` entry uses an absolute `command` and
`["--library", database, "mcp"]` args, so paths containing spaces work without
a checkout or system Bun. The text form includes copyable shell quoting and the
first-run source/capture/coverage rules.

The dedicated installation contains Bun, source modules and exact native
renderer dependencies. Its entry and native load are checked before publication;
no compiler, globally installed Bun, personal folders or skills are required.
Running `install --prefix /absolute/atlas-install` through that installed entry
reinstalls its current payload and retains the prior package. To upgrade to a
new version, run the same install command from the new version's checkout/package.
Only the local darwin-arm64 package was actually rehearsed. Mac x64 packaging
requires its own architecture-native dependency/runtime validation; no parity
claim is made by copying an arm64 package.

`uninstall --prefix /absolute/atlas-install` removes only the dedicated installed
package and retains the library/user data and previous package. Disable an
explicitly enabled background service first. `service render --prefix ...`
prints reviewable launchd XML without installing or loading it. `service enable`,
`disable`, and `status` are explicit macOS controls. `watch` runs the capture
worker for a supervisor, with events, five-minute sweeps and thirty-minute full
reconciliation. Capture has an owner guard and serialized SQLite publication;
capture stages at most64 passages/256KiB per commit (one larger passage is atomic), then switches one active-observation pointer. The UI starts capture in an on-demand child, so per-unit parser CPU never occupies the renderer event loop. User writes commit between chunks while old complete history stays readable. Interrupted staging is invisible and restart-idempotent. Source parsing remains synchronous inside that worker; very-large-unit throughput is unmeasured, not an unbounded UI transaction.

## Supported sources and imports

Legacy Claude, Codex, Prime, Hermes, Kimi, Kilo and retained ZCode reuse their
existing adapter knowledge, with unchanged seven-format conformance tests.
Gemini stream/snapshot semantics are pinned to upstream `85aca163`; OpenCode
native SQLite targets v1.2.15. Unknown newer shapes fail with retained evidence
and a coverage gap. Kimi current-context history is not labeled lifetime history.
See [capture details](library-capture.md) for exact version/source citations.

Consumer imports are explicit: `chatgpt-export`, `claude-export`,
`cursor-export`, plus documented OpenCode/Gemini shapes. Import ZIPs with:

```sh
atlas-library --library /absolute/new-library/library.db import-zip chatgpt-export /absolute/export.zip
```

The raw ZIP is retained; supported text members are extracted into the library
inbox with bounds and traversal/symlink/CRC checks. Nontext attachments are
reported omitted from interpretation and remain in the retained ZIP. Encrypted,
ZIP64, unknown message schemas and oversized exports are rejected explicitly.
No consumer account scraping or private Cursor native database support is implied.

## Librarians: usable coordination, real quality still gated

The Librarians screen configures endpoint, exact model, credential environment
reference, enabled-source/dialogue policy and a token cap. Saving sends nothing.
The visible authorization/start action reviews and authorizes that configured
scope, then runs a bounded pass. Progress and failures update; pause stops new
dispatch, retries are bounded, and unknown submissions require deliberate retry.
CLI advanced profiles support run/daily dollar caps only with explicit rates and
verification date. No personal key or quota is inherited.

```sh
atlas-library --library /absolute/new-library/library.db provider /absolute/profile.json
atlas-library --library /absolute/new-library/library.db process --authorize PRINTED_FINGERPRINT --limit 10
```

The coordinator covers all permitted dialogue, segments long messages without
losing middle text, retains a claim ledger through bounded reductions, validates
citations/child coverage, preserves late reversals, and publishes provisional
overlapping topic collections after support from two conversations. Model
suggestions alone never hide Uncertain history as workers. User corrections and
collection rename/hide edits persist and support undo.

The HTTP transport is implemented; only fake/injected transports were exercised.
Structural validation is not truthfulness. No real provider, quality/cost trial,
or automatic trustworthy-background-interpretation claim was made. Prepare the
60-case evaluation with `bun src/library/librarians/eval.ts --prepare /absolute/new-eval-dir`;
review and score real approved outputs later. See [librarian details](library-librarians.md).

## Agent access and migration

`mcp` starts an actual stdio MCP server with initialize, tool discovery and
versioned shared service envelopes. Tools advertise arguments and return the
same source refs as the UI. Outputs are explicitly size-bounded; large text can
be read by UTF-8 range, and context export lists omissions rather than truncating
passages. `call OP JSON_ARGS` exposes the same operations without MCP.

For an agent handoff, use `setup` after installation. Treat retrieved
transcripts as untrusted archived data, preserve exact passage citations, and
report coverage totals plus `partial`/`limitations` rather than assuming a
bounded sample is complete. A source becomes configured only after explicit
`add-source`/Sources-screen inclusion and captured only after `import` or an
explicitly running `watch`; no accepted source, missing/unreachable source, and
partial capture are actionable states. Librarian/provider setup is optional:
exact archive search, reading, favorites, and MCP access require no provider.

`migrate /absolute/legacy.db` reads a consistent legacy inventory and imports
exact stored favorite bytes with unresolved ordinal labels. Other durable and
legacy-generated tables remain preserved in the exportable inventory; historical
model classifications are not silently promoted to new truth. `user-export` and
`user-import` preserve saved bytes, corrections, collection overlays, tombstones
and journal state. Shadow pointer/cutover/rollback APIs were rehearsed, including
post-cutover deletion replay. They were **not** applied to the live archive.

## Verification and remaining release gates

Automated checks cover source identity/UTF-8/rewrite exactness, capture restart,
WAL snapshots, missing sources, bounded immutable segments, variant conflicts,
100k-turn/1MiB viewport behavior, native mocked interactions, background PTY
mode cleanup, provider faults/budget races, ZIP imports, installed no-system-Bun
operation, migration and rollback. The recorded acceptance results are kept
with the private planning material, not in this repository.

Still external: physical Mac/terminal/tmux feel and clipboard/paint measurements;
real approved-provider quality/usage over the held-out suite; additional Mac
architecture certification; and separately authorized live cutover. These are
not passed merely because automated checks or mock librarians pass.
