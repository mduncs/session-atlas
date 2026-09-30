import type { LibraryReader, LibrarySession, Passage, PassageRef, QueryScope, ReadPage, SessionKey, Origin, SourceEntry } from "../contracts";
import { selectPassage, selectionBytes } from "../passages";
import { displayText, layoutPassages, offsetAt, type Line } from "./layout";

export interface LibraryActions {
  saveFavorite?: (input: { sessionKey: SessionKey; refs?: PassageRef[]; note?: string; idempotencyKey?: string }) => unknown;
  correctClassification?: (key: SessionKey, origin: Origin) => unknown;
  undo?: (id: string) => unknown;
  removeFavorite?: (id: string) => unknown;
  discoverSources?: () => SourceEntry[] | Promise<SourceEntry[]>;
  acceptSources?: (sources: SourceEntry[]) => unknown;
  reconcile?: () => unknown;
  cancelCapture?: () => unknown;
  configureProvider?: (input: { endpoint: string; model: string; credentialEnv: string; runTokenCap: number }) => unknown;
  authorizeProcessing?: () => unknown;
  addSource?: (harness: string, root: string) => unknown;
  editCollection?: (id: string, patch: { title?: string; hidden?: boolean; pinned?: boolean }) => unknown;
  processing?: () => unknown;
  processingControl?: (action: "pause" | "resume" | "retry") => unknown;
  artifactFind?: (query: string) => unknown;
  clipboard?: (text: string) => Promise<void>;
  exportConversation?: (key: SessionKey) => Promise<string>;
}
export interface FrameRow { text: string; action?: () => void; kind?: "title" | "muted" | "action"; line?: Line }
export class LibraryController {
  width = 80;
  height = 24;
  screen: "library" | "reader" | "sources" | "processing" | "outline" | "collections" | "artifacts" | "favorites" = "library";
  scope: QueryScope = { view: "conversations" };
  query = "";
  editing: "search" | "harness" | "model" | "path" | "providerEndpoint" | "providerModel" | "credentialEnv" | "runTokenCap" | "sourceHarness" | "sourceRoot" | "collectionTitle" | null = null;
  input = "";
  providerForm = { providerEndpoint: "", providerModel: "", credentialEnv: "", runTokenCap: "100000" };
  sourceForm = { sourceHarness: "", sourceRoot: "" };
  collectionTarget: string | null = null;
  artifactResults: unknown = null;
  status = "";
  /** Keep the primary collection controls out of the conversation viewport until requested. */
  filtersOpen = false;
  discovered: SourceEntry[] = [];
  undoId: string | null = null;
  sessions: LibrarySession[] = [];
  hits = new Map<string, PassageRef>();
  listCursor: string | null = null;
  listHistory: (string | undefined)[] = [undefined];
  page: ReadPage | null = null;
  lines: Line[] = [];
  top = 0;
  private cursors: (string | undefined)[] = [undefined];
  private contextAnchor: PassageRef | null = null;
  private selection: { a: { passage: Passage; offset: number }; b: { passage: Passage; offset: number } } | null = null;
  private selectedPages = new Map<string, Passage>();
  private hitRefs: (PassageRef | undefined)[] = [];
  onChange = () => {};
  constructor(readonly reader: LibraryReader, readonly actions: LibraryActions = {}) { this.refresh(); }
  refresh(): void {
    const cursor = this.listHistory.at(-1);
    if (this.query) {
      const result = this.reader.search(this.query, this.scope, 12, cursor);
      this.sessions = result.hits.map(h => h.session); this.hitRefs = result.hits.map(h => h.passage?.ref);
      this.hits.clear(); result.hits.forEach(h => { if (h.passage) this.hits.set(JSON.stringify(h.session.key), h.passage.ref); });
      this.listCursor = result.nextCursor;
      this.status = result.coverage.limitations.join(" · ");
    } else { const result = this.reader.list(this.scope, 12, cursor); this.sessions = result.sessions; this.listCursor = result.nextCursor; this.hits.clear(); this.hitRefs = []; }
  }
  async run(work: () => unknown): Promise<void> {
    try { await work(); } catch (error) { this.status = `Failed: ${error instanceof Error ? error.message : String(error)}`; }
    this.onChange();
  }
  open(session: LibrarySession, exactRef?: PassageRef): void {
    this.selection = null; this.selectedPages.clear();
    this.cursors = [undefined]; this.contextAnchor = null; this.top = 0;
    const ref = exactRef ?? this.hits.get(JSON.stringify(session.key));
    this.install(ref ? this.reader.context(ref, 4, 60) : this.reader.read(session.key, 64));
    this.screen = "reader";
    if (ref) this.jump(ref);
  }
  install(page: ReadPage): void { this.page = page; if (this.selection) page.passages.forEach(p => this.selectedPages.set(p.ref, p)); this.lines = layoutPassages(page.passages, this.width - 4); }
  resize(width: number, height: number): void {
    const anchor = this.lines[this.top]; const changed = this.width !== width; this.width = width; this.height = height;
    if (this.page && changed) {
      this.lines = layoutPassages(this.page.passages, width - 4);
      if (anchor) this.top = Math.max(0, this.lines.findLastIndex(l => l.passage === anchor.passage && l.start <= anchor.start));
    }
  }
  get viewportHeight(): number { return Math.max(1, this.height - 9); }
  scroll(delta: number): void {
    if (this.screen !== "reader" || !this.page) return;
    const next = this.top + delta;
    if (next >= this.lines.length && this.page.nextCursor) {
      this.cursors.push(this.page.nextCursor); this.install(this.reader.read(this.page.session.key, 64, this.page.nextCursor)); this.top = 0;
    } else if (next < 0 && this.cursors.length > 1) {
      this.cursors.pop(); this.install(this.reader.read(this.page.session.key, 64, this.cursors.at(-1))); this.top = Math.max(0, this.lines.length - this.viewportHeight);
    } else if (next < 0 && this.contextAnchor && this.page.passages[0]) {
      const first = this.page.passages[0]; const previous = this.reader.context(first.ref, 50, 0);
      if (previous.passages[0]?.ref !== first.ref) { this.install(previous); this.top = Math.max(0, this.lines.length - this.viewportHeight); }
      else this.top = 0;
    } else this.top = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), next));
  }
  jump(ref: PassageRef): void {
    const resolved = this.reader.resolve(ref);
    if (!resolved.passage) { this.status = resolved.reason ?? "Passage unavailable"; return; }
    this.contextAnchor = ref;
    this.install(this.reader.context(ref, 4, 50));
    this.top = Math.max(0, this.lines.findIndex(l => this.page!.passages[l.passage]?.record === resolved.passage!.record && !l.header)); this.screen = "reader";
    this.status = resolved.status === "pinned" ? "Pinned source evidence (not current revision)" : "Source-backed passage";
  }
  select(row: number, column: number, extend = false): void {
    const line = this.lines[this.top + row]; if (!line || line.header || !this.page) return;
    const point = { passage: this.page.passages[line.passage]!, offset: offsetAt(this.page.passages[line.passage]!.text, line, column) };
    if (extend && this.selection) this.selection.b = point;
    else { this.selection = { a: point, b: point }; this.selectedPages.clear(); }
    this.page.passages.forEach(p => this.selectedPages.set(p.ref, p));
    this.status = "Selection ready · Copy selection";
  }
  private selectedPassages(): Passage[] {
    if (!this.selection) return [];
    let { a, b } = this.selection;
    if (a.passage.ordinal > b.passage.ordinal || (a.passage.ref === b.passage.ref && a.offset > b.offset)) [a, b] = [b, a];
    const ordered = [...this.selectedPages.values()].filter(p => p.observationId === a.passage.observationId && p.ordinal >= a.passage.ordinal && p.ordinal <= b.passage.ordinal).sort((x, y) => x.ordinal - y.ordinal);
    return ordered.map(p => selectPassage(p, ...selectionBytes(p.text, p.ref === a.passage.ref ? a.offset : 0, p.ref === b.passage.ref ? b.offset : p.text.length)));
  }
  selectedRefs(): PassageRef[] { return this.selectedPassages().map(p => p.ref); }
  selectedText(): string { return this.selectedPassages().map(p => p.text).join("\n\n"); }
  async correct(origin: Origin): Promise<void> {
    if (!this.actions.correctClassification || !this.page) throw new Error("Correction unavailable");
    const result = await this.actions.correctClassification(this.page.session.key, origin);
    this.undoId = typeof result === "string" ? result : null;
    this.status = "Origin corrected"; this.refresh();
  }
  currentPassage(): Passage | undefined { return this.page?.passages[this.lines[this.top]?.passage ?? 0]; }
  async copy(kind: "conversation" | "message" | "selection"): Promise<void> {
    const text = kind === "conversation" && this.page ? Array.from(this.reader.streamCopy(this.page.session.key)).join("") : kind === "message" ? this.currentPassage()?.text ?? "" : this.selectedText();
    if (!text) throw new Error("Nothing selected");
    if (!this.actions.clipboard) throw new Error("Clipboard unavailable. Use Export conversation.");
    await this.actions.clipboard(text); this.status = `Copied ${kind}`;
  }
  filter(field: "search" | "harness" | "model" | "path"): void { this.editing = field; this.input = field === "search" ? this.query : this.scope[field] ?? ""; }
  submit(): void {
    if (this.editing && this.editing in this.providerForm) { this.providerForm[this.editing as keyof typeof this.providerForm] = this.input; this.editing = null; return; }
    if (this.editing && this.editing in this.sourceForm) { this.sourceForm[this.editing as keyof typeof this.sourceForm] = this.input; this.editing = null; return; }
    if (this.editing === "collectionTitle") { const id = this.collectionTarget; this.editing = null; if (id && this.actions.editCollection) void this.run(async () => { const result = await this.actions.editCollection!(id, { title: this.input }); this.undoId = typeof result === "string" ? result : null; }); return; }
    if (this.editing === "search") this.query = this.input;
    else if (this.editing && ["harness", "model", "path"].includes(this.editing)) this.scope[this.editing as "harness" | "model" | "path"] = this.input || undefined;
    this.editing = null; this.listHistory = [undefined]; this.refresh();
  }
  frame(): FrameRow[] {
    const rows: FrameRow[] = [];
    const add = (text: string, action?: () => void, kind?: FrameRow["kind"]) => rows.push({ text, action, kind });
    const act = (text: string, work: () => unknown) => add(text, () => { void this.run(work); }, "action");
    add(`Atlas  /  ${this.screen === "reader" ? this.page?.session.title : this.screen}`, undefined, "title");
    if (this.editing) {
      add(`Editing ${this.editing}: ${this.input || "(type to search)"}▏`, undefined, "title");
      add("Enter apply · Esc cancel · text input active", undefined, "muted");
    }
    if (this.screen !== "library") act("‹ Library", () => { this.screen = "library"; });
    if (this.screen === "library") {
      // These destinations stay at the top of the main view so a short
      // terminal never requires scrolling past the conversation list to find
      // the rest of the library.
      act("Library", () => { this.screen = "library"; });
      act("Sources", () => { this.screen = "sources"; });
      act("Librarians", () => { this.screen = "processing"; });
      act("Collections", () => { this.screen = "collections"; });
      act("Saved passages", () => { this.screen = "favorites"; });
      act(`Search  ${this.query || "all conversations…"}`, () => this.filter("search"));
      act(`${this.filtersOpen ? "▾" : "▸"} Filters${this.filtersOpen ? " · click to collapse" : " · optional"}`, () => { this.filtersOpen = !this.filtersOpen; });
      if (this.filtersOpen) {
        act(`${this.scope.view === "everything" ? "● Show everything" : "● Conversations"}  · click to switch`, () => { this.scope.view = this.scope.view === "everything" ? "conversations" : "everything"; this.listHistory = [undefined]; this.refresh(); });
        act("Direct-only / clear all restrictions", () => { this.scope = this.scope.view === "direct" ? { view: "conversations" } : { view: "direct" }; this.listHistory = [undefined]; this.refresh(); });
        act(`Harness: ${this.scope.harness || "All"}`, () => this.filter("harness"));
        act(`Model: ${this.scope.model || "All"}`, () => this.filter("model"));
        act(`Words: ${this.scope.role === "user" ? "My words" : "Everyone"}`, () => { this.scope.role = this.scope.role ? undefined : "user"; this.listHistory = [undefined]; this.refresh(); });
        act(`Path: ${this.scope.path || "Any"}`, () => this.filter("path"));
      }
      const visible = this.sessions.slice(0, Math.max(1, Math.floor((this.height - 13) / 2)));
      for (const [index, session] of visible.entries()) {
        act(`${(session.origin === "unknown" || session.origin === "mixed") ? "Uncertain · " : session.origin === "worker" ? "Worker · " : ""}${session.title}`, () => this.open(session, this.hitRefs[index]));
        add(`  ${session.key.harness} · ${session.models.join(", ") || "model unknown"} · ${session.summary?.overview || session.originReason}`, undefined, "muted");
      }
      if (!visible.length) {
        add("No conversations in this scope. Change filters or inspect Sources.");
        // An empty library needs a concrete first-run affordance. Keep it in
        // the same click/Tab action stream as every other navigation target.
        act("Get started · choose Sources and capture", () => { this.screen = "sources"; });
      }
      act("More results →", () => {
        // Advance only by the number visible, not an invisible twelve-result page.
        const limit = Math.max(1, Math.floor((this.height - 13) / 2));
        const cursor = this.listHistory.at(-1);
        const page = this.query ? this.reader.search(this.query, this.scope, limit, cursor) : this.reader.list(this.scope, limit, cursor);
        if (page.nextCursor) { this.listHistory.push(page.nextCursor); this.refresh(); }
      });
      act("← Previous results", () => { if (this.listHistory.length > 1) { this.listHistory.pop(); this.refresh(); } });
      act("Artifact origins for search text", async () => { if (!this.actions.artifactFind || !this.query) throw new Error("Enter a path/name in Search first"); this.artifactResults = await this.actions.artifactFind(this.query); this.screen = "artifacts"; });
    } else if (this.screen === "reader" && this.page) {
      act("Copy conversation [role] envelopes", () => this.copy("conversation"));
      act("Copy message", () => this.copy("message"));
      act("Copy selection", () => this.copy("selection"));
      act("Save selection / message", async () => { if (!this.actions.saveFavorite) throw new Error("Saving unavailable"); await this.actions.saveFavorite({ sessionKey: this.page!.session.key, refs: this.selectedRefs().length ? this.selectedRefs() : [this.currentPassage()!.ref] }); this.status = "Saved message"; });
      act("Summary / finding outline", () => { this.screen = "outline"; });
      act("Export conversation", async () => { if (!this.actions.exportConversation) throw new Error("Export unavailable"); this.status = `Exported: ${await this.actions.exportConversation(this.page!.session.key)}`; });
      for (const line of this.lines.slice(this.top, this.top + this.viewportHeight)) {
        const passage = this.page.passages[line.passage]!;
        rows.push({ text: line.header ? `${passage.role}  · ${passage.ordinal + 1}` : displayText(passage.text.slice(line.start, line.end)), kind: line.header ? "muted" : undefined, line });
      }
    } else if (this.screen === "outline") {
      act("‹ Reading", () => { this.screen = "reader"; });
      act("Correct origin: Human-started", async () => { await this.correct("human_started"); });
      act("Correct origin: Worker", async () => { await this.correct("worker"); });
      if (this.undoId) act("Undo origin correction", async () => { if (!this.actions.undo) throw new Error("Undo unavailable"); await this.actions.undo(this.undoId!); this.undoId = null; this.status = "Correction undone"; this.refresh(); });
      const summary = this.page?.session.summary;
      add(summary ? `${summary.provenance} · ${summary.coverage.covered.length} covered refs · ${summary.coverage.omitted.length} omissions` : "No summary yet. The complete conversation remains readable.");
      if (summary) { add(summary.overview); for (const claim of summary.claims) act(`${claim.kind}: ${claim.text}`, () => { if (claim.refs[0]) this.jump(claim.refs[0]); }); }
    } else if (this.screen === "sources") {
      for (const field of ["sourceHarness", "sourceRoot"] as const) act(`${field === "sourceHarness" ? "Look here: harness" : "Absolute source path"}: ${this.sourceForm[field] || "click to enter"}`, () => { this.editing = field; this.input = this.sourceForm[field]; });
      act("Include custom source", async () => { if (!this.actions.addSource) throw new Error("Custom source unavailable"); await this.actions.addSource(this.sourceForm.sourceHarness, this.sourceForm.sourceRoot); this.status = "Custom source included; capture when ready"; });
      act("Discover local sources", async () => { if (!this.actions.discoverSources) throw new Error("Discovery unavailable"); this.discovered = await this.actions.discoverSources(); this.status = "Detected sources below; click a source to include it"; });
      for (const source of this.discovered) act(`Include ${source.harness}: ${source.root}`, async () => { if (!this.actions.acceptSources) throw new Error("Source selection unavailable"); await this.actions.acceptSources([source]); this.discovered = this.discovered.filter(s => s.id !== source.id); this.status = "Source included"; });
      act("Capture / reconcile included sources", async () => { if (!this.actions.reconcile) throw new Error("Capture unavailable"); this.status = "Capturing…"; this.onChange(); await this.actions.reconcile(); this.refresh(); this.status = "Capture finished"; });
      act("Stop current capture (retained data kept)", async () => { this.actions.cancelCapture?.(); this.status = "Capture stop requested; prior complete revision stays readable"; });
      for (const source of this.reader.sources()) add(`${source.harness}: ${source.root} · ${source.reachable ? "reachable" : "unreachable"} · ${source.enabled ? "enabled" : "disabled"}${source.error ? ` · ${source.error}` : ""}`);
      const coverage = this.reader.coverage();
      for (const obs of coverage.observations) add(`Retained ${obs.retainedBoundary.bytes} B · searchable ${obs.indexedBoundary?.bytes ?? 0} B · summarized ${obs.summaryCoverage?.covered.length ?? 0} refs`);
      coverage.limitations.forEach(t => add(t));
    } else if (this.screen === "processing") {
      const processing = this.actions.processing?.();
      for (const field of ["providerEndpoint", "providerModel", "credentialEnv", "runTokenCap"] as const) act(`${field}: ${this.providerForm[field] || "click to enter"}`, () => { this.editing = field; this.input = this.providerForm[field]; });
      add("Policy: enabled sources · user + assistant dialogue · standard redaction · run/day token cap as entered", undefined, "muted");
      act("Save provider and policy (no request sent)", async () => { if (!this.actions.configureProvider) throw new Error("Provider setup unavailable"); const result = await this.actions.configureProvider({ endpoint: this.providerForm.providerEndpoint, model: this.providerForm.providerModel, credentialEnv: this.providerForm.credentialEnv, runTokenCap: Number(this.providerForm.runTokenCap) }); this.status = JSON.stringify(result); });
      act("Authorize displayed provider/policy and start 10 conversations", async () => { if (!this.actions.authorizeProcessing) throw new Error("Processing unavailable"); this.status = "Processing selected history…"; this.onChange(); await this.actions.authorizeProcessing(); this.status = "Processing pass finished; inspect phase/failures below"; this.refresh(); });
      if (processing) for (const line of JSON.stringify(processing, null, 2).split("\n")) add(line);
      else add("No provider configured. Capture and reading remain available.");
      for (const action of ["pause", "resume", "retry"] as const) act(action, async () => { if (!this.actions.processingControl) throw new Error("Processing controls unavailable"); await this.actions.processingControl(action); this.status = `${action} requested`; });
    } else if (this.screen === "favorites") {
      for (const favorite of this.reader.favorites()) {
        add(`${favorite.note || favorite.sessionKey.nativeId}${favorite.unresolved ? " · legacy span unresolved; saved bytes preserved" : ""}`, undefined, "title");
        for (const line of favorite.text.split("\n")) add(displayText(line));
        act("Copy saved bytes", async () => { if (!this.actions.clipboard) throw new Error("Clipboard unavailable"); await this.actions.clipboard(favorite.text); this.status = "Copied exact saved bytes"; });
        if (favorite.refs[0]) act("Open source passage", () => this.jump(favorite.refs[0]!));
        act("Remove favorite", async () => { if (!this.actions.removeFavorite) throw new Error("Remove unavailable"); const receipt = await this.actions.removeFavorite(favorite.id); this.undoId = typeof receipt === "string" ? receipt : null; });
      }
      if (this.undoId) act("Undo removal", async () => { if (this.actions.undo) await this.actions.undo(this.undoId!); this.undoId = null; });
    } else if (this.screen === "artifacts") {
      for (const line of JSON.stringify(this.artifactResults, null, 2).split("\n")) add(line);
    } else if (this.screen === "collections") {
      for (const collection of this.reader.collections().filter(c => !c.hidden)) { act(`${collection.title}${collection.provisional ? " · proposed" : ""}`, () => { this.scope.collection = collection.id; this.listHistory = [undefined]; this.screen = "library"; this.refresh(); });
        act(`Rename ${collection.title}`, () => { this.collectionTarget = collection.id; this.editing = "collectionTitle"; this.input = collection.title; });
        act(`Hide ${collection.title}`, async () => { if (!this.actions.editCollection) throw new Error("Collection edits unavailable"); const result = await this.actions.editCollection(collection.id, { hidden: true }); this.undoId = typeof result === "string" ? result : null; });
      }
      if (this.undoId) act("Undo collection change", async () => { if (this.actions.undo) await this.actions.undo(this.undoId!); this.undoId = null; });
    }
    return rows;
  }
}
