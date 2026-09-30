# Atlas library terminal

The opt-in terminal consumes `LibraryReader` and injected `LibraryActions` through
`launchLibrary(reader, actions)`. It uses shipped OpenTUI core 0.5.10 and
string-width 8.2.0, never initializes legacy Ink, and alone owns terminal modes.

Click titles to open; Tab/Enter also activate visible actions. Search, scope,
harness/model/path, My words, individually marked Uncertain origins, Sources,
Librarians and Collections are visible. Back preserves filters and result page.
Sources detects candidates, allows individual explicit inclusion, then capture.

Reader wheel/arrows/page keys scroll by line within messages. Home/End reach
loaded-page edges; continued wheel scrolling loads adjacent 64-passage pages.
Renderable count is bounded by terminal height. Offset-only line layout is
cached across wheel updates and rebuilt on width changes with a source anchor.
Blank lines, indentation, Unicode and original copy bytes are retained. Display
expands tabs, handles CRLF and neutralizes source terminal controls. Selection
uses shared UTF-8 passage slicing, never ordinal addresses.

Visible actions copy conversation/message/selection, save selection/message,
export, and open the summary/finding outline. Outline shows provenance/coverage,
source-backed jumps and correction/undo. Message copy targets the message at
the viewport top. Drag selection works across wrapping and viewport movement
across loaded-page transitions while explicitly selecting; copied/saved ranges use the shared UTF-8 reference service. Fine-grained painted selection highlighting remains a polish limit.
Whole-copy materializes the canonical stream for clipboard delivery; export
writes it incrementally. macOS uses pbcopy; unsupported or failed clipboard
operations explicitly direct the user to export. The installed CLI exports to the selected library’s `exports/` directory; the standalone injected renderer has a Downloads fallback. Save/copy/export errors are surfaced rather
than claiming success prematurely.

T visibly toggles Text selection mode and releases mouse capture; T restores
app interaction. Ctrl-C tears down native modes. Emulator-specific native
selection overrides remain unverified.

## Verification

`bun test test/library-terminal.test.ts test/library-terminal-pty.test.ts`
passes four provider-free synthetic tests: whitespace/grapheme layout; a
100,000-turn reader fixture with a roughly 1 MiB message, bounded 64-passage
loads, 1,000 cached viewport updates and resize anchor; actual shipping mount
with OpenTUI-native mock mouse open/wheel/exact-copy/back; and actual launch in
an isolated background PTY checking Atlas output, alternate-screen entry/exit,
mouse-disable sequence and exit zero after Ctrl-C. The PTY fixture is created
and removed under an explicit temporary path. No live archive, foreground GUI,
or real clipboard is touched by tests.

This is not physical trackpad/paint/OS clipboard/tmux/cross-platform acceptance,
and not a production cutover certification. Shared-store integration additionally verifies cross-page selection/copy/save and bidirectional hit context. See the revamp terminal plan for remaining physical acceptance gates.
