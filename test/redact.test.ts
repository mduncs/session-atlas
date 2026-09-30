import { test, expect } from "bun:test";
import { redactString, shannonEntropy, DEFAULT_REDACT_OPTIONS } from "../src/redact.js";

const O = DEFAULT_REDACT_OPTIONS;

test("Law 3 — AWS access key + secret are caught", () => {
  const out = redactString("export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", O);
  expect(out).toContain("[redacted:aws-access-key]");
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  const out2 = redactString(
    'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    O,
  );
  expect(out2).toContain("[redacted:aws-secret]");
  expect(out2).not.toContain("wJalrXUtnFEMI");
});

test("Law 3 — sk- and ghp_-style API tokens are caught", () => {
  for (const tok of [
    "sk-ant-api03-1234567890abcdefABCDEF",
    "sk-proj-abcdefghijklmno1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
    "glpat-xxxxxxxxxxxxxxxxxxxx",
    "xoxb-1234567890123-1234567890123-abcd",
  ]) {
    const out = redactString(`token: ${tok} goes here`, O);
    expect(out).toContain("[redacted:api-token]");
    expect(out).not.toContain(tok);
  }
});

test("Law 3 — JWT (three segments) is caught", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const out = redactString(`Bearer ${jwt}`, O);
  expect(out).toContain("[redacted:jwt]");
  expect(out).not.toContain(jwt);
});

test("Law 3 — PEM private key block is caught wholesale", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP
QRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV
-----END RSA PRIVATE KEY-----`;
  const out = redactString(`here is the key:\n${pem}\ndone`, O);
  expect(out).toContain("[redacted:pem]");
  expect(out).not.toContain("MIIEpAIBAAKCAQEA");
});

test("Law 3 — KEY=value env pairs with secret-looking values are caught", () => {
  const out = redactString(
    "DATABASE_PASSWORD=hunter2jXm9kP4qR7sT0vW3yZ and OPENAI_API_KEY=sk-thinghere1234567890ABC",
    O,
  );
  expect(out).toContain("[redacted:env-pair]");
  expect(out).not.toContain("hunter2jXm9kP4qR7sT0vW3yZ");
});

test("Law 3 — high-entropy hex/base64 blobs (≥20 chars, ≥4.8 bits/char) are caught", () => {
  // 40-char hex SHA1, full entropy on hex alphabet = 4 bits/char... hex of
  // random data sits near 4.0; bump to a mixed base64 to clear 4.8.
  const blob = "T9q2x7vK4mP1nR6sZ3wY8bC5dF0gH2jJ7lN9o"; // 37 chars b64-shaped
  expect(shannonEntropy(blob)).toBeGreaterThan(4.8);
  const out = redactString(`the hash was ${blob} and then`, O);
  expect(out).toContain("[redacted:");
  expect(out).not.toContain(blob);
});

test("Law 3 — clean prose passes untouched (zero false positives on corpus)", () => {
  const prose = [
    "We discussed variable stars and the period-luminosity relation across several sessions.",
    "The refactor touched src/adapters/claude.ts and the chain assembly logic.",
    "Can you explain how the percentile saturation ramp encodes engagement?",
    "I want to build a clickable terminal UI that scans the whole history.",
    "config.toml holds the provider chain and the tunables with shipped defaults.",
    "A session present in both roots yields one row; the longer transcript wins.",
    "md runs many coding sessions across Claude Code, Codex, and Kilo.",
  ];
  for (const p of prose) {
    const out = redactString(p, O);
    expect(out).toBe(p); // byte-identical: nothing redacted
  }
});

test("Law 3 — natural long identifiers are NOT redacted (vowel rhythm)", () => {
  // CamelCase identifiers with vowels should survive (not high-entropy enough
  // by the prose heuristic, and not matching any secret shape).
  const ids = [
    "getSessionActivityForHarnessAndProject",
    "renderSessionViewWithTranscriptModes",
  ];
  for (const id of ids) {
    const out = redactString(`call ${id} now`, O);
    expect(out).toContain(id); // preserved
  }
});

test("Law 3 — redaction is idempotent (placeholders survive a second pass)", () => {
  const once = redactString("token sk-ant-api03-1234567890abcdefABCDEF here", O);
  const twice = redactString(once, O);
  expect(twice).toBe(once);
});
