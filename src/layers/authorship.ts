import { readFileSync } from "node:fs";

/**
 * Who wrote a user-side record, and who started a session.
 *
 * Harnesses put three different things in the user role: what md typed, what
 * another agent sent (parent/sibling/teammate/supervisor prompts), and what the
 * harness injected (plugin lists, AGENTS.md, goal context, hook feedback, skill
 * bodies, notifications). Only the first is md. The patterns below come from a
 * census of the live corpus (2026-09-28), not from guesses.
 */

export type UserAuthor = "human" | "agent" | "harness";
export interface AuthorVerdict { author: UserAuthor; rule: string }

const HARNESS_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^<(recommended_plugins|codex_internal_context|goal_context|environment_context|user_instructions|system-reminder|subagent_notification|task-notification|local-command-(stdout|stderr|caveat)|turn_aborted|user_shell_command|skill|INSTRUCTIONS)\b/, "harness:envelope"],
  [/^# AGENTS\.md instructions\b/, "harness:agents-md"],
  [/^Base directory for this skill:/, "harness:skill-body"],
  [/^(Stop|PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|SubagentStop|Notification) hook (feedback|error|output)/i, "harness:hook"],
  [/^Tool loaded\.\s*$/, "harness:tool-loaded"],
  [/^Caveat: The messages below were generated/, "harness:caveat"],
  [/^This session is being continued from a previous conversation/, "harness:compaction"],
  [/^Your task is to create a detailed summary of the conversation/, "harness:compaction"],
  [/^The following is the Codex agent history/, "harness:inherited-history"],
  [/^Continue from where you left off\.?\s*$/, "harness:resume"],
  [/^## Context Usage\b/, "harness:command-output"],
  [/^## Context\s*\n+- Current git status/, "harness:command-expansion"],
  [/^# Autonomous loop check\b/, "harness:loop"],
  [/^\d+ background agents? (was|were) stopped by the user/, "harness:agents-stopped"],
];

const AGENT_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\[(from|task from) (parent|sibling|child|supervisor)\b[^\]]*\]/, "agent:relay"],
  [/^<(teammate-message|agent-message|fork-boilerplate)\b/, "agent:teammate"],
  [/^Another Claude session sent a message:/, "agent:peer-session"],
  [/^⏰/, "agent:scheduled"],
  [/^Review this change for security vulnerabilities\./, "agent:review-bot"],
  [/^"?Reply with exactly\b/, "agent:probe"],
];

/** Classify one user-side record. Attachments and slash commands are md's actions. */
export function classifyUserText(text: string): AuthorVerdict {
  const head = text.trimStart().slice(0, 400);
  if (head.length === 0) return { author: "harness", rule: "harness:empty" };
  for (const [pattern, rule] of HARNESS_PREFIXES) if (pattern.test(head)) return { author: "harness", rule };
  for (const [pattern, rule] of AGENT_PREFIXES) if (pattern.test(head)) return { author: "agent", rule };
  // Role-assignment briefs ("You are the …, working in …") are written by
  // orchestrators; md talks to agents rather than casting them.
  if (/^"?(<role>\s*)?You are [\w'-]+/.test(head) && text.length > 200) return { author: "agent", rule: "agent:role-brief" };
  if (/^<command-name>|^\//.test(head)) return { author: "human", rule: "human:command" };
  // Claude Code opens a fresh context with this line after md approves a plan.
  if (/^Implement the following plan:/.test(head)) return { author: "human", rule: "human:plan-accept" };
  if (/^\[Image[: #]|^<image name=/.test(head)) return { author: "human", rule: "human:attachment" };
  return { author: "human", rule: "human:typed" };
}

let dictionary: Set<string> | null | undefined;
function dictionaryWords(): Set<string> | null {
  if (dictionary !== undefined) return dictionary;
  try { dictionary = new Set(readFileSync("/usr/share/dict/words", "utf8").toLowerCase().split("\n")); }
  catch { dictionary = null; }
  return dictionary;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
/** One deletion, transposition, replacement or insertion away from a word. */
function nearWord(word: string, known: (word: string) => boolean): boolean {
  for (let i = 0; i <= word.length; i++) {
    const left = word.slice(0, i), right = word.slice(i);
    if (right && known(left + right.slice(1))) return true;
    if (right.length > 1 && known(left + right[1] + right[0] + right.slice(2))) return true;
    for (const c of ALPHABET) {
      if (right && known(left + c + right.slice(1))) return true;
      if (known(left + c + right)) return true;
    }
  }
  return false;
}

/** Corpus vocabulary: words assistants use are spelled right by definition. */
let learned: ReadonlySet<string> = new Set();
export function setLearnedVocabulary(words: ReadonlySet<string>): void { learned = words; }

/** Collect lowercase words that recur in assistant prose. */
export function learnVocabulary(texts: Iterable<string>, minCount = 4): Set<string> {
  const counts = new Map<string, number>();
  for (const text of texts) for (const token of text.slice(0, 3000).toLowerCase().match(/\b[a-z]{5,18}\b/g) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n >= minCount).map(([word]) => word));
}

function inflectionBases(token: string): string[] {
  const bases: string[] = [];
  const strip = (suffix: string, add = ""): void => { if (token.endsWith(suffix) && token.length - suffix.length >= 3) bases.push(token.slice(0, -suffix.length) + add); };
  strip("s"); strip("es"); strip("ies", "y"); strip("ied", "y"); strip("ier", "y"); strip("iest", "y");
  strip("ed"); strip("d"); strip("ing"); strip("ing", "e"); strip("er"); strip("r"); strip("est"); strip("st"); strip("ly");
  for (const suffix of ["ed", "ing", "er", "est"]) {
    const stem = token.endsWith(suffix) ? token.slice(0, -suffix.length) : "";
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2)) bases.push(stem.slice(0, -1));
  }
  return bases;
}

/**
 * Misspellings: plain lowercase words that are neither dictionary words, their
 * inflections, nor corpus vocabulary, but sit one edit from a word. Code,
 * paths and jargon rarely do; md's fast typing ("pelase", "owrktree") does.
 */
export function typoCount(text: string): number {
  const words = dictionaryWords();
  if (!words) return 0;
  const known = (word: string): boolean => words.has(word) || learned.has(word);
  let typos = 0;
  for (const raw of text.slice(0, 4000).split(/\s+/)) {
    const token = raw.replace(/^[("'`]+|[)"'`.,;:!?]+$/g, "");
    if (!/^[a-z]{5,18}$/.test(token) || known(token)) continue;
    if (inflectionBases(token).some(known)) continue;
    if (nearWord(token, known)) typos++;
  }
  return typos;
}

export interface Voice { human: number; brief: number; typos: number }

const BRIEF_VERBS = /^"?(Read|Implement|Work|Execute|Land|Build|Fix|Review|Audit|Create|Investigate|Plan|Write|Add|Update|Run|Use|Continue|Redispatch|Verify|Port|Refactor|Migrate)\b/;
const GREETING = /^(hi|hey|hello|yo|moshi|okay|ok|hmm|so|wait|lol|pls|please|can you|could you|do you|what|why|how|is|are|did|does|yes|no|nah|yeah|ehh+|oh)\b/i;

/** How much a record reads like md typing versus a dispatched brief. */
export function voiceOf(text: string): Voice {
  const trimmed = text.trim();
  const typos = typoCount(trimmed);
  let human = 0, brief = 0;
  if (typos >= 1) human += 2;
  if (typos >= 3) human += 1;
  const letters = trimmed.slice(0, 400).replace(/[^A-Za-z]/g, "");
  if (letters.length >= 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) human += 2;
  if (/^[a-z]/.test(trimmed)) human += 1;
  if (GREETING.test(trimmed)) human += 1;
  if (trimmed.length < 280) human += 1;
  if (trimmed.includes("?")) human += 1;
  if (BRIEF_VERBS.test(trimmed)) brief += 1;
  if (/\b(lane|LANE)\b/.test(trimmed.slice(0, 400))) brief += 2;
  if (/\b(Repo|Repository|Worktree|Branch|HEAD)\s*:/.test(trimmed)) brief += 1;
  if (/docs\/briefs|brief (is )?at\b|your (complete |full )?brief|execute (it|that lane|this lane)/i.test(trimmed)) brief += 2;
  if (/\bexactly\b/.test(trimmed) && BRIEF_VERBS.test(trimmed)) brief += 1;
  if ((trimmed.match(/^#{1,3} /gm) ?? []).length >= 2 || (trimmed.match(/^\s*([-*]|\d+\.) /gm) ?? []).length >= 4) brief += 1;
  if (trimmed.length > 800) brief += 1;
  if (typos === 0 && trimmed.length > 300) brief += 1;
  return { human, brief, typos };
}

/** Normalized session opener used to detect templated (scripted) launches. */
export function openerKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

export interface CreatorInput {
  harness: string;
  origin: "human" | "agent" | "mixed" | "unknown";
  originDetail: string | null;
  /** Current-generation user-side records in order. */
  userRecords: ReadonlyArray<{ ordinal: number; text: string }>;
}

export interface CreatorVerdict {
  startedBy: "human" | "agent" | "unknown";
  confidence: number;
  evidence: string[];
  firstHumanOrdinal: number | null;
  humanTurns: number;
  agentTurns: number;
  harnessTurns: number;
  opener: string | null;
}

export const CREATOR_RULE_VERSION = 1;

/** Launch metadata that means a program, not md, opened the session. */
const WORKER_DETAIL = /(agentId|isSidechain|subagents-path|thread_spawn|rlm-child|parent_id|subagent|external-agent-transcript|subagent-path)/;
const SCRIPTED_DETAIL = /(sdk|codex:source:exec)/;

/**
 * Decide who started a session from launch metadata plus the first record
 * that is not harness plumbing. `templated` is the set of opener keys that
 * several independent sessions share (scripted launches).
 */
export function decideCreator(input: CreatorInput, templated: ReadonlySet<string>): CreatorVerdict {
  let humanTurns = 0, agentTurns = 0, harnessTurns = 0;
  let first: { ordinal: number; text: string; verdict: AuthorVerdict } | null = null;
  let firstHuman: number | null = null;
  let voicedFollowUps = 0;
  for (const record of input.userRecords) {
    const verdict = classifyUserText(record.text);
    if (verdict.author === "harness") { harnessTurns++; continue; }
    if (verdict.author === "human") {
      humanTurns++;
      firstHuman ??= record.ordinal;
      // A later turn that plainly reads like md means md was there.
      if (first) { const v = voiceOf(record.text); if (v.human >= v.brief + 2 || (v.typos >= 1 && v.human > v.brief)) voicedFollowUps++; }
    } else agentTurns++;
    first ??= { ...record, verdict };
  }
  const detail = input.originDetail ?? "";
  const counts = { firstHumanOrdinal: firstHuman, humanTurns, agentTurns, harnessTurns };
  const opener = first ? openerKey(first.text) : null;
  const result = (startedBy: CreatorVerdict["startedBy"], confidence: number, evidence: string[]): CreatorVerdict =>
    ({ startedBy, confidence, evidence, ...counts, opener });

  // Children inherit the parent's transcript, md's words included. Launch
  // metadata outranks any text found inside them.
  if (WORKER_DETAIL.test(detail)) return result("agent", 0.97, [`launch:${detail}`]);
  // SDK front-ends are scripts unless md keeps talking in them.
  if (SCRIPTED_DETAIL.test(detail) && !/direct-cli/.test(detail) && voicedFollowUps < 2) return result("agent", 0.85, [`launch:${detail}`]);
  if (!first) {
    return input.origin === "human"
      ? result("unknown", 0.4, [`launch:${detail || "none"}`, "no-dialogue"])
      : result("unknown", 0.2, ["no-dialogue"]);
  }
  const launch = detail && input.origin === "human" ? [`launch:${detail}`] : [];
  if (first.verdict.author === "agent") {
    // A peer/agent message can land first in a CLI md opened; md then talks.
    if (launch.length > 0 && voicedFollowUps >= 2) return result("human", 0.7, [...launch, first.verdict.rule, `voiced-follow-ups:${voicedFollowUps}`, "human-took-over"]);
    return result("agent", 0.9, [...launch, first.verdict.rule]);
  }
  // md sometimes pastes one prompt into several models, then talks to each.
  if (opener && opener.length >= 60 && templated.has(opener) && voicedFollowUps === 0) return result("agent", 0.85, [...launch, "opener:templated"]);
  // Interactive launch metadata (cli, vscode, app) is not proof of md: supervisors
  // dispatch lanes through the same entry points. The opener's voice decides.
  const voice = voiceOf(first.text);
  const voiced = [...launch, first.verdict.rule, `voice:${voice.human}-${voice.brief}`, `typos:${voice.typos}`, `human-turns:${humanTurns}`, `voiced-follow-ups:${voicedFollowUps}`];
  if (voice.human - voice.brief >= 1) return result("human", voice.typos > 0 || humanTurns >= 2 ? 0.95 : 0.85, voiced);
  // md often opens by pasting an agent's handoff, then talks. The talk decides.
  if (voicedFollowUps >= 1) return result("human", voicedFollowUps >= 2 ? 0.85 : 0.7, voiced);
  if (first.verdict.rule !== "human:typed") return result("human", 0.8, voiced);
  if (voice.brief - voice.human >= 2) return result("agent", voice.brief - voice.human >= 4 ? 0.9 : 0.75, [...voiced, "brief"]);
  return result("unknown", 0.5, voiced);
}
