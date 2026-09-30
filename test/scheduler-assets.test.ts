import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TUNABLES } from "../src/config.js";

const root = join(import.meta.dir, "..");
const indexPlist = readFileSync(
  join(root, "examples/com.session-atlas.index.plist"),
  "utf8",
);
const watchdogPlist = readFileSync(
  join(root, "examples/com.session-atlas.index-watchdog.plist"),
  "utf8",
);
const installer = readFileSync(join(root, "scripts/ensure-launchd.sh"), "utf8");

function programArguments(plist: string): string[] {
  const body = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  if (!body) throw new Error("plist is missing ProgramArguments");
  return [...body.matchAll(/<string>(.*?)<\/string>/g)].map(
    (match) => match[1] ?? "",
  );
}

function renderSchedulerAssets(home: string, output: string, config: string) {
  return Bun.spawnSync({
    cmd: [
      "/bin/bash",
      join(root, "scripts/ensure-launchd.sh"),
      "--render",
      output,
      "--config",
      config,
    ],
    cwd: root,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("launchd index asset runs every 30 minutes without failure-triggered relaunch", () => {
  expect(indexPlist).toContain("REPLACE_ME_ABSOLUTE_INDEX_WRAPPER_PATH");
  expect(indexPlist).not.toContain("REPLACE_ME_ABSOLUTE_PATH_TO_BUN");
  expect(indexPlist).toContain("<string>--scheduled</string>");
  expect(indexPlist).toMatch(
    /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/,
  );
  expect(indexPlist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(indexPlist).not.toContain("<key>KeepAlive</key>");
  expect(indexPlist).not.toContain("<key>SuccessfulExit</key>");
  expect(indexPlist).not.toContain("<key>ThrottleInterval</key>");
});

test("launchd watchdog checks every minute without failure-triggered relaunch", () => {
  expect(watchdogPlist).toContain("com.session-atlas.index-watchdog");
  expect(watchdogPlist).toContain("REPLACE_ME_ABSOLUTE_WATCHDOG_WRAPPER_PATH");
  expect(watchdogPlist).toContain("REPLACE_ME_ABSOLUTE_WATCHDOG_SCRIPT_PATH");
  expect(watchdogPlist).toContain("<string>/</string>");
  expect(watchdogPlist).toContain("<string>--watchdog</string>");
  expect(watchdogPlist).toMatch(
    /<key>StartInterval<\/key>\s*<integer>60<\/integer>/,
  );
  expect(watchdogPlist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(watchdogPlist).not.toContain("<key>KeepAlive</key>");
  expect(watchdogPlist).not.toContain("<key>SuccessfulExit</key>");
  expect(watchdogPlist).not.toContain("<key>ThrottleInterval</key>");
});

test("scheduler health defaults match the 30 minute cadence", () => {
  expect(DEFAULT_TUNABLES.full_walk_interval_ms).toBe(30 * 60_000);
  expect(DEFAULT_TUNABLES.full_walk_degraded_after_ms).toBe(90 * 60_000);
  expect(DEFAULT_TUNABLES.full_walk_stale_after_ms).toBe(6 * 60 * 60_000);
});

test("scheduler installer owns only the two Session Atlas labels", () => {
  expect(installer).toContain("com.session-atlas.index");
  expect(installer).toContain("com.session-atlas.index-watchdog");
  expect(installer).toContain("cmp -s");
  expect(installer).toContain("bootout_service");
  expect(installer).toContain("bootstrap_service");
  expect(installer).toContain(
    'bootstrap_service "$index_service" "$index_plist"',
  );
  expect(installer).toContain(
    'bootstrap_service "$watchdog_service" "$watchdog_plist"',
  );
  expect(installer).toContain("--render DIR");
  expect(installer).toContain("assert_plist_semantics");
  expect(installer).toContain("assert_watchdog_index_contract");
  expect(installer).toMatch(
    /if \(\(watchdog_definition_changed \|\| index_definition_changed\)\); then\s+bootout_service "\$watchdog_service"\s+fi\s+if \(\(index_definition_changed\)\); then\s+bootout_service "\$index_service"/,
  );
});

test("scheduler dry-render preserves wrapper ProgramArguments without touching launchd state", () => {
  const fixture = mkdtempSync(
    join(tmpdir(), "session-atlas-scheduler-assets-"),
  );
  const home = join(fixture, "home");
  const first = join(fixture, "render-first");
  const second = join(fixture, "render-second");
  const config = join(home, "configs", "custom-atlas.toml");
  const wrapperDir = join(
    home,
    "Library/Application Support/LaunchAgent Wrappers",
  );
  const helper = join(
    home,
    "Library/Application Support/Session Atlas/ensure-launchd.sh",
  );
  const filenames = [
    "com.session-atlas.index.plist",
    "com.session-atlas.index-watchdog.plist",
    "Session Atlas Index",
    "Session Atlas Watchdog",
  ];

  mkdirSync(home, { recursive: true });
  try {
    const firstRun = renderSchedulerAssets(home, first, config);
    expect(firstRun.exitCode, firstRun.stderr.toString()).toBe(0);
    expect(firstRun.stdout.toString()).toContain(
      "rendered without installation:",
    );
    expect(firstRun.stdout.toString().match(/^[a-f0-9]{64}  /gm)).toHaveLength(
      4,
    );

    const renderedIndex = readFileSync(join(first, filenames[0]!), "utf8");
    const renderedWatchdog = readFileSync(join(first, filenames[1]!), "utf8");
    expect(programArguments(renderedIndex)).toEqual([
      join(wrapperDir, "Session Atlas Index"),
      "run",
      join(root, "src/cli.ts"),
      "index",
      "--scheduled",
      "--config",
      config,
    ]);
    expect(programArguments(renderedWatchdog)).toEqual([
      join(wrapperDir, "Session Atlas Watchdog"),
      helper,
      "--watchdog",
      "--config",
      config,
    ]);
    expect(programArguments(renderedIndex)[0]).not.toBe(process.execPath);
    expect(programArguments(renderedWatchdog)[0]).not.toBe("/bin/bash");
    expect(readFileSync(join(first, filenames[2]!), "utf8")).toMatch(
      /^#!\/bin\/sh\nexec '.*bun' "\$@"\n$/,
    );
    expect(readFileSync(join(first, filenames[3]!), "utf8")).toBe(
      '#!/bin/sh\nexec /bin/bash "$@"\n',
    );
    expect(statSync(join(first, filenames[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(join(first, filenames[2]!)).mode & 0o777).toBe(0o755);
    expect(existsSync(join(home, "Library"))).toBe(false);

    const secondRun = renderSchedulerAssets(home, second, config);
    expect(secondRun.exitCode, secondRun.stderr.toString()).toBe(0);
    for (const filename of filenames) {
      expect(readFileSync(join(second, filename))).toEqual(
        readFileSync(join(first, filename)),
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("scheduler dry-render rejects a template that bypasses the index wrapper", () => {
  if (!existsSync("/usr/libexec/PlistBuddy")) return;

  const fixture = mkdtempSync(join(tmpdir(), "session-atlas-scheduler-drift-"));
  const copiedRepo = join(fixture, "repo");
  const copiedScript = join(copiedRepo, "scripts/ensure-launchd.sh");
  const copiedIndexTemplate = join(
    copiedRepo,
    "examples/com.session-atlas.index.plist",
  );
  const home = join(fixture, "home");
  try {
    mkdirSync(join(copiedRepo, "scripts"), { recursive: true });
    mkdirSync(join(copiedRepo, "examples"), { recursive: true });
    mkdirSync(home, { recursive: true });
    cpSync(join(root, "scripts/ensure-launchd.sh"), copiedScript);
    cpSync(
      join(root, "examples/com.session-atlas.index.plist"),
      copiedIndexTemplate,
    );
    cpSync(
      join(root, "examples/com.session-atlas.index-watchdog.plist"),
      join(copiedRepo, "examples/com.session-atlas.index-watchdog.plist"),
    );
    writeFileSync(
      copiedIndexTemplate,
      readFileSync(copiedIndexTemplate, "utf8").replace(
        "REPLACE_ME_ABSOLUTE_INDEX_WRAPPER_PATH",
        "/Users/test/.bun/bin/bun",
      ),
    );

    const run = Bun.spawnSync({
      cmd: [
        "/bin/bash",
        copiedScript,
        "--render",
        join(fixture, "render"),
        "--config",
        join(home, "config.toml"),
      ],
      cwd: copiedRepo,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("ProgramArguments[0] drift");
    expect(run.stderr.toString()).toContain("Session Atlas Index");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
