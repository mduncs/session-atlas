import type { Config, LauncherConfig } from "../config.js";
import type { DB } from "../db/index.js";
import {
  previewExport,
  writeExport,
  type ExportCompileOptions,
  type ExportPreview,
  type ExportScope,
  type WrittenExport,
} from "../export.js";

export type ExportLauncherChoice =
  | { kind: "none"; name: null; label: string }
  | { kind: "launcher"; name: string; label: string; launcher: LauncherConfig };

export type ExportFlowState =
  | { kind: "idle" }
  | {
      kind: "preview";
      preview: ExportPreview;
      compressionNeeded: boolean;
      choices: ExportLauncherChoice[];
    }
  | { kind: "writing"; preview: ExportPreview; choice: ExportLauncherChoice }
  | { kind: "complete"; preview: ExportPreview; choice: ExportLauncherChoice; written: WrittenExport }
  | { kind: "cancelled"; preview: ExportPreview | null }
  | { kind: "failed"; preview: ExportPreview; choice: ExportLauncherChoice; error: Error };

export interface ExportFlowDeps {
  preview?: typeof previewExport;
  write?: typeof writeExport;
}

export interface ExportFlowRequest {
  scope: ExportScope;
  options?: Omit<ExportCompileOptions, "launcher"> & { outputDir?: string; now?: Date };
}

/**
 * Two-step export controller for TUI surfaces. `begin()` is read-only and
 * `confirm()` is the sole write edge. A controller represents one request,
 * which makes double-confirmation and cancel/write races impossible.
 */
export class ExportFlowController {
  private stateValue: ExportFlowState = { kind: "idle" };
  private readonly previewFn: typeof previewExport;
  private readonly writeFn: typeof writeExport;
  private request: ExportFlowRequest | null = null;
  private confirmPromise: Promise<ExportFlowState> | null = null;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    deps: ExportFlowDeps = {},
  ) {
    this.previewFn = deps.preview ?? previewExport;
    this.writeFn = deps.write ?? writeExport;
  }

  get state(): ExportFlowState {
    return this.stateValue;
  }

  /** Compute exact pass-1/floor evidence without creating an export file. */
  begin(request: ExportFlowRequest): Extract<ExportFlowState, { kind: "preview" }> {
    if (this.stateValue.kind !== "idle") {
      throw new Error("export flow has already started");
    }
    const preview = this.previewFn(this.db, this.config, request.scope, request.options);
    this.request = request;
    const state: Extract<ExportFlowState, { kind: "preview" }> = {
      kind: "preview",
      preview,
      compressionNeeded: preview.predictedTokens > preview.budget,
      choices: launcherChoices(this.config.launchers),
    };
    this.stateValue = state;
    return state;
  }

  /** Cancel before confirmation. This transition never writes. */
  cancel(): ExportFlowState {
    if (this.stateValue.kind === "writing" || this.stateValue.kind === "complete") {
      return this.stateValue;
    }
    if (this.stateValue.kind === "cancelled") return this.stateValue;
    const preview = this.stateValue.kind === "preview" || this.stateValue.kind === "failed"
      ? this.stateValue.preview
      : null;
    this.stateValue = { kind: "cancelled", preview };
    return this.stateValue;
  }

  /**
   * Write exactly once, optionally binding a configured launcher. Repeated
   * confirmations share the same promise and therefore the same output path.
   */
  confirm(launcherName: string | null): Promise<ExportFlowState> {
    if (this.confirmPromise) return this.confirmPromise;
    if (this.stateValue.kind === "cancelled") {
      return Promise.reject(new Error("export was cancelled before confirmation"));
    }
    if (this.stateValue.kind !== "preview" || !this.request) {
      return Promise.reject(new Error("export must be previewed before confirmation"));
    }
    const choice = resolveChoice(this.stateValue.choices, launcherName);
    const preview = this.stateValue.preview;
    const request = this.request;
    this.stateValue = { kind: "writing", preview, choice };
    this.confirmPromise = this.writeFn(this.db, this.config, request.scope, {
      ...request.options,
      launcher: choice.kind === "launcher" ? choice.name : undefined,
    }).then(
      (written) => {
        this.stateValue = { kind: "complete", preview, choice, written };
        return this.stateValue;
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.stateValue = { kind: "failed", preview, choice, error };
        return this.stateValue;
      },
    );
    return this.confirmPromise;
  }
}

export function launcherChoices(launchers: LauncherConfig[]): ExportLauncherChoice[] {
  return [
    { kind: "none", name: null, label: "Export only" },
    ...launchers.map((launcher) => ({
      kind: "launcher" as const,
      name: launcher.name,
      label: launcher.name,
      launcher,
    })),
  ];
}

function resolveChoice(choices: ExportLauncherChoice[], name: string | null): ExportLauncherChoice {
  const choice = choices.find((candidate) => candidate.name === name);
  if (!choice) throw new Error(`unknown export launcher '${name ?? "none"}'`);
  return choice;
}
