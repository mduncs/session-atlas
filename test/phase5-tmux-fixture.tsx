import React, { useState } from "react";
import { render, useApp, useInput, useStdout, useWindowSize } from "ink";
import type { Tier2ViewState } from "../src/tier2.js";
import { SessionView, type SessionFacts } from "../src/tui/session-view.js";
import type { TranscriptMode } from "../src/tui/store.js";
import { phase5TranscriptFixture } from "./phase5-fixtures.js";

const facts: SessionFacts = {
  id: 6260,
  harness: "claude",
  nativeId: "fixture-phase5-dialogue",
  title: "Synthetic measured dialogue fixture",
  path: null,
  models: ["fixture-model"],
  tags: ["fixture-tag"],
  chainMembers: 1,
  durationMs: null,
  tokens: { user: 0, assistant: 0, tool: 0 },
};
const summary: Tier2ViewState = { sessionId: 6260, status: "unavailable", reason: "synthetic provider-free tmux fixture" };
const dto = phase5TranscriptFixture();

function Fixture(): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  const width = stdout.columns ?? size.columns ?? 80;
  const height = stdout.rows ?? size.rows ?? 24;
  const [mode, setMode] = useState<TranscriptMode>("dialogue");
  const [wrap, setWrap] = useState(true);
  useInput((input) => {
    if (input === "q") exit();
    else if (input === "1") setMode("dialogue");
    else if (input === "2") setMode("full");
    else if (input === "3") setMode("stubs");
    else if (input === "4") setMode("prose");
    else if (input === "w") setWrap((value) => !value);
  });
  return <SessionView key={`${width}x${height}`} facts={facts} summary={summary} readerTranscript={dto}
    mode={mode} wrap={wrap} roleToggle="all" width={width} height={height}
    traversalPosition={0} traversalTotal={2} message="synthetic DTO fixture · 1/2/3/4 projection · w wrap · q exit" />;
}

const instance = render(<Fixture />, { incrementalRendering: true, maxFps: 60 });
await instance.waitUntilExit();
