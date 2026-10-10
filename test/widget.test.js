// node --test test
// Contracts for the desktop widget data path: snapshot model, daemon background loop, widget script validity.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "claude-pool.js");
const UNIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-unit-"));
process.env.CLAUDE_POOL_HOME = UNIT_HOME;
process.env.CLAUDE_POOL_NO_SYSTEM = "1";
// never touch the real ~/.claude (credentials, /login account) - children inherit this too
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-claudecfg-"));
process.env.CLAUDE_POOL_AUTH_RECHECK_MS = "0"; // the 401 re-check waits 5 s in production
const pool = require(SCRIPT);

const MIN = 60000;
const NOW = Date.UTC(2026, 9, 10, 4, 24, 0);
const clock = (ms) => {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return Math.abs(ms - NOW) < 20 * 3600 * 1000 ? hhmm : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${hhmm}`;
};
const token = (n) => `sk-ant-oat01-${crypto.randomBytes(30).toString("hex")}${n}`;

// The panel from the request: 6 accounts, acct1 in use, acct2 paused.
function samplePool(base = NOW) {
  const spec = [
    // name, 5h used, 5h reset (min), 7d used, 7d reset (min)
    ["acct1", 78, 176, 12, 9900],
    ["acct2", 100, 56, 80, 7080],
    ["acct3", 4, 156, 97, 2040],
    ["acct4", 91, 156, 95, 5160],
    ["acct5", 0.3, 296, 92, 3540],
    ["acct6", 0.3, 296, 98, 3900],
  ];
  const accounts = [], usage = {};
  for (const [name, s, sr, w, wr] of spec) {
    const id = "id-" + name;
    accounts.push({ id, name, token: token(name), enabled: true, dead: false, pausedUntil: name === "acct2" ? base + 56 * MIN : 0 });
    usage[id] = { at: base - MIN, session: { used: s, resetsAt: base + sr * MIN }, weekly: { used: w, resetsAt: base + wr * MIN } };
  }
  return { acc: { version: 1, accounts }, st: { version: 1, usage, sessions: {}, defaultAccountId: "id-acct1" } };
}

test("fmtShort: compact widget durations (56m, 2h56, 6d21)", () => {
  assert.equal(pool.fmtShort(56 * MIN), "56m");
  assert.equal(pool.fmtShort(30 * 1000), "1m"); // rounds up: never shows 0m before a reset
  assert.equal(pool.fmtShort(176 * MIN), "2h56");
  assert.equal(pool.fmtShort(9900 * MIN), "6d21");
  assert.equal(pool.fmtShort((24 * 60 + 5 * 60) * MIN), "1d05");
  assert.equal(pool.fmtShort(null), "");
});

test("snapshot reproduces the requested panel: rows, usable bar, reset lines", () => {
  const { acc, st } = samplePool();
  const s = pool.buildSnapshot(acc, st, NOW);
  const byName = Object.fromEntries(s.rows.map((r) => [r.name, r]));
  assert.deepEqual(s.rows.map((r) => r.name), ["acct1", "acct2", "acct3", "acct4", "acct5", "acct6"], "pool order kept");
  assert.deepEqual(byName.acct1, { name: "acct1", active: true, h5: { left: 22, reset: "2h56" }, d7: { left: 88, reset: "6d21" }, status: "new terminals", kind: "active", stale: false });
  assert.equal(byName.acct2.status, `paused to ${clock(NOW + 56 * MIN)}`);
  assert.deepEqual(byName.acct2.h5, { left: 0, reset: "56m" });
  assert.deepEqual(byName.acct3.d7, { left: 3, reset: "1d10" });
  assert.equal(byName.acct3.status, "ready");
  assert.deepEqual(byName.acct5.h5, { left: 100, reset: "4h56" });
  assert.equal(s.rows.filter((r) => r.active).length, 1, "one arrow");

  // Usable = sum of 7d left (126) over 6 accounts: 21%, 3 of 16 cells, ≈1.2 accounts (floored)
  assert.deepEqual(
    { pct: s.usable.pct, filled: s.usable.filled, cells: s.usable.cells, accounts: s.usable.accounts, total: s.usable.total },
    { pct: 21, filled: 3, cells: 16, accounts: 1.2, total: 6 }
  );
  assert.equal(s.usable.text, "21% · ≈1.2 of 6 accounts");
  assert.equal(s.resets.h5, `first acct2 in 56m · all in 4h56 (${clock(NOW + 296 * MIN)})`);
  assert.equal(s.resets.d7, `first acct3 in 1d10 · all in 6d21 (${clock(NOW + 9900 * MIN)})`);

  const lines = pool.summaryLines(s);
  assert.equal(lines[0], "Usable     ███░░░░░░░░░░░░░  21% · ≈1.2 of 6 accounts");
});

test("security: the snapshot never carries a token", () => {
  const { acc, st } = samplePool();
  const json = JSON.stringify(pool.buildSnapshot(acc, st, NOW));
  assert.ok(!/sk-ant-/.test(json));
  for (const a of acc.accounts) assert.ok(!json.includes(a.token.slice(-12)));
});

test("arrow: marks the daemon default and accounts with live cpool sessions; never a disabled account", () => {
  const { acc, st } = samplePool();
  st.sessions = { 101: { pid: 101, accountId: "id-acct3" }, 102: { pid: 102, accountId: "id-acct3" } };
  acc.accounts[3].enabled = false;
  st.defaultAccountId = "id-acct4"; // default points at a disabled account
  const s = pool.buildSnapshot(acc, st, NOW);
  const byName = Object.fromEntries(s.rows.map((r) => [r.name, r]));
  assert.equal(byName.acct3.active, true);
  assert.equal(byName.acct3.status, "in use (2)");
  assert.equal(byName.acct4.active, false);
  assert.equal(byName.acct4.status, "off");
  assert.equal(byName.acct1.active, false);
  assert.equal(s.usable.total, 5, "disabled accounts are not part of the pool");
});

test("resets: windows nobody used read 'all full'; empty pool renders without NaN", () => {
  const { acc, st } = samplePool();
  for (const u of Object.values(st.usage)) u.session.used = 0;
  assert.equal(pool.buildSnapshot(acc, st, NOW).resets.h5, "all full");

  const e = pool.buildSnapshot({ version: 1, accounts: [] }, { usage: {}, sessions: {}, defaultAccountId: null }, NOW);
  assert.equal(e.empty, true);
  assert.equal(e.usable.text, "0% · ≈0.0 of 0 accounts");
  assert.deepEqual(e.resets, { h5: "-", d7: "-" });
  assert.ok(!JSON.stringify(e).includes("NaN"));
});

test("daemon hysteresis: keep the default within SWITCH_MARGIN of the best, switch when it is worse or unusable", () => {
  const a = { id: "x", token: token("H"), enabled: true, dead: false, pausedUntil: 0 };
  const u = (left) => ({ session: { used: 100 - left }, weekly: { used: 0 } });
  const m = pool.SWITCH_MARGIN;
  assert.equal(pool.keepDefault(a, u(30), 30 + m - 1, NOW), true, "near-equal best: no flap");
  assert.equal(pool.keepDefault(a, u(30), 30 + m, NOW), false, "best clearly better: switch");
  assert.equal(pool.keepDefault({ ...a, pausedUntil: NOW + MIN }, u(30), 30, NOW), false, "paused default: switch");
  assert.equal(pool.keepDefault({ ...a, dead: true }, u(30), 30, NOW), false, "dead default: switch");
  assert.equal(pool.keepDefault(a, { session: { used: 99.5 }, weekly: { used: 0 } }, 5, NOW), false, "exhausted default: switch");
  assert.equal(pool.keepDefault(null, null, 0, NOW), false, "no default yet: switch");
  assert.equal(pool.keepDefault({ ...a, token: null }, u(30), 30, NOW), false, "default lost its login: switch");
});

test("widget script parses in Windows PowerShell with zero errors", { skip: process.platform !== "win32" }, () => {
  const f = path.join(UNIT_HOME, "widget-parse.ps1");
  fs.writeFileSync(f, "﻿" + pool.WIDGET_SCRIPT.replace(/\r?\n/g, "\r\n"));
  const ps = `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}', [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message + ' @' + $_.Extent.StartLineNumber }; 'ERRORS=' + @($e).Count`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  assert.match(r.stdout, /ERRORS=0/, r.stdout + r.stderr);
  assert.ok(!pool.WIDGET_SCRIPT.includes("sk-ant"), "widget never handles tokens");
});

// Runs the real widget script headless (-SelfTest): catches runtime errors a parse cannot (e.g. PowerShell's
// case-insensitive names: a local $foot silently replaced the $Foot TextBlock and every render failed).
function widgetSelfTest(snap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-widget-"));
  if (snap) fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify(snap));
  const f = path.join(dir, "widget.ps1");
  fs.writeFileSync(f, "﻿" + pool.WIDGET_SCRIPT.replace(/\r?\n/g, "\r\n"));
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", f, "-StateDir", dir, "-SelfTest"], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
test("widget renders the panel: arrow row, columns, usable, resets; no footer while the daemon is fresh", { skip: process.platform !== "win32" }, () => {
  const now = Date.now();
  const { acc, st } = samplePool(now);
  const snap = pool.buildSnapshot(acc, st, now);
  snap.daemon = { pid: 1, everyMs: 120000 };
  const r = widgetSelfTest(snap);
  assert.equal(r.code, 0, r.out);
  for (const s of ["acct1", "22%", "2h56", "88%", "6d21", "new terminals", "acct6", "Logins", "new terminals → acct1", "21%", "of 6 accounts", "first acct2 in 56m", "first acct3 in 1d10"]) assert.ok(r.out.includes(s), `missing ${s}: ${r.out}`);
  assert.match(r.out, /FOOT=\s*$/m, "no footer when fresh");
  assert.match(r.out, /RELOGIN=acct1\|acct2\|acct3\|acct4\|acct5\|acct6 enabled=True/, "right-click Re-login lists every account");
});
test("widget tells stale / stopped daemon and empty pool apart", { skip: process.platform !== "win32" }, () => {
  const { acc, st } = samplePool();
  const stale = pool.buildSnapshot(acc, st, Date.now() - 5 * MIN);
  stale.daemon = { pid: 1, everyMs: 120000 };
  assert.match(widgetSelfTest(stale).out, /FOOT=pool daemon not running - data 5m old/);
  const stopped = pool.buildSnapshot(acc, st, Date.now());
  stopped.daemon = { pid: 1, stopped: true };
  assert.match(widgetSelfTest(stopped).out, /FOOT=pool daemon stopped/);
  const empty = pool.buildSnapshot({ accounts: [] }, { usage: {}, sessions: {} }, Date.now());
  empty.daemon = { pid: 1 };
  const e = widgetSelfTest(empty);
  assert.equal(e.code, 0, e.out);
  assert.match(e.out, /DRAWN=no accounts yet\|\[\+ Add account\]/);
  assert.match(e.out, /FOOT=add your Claude accounts with \+ Add account/);
  assert.match(e.out, /RELOGIN= enabled=False/, "nothing to re-login in an empty pool");
  assert.match(widgetSelfTest(null).out, /FOOT=waiting for the pool daemon/);
});

test("logins: the default reads 'new terminals', a cpool session 'in use', and claude /login is shown (by name when an account has that email)", () => {
  const { acc, st } = samplePool();
  let s = pool.buildSnapshot(acc, st, NOW, null, [], { on: true }, { email: "Someone@Example.com", org: "Org" });
  assert.equal(s.rows[0].status, "new terminals");
  assert.equal(s.logins.text, "new terminals → acct1 · claude /login → Someone@Example.com");
  acc.accounts[1].email = "someone@example.com";
  st.sessions = { 7: { pid: 7, accountId: "id-acct1" } };
  s = pool.buildSnapshot(acc, st, NOW, null, [], { on: true }, { email: "Someone@Example.com" });
  assert.equal(s.rows[0].status, "in use", "a live cpool session beats the default label");
  assert.equal(s.logins.text, "new terminals → acct1 · claude /login → acct2");
  assert.equal(pool.buildSnapshot(acc, st, NOW, null, [], { on: true }, { email: "acct4@example.com" }).logins.cli, "acct4@example.com", "no guessing from the mailbox name");
  st.defaultAccountId = null;
  assert.equal(pool.buildSnapshot(acc, st, NOW).logins.text, "new terminals → their own claude /login");
});

test("claude /login is matched to a pool account by its usage windows - unique match only, named with its real email when they differ", () => {
  const { acc, st } = samplePool();
  const u3 = st.usage["id-acct3"]; // acct3: 5h 96% left, 7d 3% left
  const cliUsage = { session: { used: u3.session.used + 1, resetsAt: u3.session.resetsAt - 1000 }, weekly: { used: u3.weekly.used, resetsAt: u3.weekly.resetsAt + 1000 } };
  assert.equal(pool.matchCliAccount(acc, st.usage, cliUsage).name, "acct3");
  const s = pool.buildSnapshot(acc, st, NOW, null, [], { on: true }, { email: "acct2@example.com", usage: cliUsage });
  assert.equal(s.logins.text, "new terminals → acct1 · claude /login → acct3 (acct2@example.com)", "names crossed: show the real email");
  assert.equal(pool.buildSnapshot(acc, st, NOW, null, [], { on: true }, { email: "acct3@example.com", usage: cliUsage }).logins.cli, "acct3");
  // a second account with the same windows makes it ambiguous -> no name
  st.usage["id-acct4"] = JSON.parse(JSON.stringify(u3));
  assert.equal(pool.matchCliAccount(acc, st.usage, cliUsage), null);
  assert.equal(pool.matchCliAccount(acc, st.usage, null), null);
  assert.equal(pool.matchCliAccount(acc, st.usage, { weekly: { used: 50, resetsAt: NOW + 9 * 86400000 } }), null, "no match");
});

test("cli usage: read with the /login access token from the official usage endpoint; expired token = no request", async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-cfg-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-cli-"));
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationName: "Org" } }));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 40, resets_at: "2026-10-10T15:30:00Z" }, seven_day: { utilization: 97, resets_at: "2026-10-15T03:00:00Z" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // async child: the mock server lives in this process and must keep answering
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ["-e", `require(${JSON.stringify(SCRIPT)}).fetchCliUsage().then((v) => console.log(JSON.stringify(v)))`], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_POOL_HOME: home, CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("exit", () => resolve(out.trim()));
    });
  try {
    const at = token("C");
    fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: at, expiresAt: Date.now() + 3600000 } }));
    const v = JSON.parse(await run());
    assert.equal(v.email, "me@example.com");
    assert.deepEqual(v.session, { used: 40, resetsAt: Date.parse("2026-10-10T15:30:00Z") });
    assert.deepEqual(v.weekly, { used: 97, resetsAt: Date.parse("2026-10-15T03:00:00Z") });
    assert.equal(seen[0].url, "/api/oauth/usage");
    assert.equal(seen[0].auth, `Bearer ${at}`);
    fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: at, expiresAt: Date.now() - 1000 } }));
    assert.equal(await run(), "null", "expired: skipped, never refreshed");
    assert.equal(seen.length, 1, "no request with an expired token");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- claude shim (typing claude = a pool session)
test("shim routing: sessions go through the pool; subcommands, -p, --bg, --version, --help go straight to claude", () => {
  for (const a of [[], ["fix the tests"], ["-c"], ["--resume", "abc"], ["--model", "opus", "hi"], ["--model", "mcp"]]) assert.equal(pool.passThrough(a), false, JSON.stringify(a));
  for (const a of [["mcp", "list"], ["update"], ["doctor"], ["setup-token"], ["-p", "hi"], ["--print"], ["--bg"], ["--version"], ["-v"], ["--help"], ["plugins"]]) assert.equal(pool.passThrough(a), true, JSON.stringify(a));
});

test("the pool never launches its own claude shim (no loop), and prefers claude.exe", () => {
  const own = path.join("C:", "pool", "bin");
  const yes = () => true;
  assert.equal(pool.chooseClaude([path.join(own, "claude.exe"), path.join("C:", "u", ".local", "bin", "claude.exe")], own, yes), path.join("C:", "u", ".local", "bin", "claude.exe"));
  assert.equal(pool.chooseClaude([path.join("C:", "npm", "claude.cmd"), path.join("C:", "x", "claude.exe")], own, yes), path.join("C:", "x", "claude.exe"));
  assert.equal(pool.chooseClaude([path.join(own, "claude.exe")], own, yes), null);
});

function buildShimIn(home) {
  const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(SCRIPT)}).buildShim()`], { env: { ...process.env, CLAUDE_POOL_HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return path.join(home, "bin", "claude.exe");
}

test("shim exe passes arguments exactly as typed and returns the exit code", { skip: process.platform !== "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-shim-"));
  const exe = buildShimIn(home);
  // stand-in for claude-pool.js next to bin/: echoes what it got
  fs.writeFileSync(path.join(home, "claude-pool.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(7);");
  const args = ["fix the tests", "100%", "%PATH%", "a&b", 'say "hi"', "--flag"];
  const r = spawnSync(exe, args, { encoding: "utf8" });
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["shim-run", ...args]);
});

test("typing claude: a session runs through the pool, `claude mcp list` / `claude -p` reach the real claude untouched", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-shim2-"));
  fs.copyFileSync(SCRIPT, path.join(home, "claude-pool.js"));
  const exe = buildShimIn(home);
  const tok = token("S");
  const api = await mockApi({ [tok]: [0.1, 0.1] });
  const outFile = path.join(home, "fake-argv.txt");
  fs.writeFileSync(path.join(home, "fake.js"), `require("fs").appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`);
  fs.writeFileSync(path.join(home, "fake.cmd"), `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: api.url, CLAUDE_POOL_CLAUDE_BIN: path.join(home, "fake.cmd") };
  const run = (args) => new Promise((resolve) => spawn(exe, args, { env, stdio: "ignore" }).on("exit", resolve));
  try {
    assert.equal(spawnSync(process.execPath, [path.join(home, "claude-pool.js"), "add", "acctS", tok], { env }).status, 0);
    assert.equal(await run(["hello"]), 0);
    assert.equal(await run(["mcp", "list"]), 0);
    assert.equal(await run(["-p", "hi"]), 0);
    // the shim asks `claude --help` once for the subcommand list; the rest are the three real runs
    const calls = fs.readFileSync(outFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => !(c.length === 1 && c[0] === "--help"));
    assert.equal(calls.length, 3, JSON.stringify(calls));
    assert.ok(calls[0].includes("--session-id") && calls[0].includes("hello"), `session went through cpool: ${calls[0]}`);
    assert.deepEqual(calls[1], ["mcp", "list"]);
    assert.deepEqual(calls[2], ["-p", "hi"]);
  } finally {
    api.server.close();
  }
});

// ---------------------------------------------------------------- live swap follows the conversation claude is on
// The bug this guards: inside claude the user resumed another conversation (saved under another project folder); at the
// limit cpool resumed the id it had assigned at launch, claude said "No conversation found" and the session died.
async function swapRun({ saveTranscript }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-swap-"));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-swapcfg-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-work-"));
  const tA = token("A"), tB = token("B");
  const t0 = Date.now();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const tok = (req.headers.authorization || "").replace("Bearer ", "");
      const used = tok === tA ? (Date.now() - t0 > 4000 ? 1.0 : 0.1) : 0.5; // A runs out after 4 s
      const reset = Math.floor(Date.now() / 1000) + 3600;
      res.writeHead(200, { "anthropic-ratelimit-unified-5h-utilization": String(used), "anthropic-ratelimit-unified-5h-reset": String(reset), "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-7d-reset": String(reset + 86400) });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const outFile = path.join(home, "argv.txt");
  fs.writeFileSync(path.join(home, "fake.js"), `
    const fs = require("fs"), path = require("path"), argv = process.argv.slice(2), cfg = process.env.CLAUDE_CONFIG_DIR;
    fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(argv) + "\\n");
    if (argv.includes("--session-id") && !fs.existsSync(${JSON.stringify(outFile)} + ".launched")) {
      fs.writeFileSync(${JSON.stringify(outFile)} + ".launched", "");
      // like /resume inside claude: now on another conversation, saved under another project folder
      fs.mkdirSync(path.join(cfg, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(cfg, "sessions", process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: "real-convo", cwd: process.cwd(), startedAt: Date.now() }));
      if (process.env.FAKE_SAVE === "1") { fs.mkdirSync(path.join(cfg, "projects", "other-folder"), { recursive: true }); fs.writeFileSync(path.join(cfg, "projects", "other-folder", "real-convo.jsonl"), "{}\\n"); }
      setInterval(() => {}, 1000); // keeps running until cpool stops it
    }`);
  fs.writeFileSync(path.join(home, "fake.cmd"), `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_CACHE_MS: "0", CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_POOL_CLAUDE_BIN: path.join(home, "fake.cmd"), FAKE_SAVE: saveTranscript ? "1" : "0" };
  try {
    for (const [n, t] of [["acctA", tA], ["acctB", tB]]) assert.equal(spawnSync(process.execPath, [SCRIPT, "add", n, t], { env }).status, 0);
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [SCRIPT, "run", "--pool-poll", "1", "hello"], { env, cwd: work, stdio: "ignore" });
      const kill = setTimeout(() => c.kill(), 40000);
      c.on("exit", (x) => (clearTimeout(kill), resolve(x)));
    });
    const calls = fs.readFileSync(outFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, calls, log: fs.readFileSync(path.join(home, "pool.log"), "utf8") };
  } finally {
    server.close();
  }
}
test("live swap resumes the conversation claude switched to (saved under another folder), not the id it was started with", { skip: process.platform !== "win32" }, async () => {
  const r = await swapRun({ saveTranscript: true });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.calls.length, 2, JSON.stringify(r.calls));
  const first = r.calls[0][r.calls[0].indexOf("--session-id") + 1];
  assert.deepEqual(r.calls[1].slice(0, 2), ["--resume", "real-convo"]);
  assert.ok(!r.calls[1].includes(first), "not the launch id");
  assert.match(r.log, /swap acctA -> acctB/);
  assert.match(r.log, /-> real-convo \(switched inside claude\)/);
});
test("live swap with no saved conversation starts a new session instead of dying on 'No conversation found'", { skip: process.platform !== "win32" }, async () => {
  const r = await swapRun({ saveTranscript: false });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.calls.length, 2, JSON.stringify(r.calls));
  assert.ok(!r.calls[1].includes("--resume"), JSON.stringify(r.calls[1]));
  assert.ok(r.calls[1].includes("--session-id"));
  assert.match(r.log, /no transcript for session real-convo - starting a new session/);
});

// ---------------------------------------------------------------- production hardening
test("release files: claude-pool.js starts with its shebang (no BOM, LF only) so `cpool` runs on macOS / Linux; package.json parses", () => {
  const b = fs.readFileSync(SCRIPT);
  assert.equal(b.subarray(0, 2).toString(), "#!", "shebang must be the first bytes");
  assert.ok(!b.includes(Buffer.from("\r\n")), "LF line endings");
  assert.ok(b.every((x) => x < 128), "ASCII only (non-ASCII text uses \\u escapes): no editor or code page can garble it");
  const pkg = fs.readFileSync(path.join(__dirname, "..", "package.json"));
  assert.notEqual(pkg[0], 0xef, "no BOM in package.json");
  assert.equal(JSON.parse(pkg.toString()).version, (spawnSync(process.execPath, [SCRIPT, "version"], { encoding: "utf8" }).stdout.match(/\d+\.\d+\.\d+/) || [])[0], "package.json and cpool version agree");
});

test("shim: claude's own subcommands come from its --help (aliases too), cached per binary - a future subcommand passes through", { skip: process.platform !== "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-help-"));
  const calls = path.join(home, "calls.txt");
  fs.writeFileSync(path.join(home, "fake.js"), `require("fs").appendFileSync(${JSON.stringify(calls)}, "x"); console.log("Usage: claude\\n\\nCommands:\\n  agents [options]                      Manage background agents\\n  brandnew <id>                         A subcommand from a future claude.\\n                                        continued description line\\n  update|upgrade                        Check for updates")`);
  fs.writeFileSync(path.join(home, "fake.cmd"), `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  const run = () => spawnSync(process.execPath, ["-e", `const p = require(${JSON.stringify(SCRIPT)}); const s = p.claudeSubcommands(${JSON.stringify(path.join(home, "fake.cmd"))}); console.log(JSON.stringify([s.has("brandnew"), s.has("upgrade"), s.has("continued"), p.passThrough(["brandnew", "x"], s), p.passThrough(["fix the bug"], s)]))`], { env: { ...process.env, CLAUDE_POOL_HOME: home }, encoding: "utf8" });
  assert.equal(run().stdout.trim(), "[true,true,false,true,false]");
  assert.equal(run().stdout.trim(), "[true,true,false,true,false]");
  assert.equal(fs.readFileSync(calls, "utf8").length, 1, "--help ran once, then the cache answered");
});

test("last-resort conversation lookup refuses when two windows wrote in the same folder", () => {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const cwd = path.join(os.tmpdir(), "some project");
  const dir = path.join(cfg, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const since = Date.now();
  const id1 = crypto.randomUUID(), id2 = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, id1 + ".jsonl"), "{}");
  assert.equal(pool.findLatestSession(cwd, since), id1);
  fs.writeFileSync(path.join(dir, id2 + ".jsonl"), "{}");
  assert.equal(pool.findLatestSession(cwd, since), null, "ambiguous: never guess");
});

test("probe falls back to another model when the first one is retired (404), and keeps using the one that works", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model === "retired-model") return res.writeHead(404, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"not_found_error","message":"model: retired-model"}}');
      res.writeHead(200, { "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-5h-reset": "2000000000", "anthropic-ratelimit-unified-7d-utilization": "0.5", "anthropic-ratelimit-unified-7d-reset": "2000000000" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["-e", `const p = require(${JSON.stringify(SCRIPT)}); (async () => { const a = await p.probeToken("t"); const b = await p.probeToken("t"); console.log(JSON.stringify([a.session && a.session.used, b.weekly && b.weekly.used, a.error, b.error])); })()`], {
        env: { ...process.env, CLAUDE_POOL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cpool-model-")), CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_POOL_PROBE_MODEL: "retired-model" },
      });
      let s = "";
      c.stdout.on("data", (d) => (s += d));
      c.on("exit", () => resolve(s.trim()));
    });
    assert.equal(out, "[25,50,null,null]");
    assert.equal(seen[0], "retired-model");
    assert.notEqual(seen[1], "retired-model");
    assert.equal(seen.length, 3, "second probe went straight to the working model");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- audit fixes (each guards a bug found in review)
const childNode = (code, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", code], { env: { ...process.env, ...env } });
    let out = "", errs = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errs += d));
    c.on("exit", (status) => resolve({ status, out: out.trim(), err: errs.trim() }));
  });

test("an unreadable accounts.json is an error - never treated as empty and overwritten (tokens would be lost); a BOM is fine", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-corrupt-"));
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1" };
  fs.writeFileSync(path.join(home, "accounts.json"), '{"version":1,"accounts":[{"id":"x","name":"keep","token":"' + token("K") + '"');
  const before = fs.readFileSync(path.join(home, "accounts.json"), "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "add", "newone", token("N")], { env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /accounts\.json cannot be read/);
  assert.equal(fs.readFileSync(path.join(home, "accounts.json"), "utf8"), before, "file untouched");
  fs.writeFileSync(path.join(home, "accounts.json"), "﻿" + JSON.stringify({ version: 1, accounts: [{ id: "x", name: "keep", token: token("K") }] }));
  assert.match(spawnSync(process.execPath, [SCRIPT, "list"], { env, encoding: "utf8" }).stdout, /keep/, "BOM tolerated");
  assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "two", token("T")], { env }).status, 0);
  assert.ok(fs.existsSync(path.join(home, "accounts.json.bak")), "last good copy kept");
});

test("pause after an exhausted reading: a reset just passed (clock ahead) re-checks in a minute, not 30; future resets and retry-after win", () => {
  const now = NOW;
  const p = (u) => Math.round((pool.pauseUntilFor(u, now) - now) / 1000);
  assert.equal(p({ session: { used: 100, resetsAt: now - 3000 }, weekly: { used: 10, resetsAt: now + 5 * 86400000 } }), 60);
  assert.equal(p({ session: { used: 100, resetsAt: now + 600000 }, weekly: { used: 10 } }), 600);
  assert.equal(p({ session: { used: 100, resetsAt: now - 3000 }, retryAt: now + 20000 }), 20);
  assert.equal(p({ rateLimited: true }), 1800, "no reset information at all: 30 min");
});

test("account names: an exact name beats a position; find-or-create never lands on 'the second account' for a name like 2", () => {
  const doc = { accounts: [{ name: "work" }, { name: "home" }, { name: "2" }] };
  assert.equal(pool.findAccount(doc, "2").name, "2");
  assert.equal(pool.findAccount(doc, "1").name, "work");
  assert.equal(pool.findAccount({ accounts: [{ name: "work" }, { name: "home" }] }, "2", { byIndex: false }), null);
});

test("args: --resume=<id> / --session-id=<id> are understood; -w is not repeated on a relaunch", () => {
  const a = pool.parseRunArgs(["--resume=abc", "--model=opus"]);
  assert.equal(a.mode, "given");
  assert.equal(a.sessionId, "abc");
  assert.ok(!pool.buildArgs(a, 0, a.sessionId).includes("--session-id"), "no second session flag");
  const w = pool.parseRunArgs(["-w", "feature", "--model", "opus", "fix it"]);
  assert.deepEqual(w.claudeArgs.slice(0, 2), ["-w", "feature"]);
  assert.deepEqual(w.passFlags, ["--model", "opus"]);
});

test("claude resolution: our own shim is never chosen (no launch loop), wherever it lives", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-shimcopy-"));
  const fakeShim = path.join(dir, "claude.exe");
  fs.writeFileSync(fakeShim, "MZ....ClaudePoolShim....");
  const real = path.join(dir, "real", "claude.exe");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, "MZ real claude");
  assert.equal(pool.chooseClaude([fakeShim, real], path.join(dir, "elsewhere")), real);
});

test("npm installs: claude.cmd is run as node <cli.js> (no cmd.exe), and arguments with & \" % reach claude untouched", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-npm-"));
  const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  fs.writeFileSync(path.join(dir, "node.exe"), "not really node"); // npm stubs mention %dp0%\node.exe too
  fs.writeFileSync(path.join(dir, "claude.cmd"), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const c = pool.claudeCommand(path.join(dir, "claude.cmd"));
  assert.equal(c.file, process.execPath);
  assert.deepEqual(c.pre, [path.join(pkg, "cli.js")]);
  const evil = ['summarize the "Q&A" section', "a & echo INJECTED", "%USERNAME%", "100%"];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-npmhome-"));
  const run = spawnSync(process.execPath, [SCRIPT, "shim-run", "-p", ...evil], { env: { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_CLAUDE_BIN: path.join(dir, "claude.cmd") }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(run.stdout), ["-p", ...evil]);
});

test("a 401 is confirmed before an account is marked 'login expired' (a one-off blip must not kill sessions)", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits++;
      if (hits === 1) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"type":"authentication_error","message":"blip"}}');
      res.writeHead(200, { "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-5h-reset": "2000000000", "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-7d-reset": "2000000000" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-401-"));
    const env = { CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}` };
    assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "acct", token("Z")], { env: { ...process.env, ...env } }).status, 0);
    const r = await childNode(`const p = require(${JSON.stringify(SCRIPT)}); (async () => { const a = p.loadAccounts().accounts[0]; const u = await p.getUsage(a, { maxAge: 0 }); console.log(JSON.stringify([u.dead, p.loadAccounts().accounts[0].dead])); })()`, env);
    assert.equal(r.out, "[false,false]", r.err);
    assert.equal(hits, 2);
  } finally {
    server.close();
  }
});

test("login queue: the daemon claims requests with a rename - first comes out, the rest stays queued", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-queue2-"));
  fs.writeFileSync(path.join(home, "login.queue"), "acctA\ta@example.com\r\nacctB\t\r\nacctA\t\r\n");
  const r = await childNode(`const p = require(${JSON.stringify(SCRIPT)}); const f = p.shiftLoginQueue(); console.log(JSON.stringify([f, require("fs").readFileSync(p.LOGIN_QUEUE, "utf8")]))`, { CLAUDE_POOL_HOME: home });
  const [first, rest] = JSON.parse(r.out);
  assert.deepEqual(first, { name: "acctA", email: "a@example.com" });
  assert.equal(rest.trim(), "acctB", "duplicates of the taken name dropped, the rest kept");
});

test("re-logging the default account rewrites the default token for new terminals", async () => {
  const tok1 = token("D1"), tok2 = token("D2");
  const api = await mockApi({ [tok1]: [0.1, 0.1], [tok2]: [0.1, 0.1] });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-fp-"));
    const env = { CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: api.url };
    assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "only", tok1], { env: { ...process.env, ...env } }).status, 0);
    const cycle = `const p = require(${JSON.stringify(SCRIPT)}); p.daemonCycle(false).then(() => console.log("|" + p.loadState().defaultTokenFp));`;
    const r1 = await childNode(cycle, env);
    assert.match(r1.out, /would set user env var/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "only", tok2], { env: { ...process.env, ...env } }).status, 0); // re-login
    const r2 = await childNode(cycle, env);
    assert.match(r2.out, /would set user env var/, "env var rewritten with the new token");
    assert.notEqual(r1.out.split("|").pop(), r2.out.split("|").pop());
    const r3 = await childNode(cycle, env);
    assert.doesNotMatch(r3.out, /would set user env var/, "no rewrite when nothing changed");
  } finally {
    api.server.close();
  }
});

test("lock: a process only removes its own lock, never one another process holds now", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-lock-"));
  const r = await childNode(`const p = require(${JSON.stringify(SCRIPT)}); const fs = require("fs"), path = require("path"); fs.mkdirSync(p.HOME, { recursive: true }); const release = p.acquireLock(); fs.writeFileSync(path.join(p.HOME, "pool.lock", "owner"), "999999:other"); release(); console.log(fs.existsSync(path.join(p.HOME, "pool.lock")));`, { CLAUDE_POOL_HOME: home });
  assert.equal(r.out, "true", r.err);
});

test("widget pid: a reused pid that is some other PowerShell is never treated as the widget (so it is never stopped)", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-wpid-"));
  const other = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 30"], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(path.join(home, "widget.pid"), String(other.pid));
    const r = await childNode(`console.log(require(${JSON.stringify(SCRIPT)}).widgetPid())`, { CLAUDE_POOL_HOME: home });
    assert.equal(r.out, "0", r.err);
  } finally {
    other.kill();
  }
});

test("startWidget writes widget.ps1 with a real UTF-8 BOM and it parses (what the daemon actually launches)", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-wfile-"));
  await childNode(`require(${JSON.stringify(SCRIPT)}).startWidget()`, { CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1" });
  const f = path.join(home, "widget.ps1");
  const b = fs.readFileSync(f);
  assert.deepEqual([...b.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const ps = `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}', [ref]$t, [ref]$e); 'ERRORS=' + @($e).Count`;
  assert.match(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }).stdout, /ERRORS=0/);
});

test("all accounts out: after waiting for a reset, cpool resumes on that same account (it used to give up)", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-wait-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-waitwork-"));
  const tok = token("W");
  const t0 = Date.now();
  const resetS = Math.ceil(t0 / 1000) + 9; // window ends ~9 s in
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const nowS = Date.now() / 1000;
      const out = nowS - t0 / 1000 > 3 && nowS < resetS; // runs out after 3 s, back at the reset
      res.writeHead(200, { "anthropic-ratelimit-unified-5h-utilization": out ? "1.0" : "0.2", "anthropic-ratelimit-unified-5h-reset": String(nowS < resetS ? resetS : resetS + 18000), "anthropic-ratelimit-unified-7d-utilization": "0.1", "anthropic-ratelimit-unified-7d-reset": String(resetS + 86400) });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const outFile = path.join(home, "argv.txt");
  fs.writeFileSync(path.join(home, "fake.js"), `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)) + "\\n"); if (!fs.existsSync(${JSON.stringify(outFile)} + ".1")) { fs.writeFileSync(${JSON.stringify(outFile)} + ".1", ""); setInterval(() => {}, 1000); }`);
  fs.writeFileSync(path.join(home, "fake.cmd"), `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_CACHE_MS: "0", CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_POOL_CLAUDE_BIN: path.join(home, "fake.cmd") };
  try {
    assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "solo", tok], { env }).status, 0);
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [SCRIPT, "run", "--pool-poll", "1", "hi"], { env, cwd: work, stdio: "ignore" });
      const kill = setTimeout(() => c.kill(), 45000);
      c.on("exit", (x) => (clearTimeout(kill), resolve(x)));
    });
    const log = fs.readFileSync(path.join(home, "pool.log"), "utf8");
    assert.equal(code, 0, log);
    assert.match(log, /launch #2 on solo/);
    assert.equal(fs.readFileSync(outFile, "utf8").trim().split("\n").length, 2);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- auto hi + placeholder text
test("auto hi: due 5 s after a 5h reset, once per reset, retry respected, never for weekly-exhausted / dead / not-logged-in", () => {
  const { acc, st } = samplePool();
  const reset = NOW + 30 * MIN;
  for (const u of Object.values(st.usage)) u.session.resetsAt = reset;
  const names = (now, done = {}) => pool.dueHis(acc, st.usage, done, now).map((h) => h.account.name);
  assert.deepEqual(names(reset + 4000), [], "not before the margin");
  // acct3 has 3% weekly left: still due. Make acct4 weekly-exhausted, team dead, personal not logged in.
  st.usage["id-acct4"].weekly.used = 100;
  acc.accounts[4].dead = true;
  acc.accounts[5].token = null;
  assert.deepEqual(names(reset + 5000), ["acct1", "acct2", "acct3"]);
  assert.deepEqual(names(reset + 5000, { "id-acct1": { resetsAt: reset } }), ["acct2", "acct3"], "one hi per reset");
  assert.deepEqual(names(reset + 5000, { "id-acct2": { resetsAt: 0, retryAt: reset + 60000 } }), ["acct1", "acct3"], "waits for retry");
  assert.deepEqual(names(reset + 61000, { "id-acct2": { resetsAt: 0, retryAt: reset + 60000 } }), ["acct1", "acct2", "acct3"]);
});

test("placeholder text until the first login; auto hi line reflects on / off / last hi", () => {
  const { acc, st } = samplePool();
  for (const a of acc.accounts) a.token = null;
  let s = pool.buildSnapshot(acc, st, NOW);
  assert.equal(s.usable.text, "log in to see usage · 0 of 6 logged in");
  assert.deepEqual(s.resets, { h5: "after login", d7: "after login" });
  assert.equal(s.autoHi.text, "on - starts after you log in");
  assert.equal(pool.buildSnapshot(acc, st, NOW, null, [], { on: false }).autoHi.text, "off - cpool autohi on");
  acc.accounts[0].token = token("x");
  s = pool.buildSnapshot(acc, st, NOW, null, [], { on: true, last: { name: "acct2", at: NOW - 10 * MIN } });
  assert.equal(s.autoHi.text, `on · last acct2 at ${clock(NOW - 10 * MIN)}`);
  assert.match(s.resets.h5, /^acct1 in 2h56 /, "real reset lines once someone is logged in, from logged-in accounts only");
  assert.ok(pool.summaryLines(s).includes(`Auto hi    on · last acct2 at ${clock(NOW - 10 * MIN)}`));
});

test("widget shows placeholders for accounts not logged in and the Auto hi line", { skip: process.platform !== "win32" }, () => {
  const now = Date.now();
  const { acc, st } = samplePool(now);
  for (const a of acc.accounts) a.token = null;
  const snap = pool.buildSnapshot(acc, st, now);
  snap.daemon = { pid: 1 };
  const r = widgetSelfTest(snap);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /acct1\|--%\|-h--\|--%\|-d--\|needs login\|\[Log in\]/);
  assert.match(r.out, /Auto hi\|[^|]*\|?.*on - starts after you log in/);
  assert.match(r.out, /after login/);
});

test("daemon sends the hi right after a 5h reset (not at its next 1-minute cycle) and records it", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-hi-"));
  const tok = token("H");
  const resetAt = Math.ceil(Date.now() / 1000) + 4; // window ends 4 s from now
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const nowS = Date.now() / 1000;
      hits.push(Date.now());
      const ended = nowS >= resetAt;
      res.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": ended ? "0.0" : "0.5",
        "anthropic-ratelimit-unified-5h-reset": String(ended ? Math.floor(nowS) + 5 * 3600 : resetAt),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(Math.floor(nowS) + 3 * 86400),
      });
      res.end('{"content":[]}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: `http://127.0.0.1:${server.address().port}` };
  assert.equal(spawnSync(process.execPath, [SCRIPT, "add", "acctH", tok], { env }).status, 0);
  const d = spawn(process.execPath, [SCRIPT, "daemon", "1"], { env, stdio: "ignore" });
  const exited = new Promise((r) => d.on("exit", r));
  try {
    const rec = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, "autohi.json"), "utf8"));
      } catch {
        return null;
      }
    }, 25000, "auto hi record");
    assert.equal(rec.name, "acctH");
    const lag = rec.at - resetAt * 1000;
    assert.ok(lag >= 5000 && lag < 12000, `hi ${lag} ms after the reset (expected ~5 s)`);
    assert.ok(rec.until > Date.now() + 4 * 3600 * 1000, "a new 5h window started");
    const snap = await waitFor(() => {
      const s = readSnap(home);
      return s && /last acctH at/.test(s.autoHi.text) ? s : null;
    }, 20000, "widget data shows the hi");
    assert.equal(snap.rows[0].h5.left, 100);
  } finally {
    fs.writeFileSync(path.join(home, "daemon.stop"), "");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    try {
      d.kill();
    } catch {}
    server.close();
  }
});

// ---------------------------------------------------------------- login: needs-login rows, buttons, token capture
test("accounts without a token read 'needs login', never get the arrow, count in the pool, and overlay login progress", () => {
  const { acc, st } = samplePool();
  acc.accounts[0].token = null; // acct1 (the default) not logged in
  acc.accounts[2].dead = true; // acct3 expired
  let s = pool.buildSnapshot(acc, st, NOW);
  let by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
  assert.deepEqual([by.acct1.status, by.acct1.kind, by.acct1.active], ["needs login", "login", false]);
  assert.deepEqual([by.acct3.status, by.acct3.kind], ["login expired", "dead"]);
  assert.equal(s.needLogin, 2);
  assert.equal(s.usable.total, 6);

  s = pool.buildSnapshot(acc, st, NOW, { name: "ACCT1", state: "browser", at: NOW - MIN }, ["acct3"]);
  by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
  assert.deepEqual([by.acct1.status, by.acct1.kind], ["finish in browser...", "signing"]);
  assert.deepEqual([by.acct3.status, by.acct3.kind], ["queued", "queued"]);
  s = pool.buildSnapshot(acc, st, NOW, { name: "acct1", state: "browser", at: NOW - 3600 * 1000 }, []);
  assert.equal(s.rows[0].kind, "login", "a stale in-progress status (daemon died) does not stick");
});

test("token capture: pseudo-console lines separated by cursor moves never merge into the token", () => {
  const tok = "sk-ant-oat01-" + "Q".repeat(90) + "END1";
  const raw = "\x1b[?9001h\x1b[?25l\x1b[2J\x1b[m\x1b[32m\x1b[H✓ Long-lived authentication token created successfully!\x1b[m\x1b[3;1HYour OAuth token (valid for 1 year):\x1b[33m\x1b[5;1H" +
    tok + "\x1b[m\x1b[7;1HStore this token securely.\r\n\x1b]0;claude\x07";
  assert.equal(pool.tokenFromScreen(raw), tok);
  assert.equal(pool.tokenFromScreen("Your OAuth token\x1b[5;1Hsk-ant-oat01-short\x1b[6;1H"), null, "fragments are not tokens");
});

test("widget: Log in on rows that need it, Log in all, cancel while signing in", { skip: process.platform !== "win32" }, () => {
  const now = Date.now();
  const { acc, st } = samplePool(now);
  acc.accounts[4].token = null;
  acc.accounts[5].token = null;
  acc.accounts[2].dead = true;
  const snap = pool.buildSnapshot(acc, st, now, { name: "acct3", state: "browser", at: now }, []);
  snap.daemon = { pid: 1 };
  const r = widgetSelfTest(snap);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /needs login\|\[Log in\]/);
  assert.match(r.out, /finish in browser\.\.\.\|\[cancel\]/);
  assert.match(r.out, /\[Log in all \(2\)\]\|\[\+ Add account\]/);
  assert.match(r.out, /FOOT=sign in as acct3 in the browser window/);
});

function fakeClaude(dir) {
  fs.writeFileSync(path.join(dir, "fake-claude.js"), [
    'const { spawnSync } = require("child_process");',
    'if (process.env.BROWSER) spawnSync(process.env.BROWSER, ["https://claude.ai/oauth/authorize?code=true&state=abc"], { stdio: "ignore" });',
    'if (!process.stdout.isTTY) { console.log("NOT A TTY"); process.exit(3); }',
    'if (process.env.CLAUDE_CODE_OAUTH_TOKEN) { console.log("ENV TOKEN LEAKED"); process.exit(4); }',
    "setTimeout(() => {",
    '  process.stdout.write("\\x1b[32mLong-lived authentication token created successfully!\\x1b[39m\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n\\x1b[33m" + process.env.FAKE_TOKEN + "\\x1b[39m\\r\\n\\r\\nStore this token securely.\\r\\n");',
    "  setTimeout(() => process.exit(0), 300);",
    "}, Number(process.env.FAKE_DELAY || 400));",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "fake-claude.cmd"), `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`);
  return path.join(dir, "fake-claude.cmd");
}

test("login end to end: real terminal for claude, login_hint added, token stored exactly, never printed, env token not passed on", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-login-"));
  const tok = token("L");
  const api = await mockApi({ [tok]: [0.1, 0.3] });
  const env = {
    ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: api.url, CLAUDE_POOL_CLAUDE_BIN: fakeClaude(home),
    CLAUDE_POOL_LOGIN_BROWSER: "none", FAKE_TOKEN: tok, CLAUDE_CODE_OAUTH_TOKEN: token("ENV"),
  };
  try {
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [SCRIPT, "login", "acctL", "--email", "acct.l@example.com"], { env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("exit", (code) => resolve({ code, out }));
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /login_hint=acct\.l%40example\.com/);
    assert.match(r.out, /acctL logged in \(5h 90% left, 7d 70% left\)/);
    const a = JSON.parse(fs.readFileSync(path.join(home, "accounts.json"), "utf8")).accounts.find((x) => x.name === "acctL");
    assert.equal(a.token, tok);
    assert.equal(a.email, "acct.l@example.com");
    const leaks = r.out + fs.readFileSync(path.join(home, "pool.log"), "utf8") + fs.readFileSync(path.join(home, "login.json"), "utf8");
    assert.ok(!leaks.includes(tok.slice(-20)), "token printed");
  } finally {
    api.server.close();
  }
});

test("daemon runs widget login requests from the queue, and cancel stops a stuck one", { skip: process.platform !== "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-queue-"));
  const tok = token("Q");
  const api = await mockApi({ [tok]: [0.2, 0.2] });
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: api.url, CLAUDE_POOL_CLAUDE_BIN: fakeClaude(home), CLAUDE_POOL_LOGIN_BROWSER: "none", FAKE_TOKEN: tok };
  const d = spawn(process.execPath, [SCRIPT, "daemon", "1"], { env, stdio: "ignore" });
  const exited = new Promise((r) => d.on("exit", r));
  const status = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, "login.json"), "utf8"));
    } catch {
      return null;
    }
  };
  try {
    await waitFor(() => readSnap(home) && readSnap(home).daemon, 10000, "daemon up");
    fs.appendFileSync(path.join(home, "login.queue"), "acctQ\t\r\n");
    await waitFor(() => (status() || {}).state === "done", 20000, "queued login done");
    const snap = await waitFor(() => {
      const s = readSnap(home);
      return s && s.rows.length === 1 && s.rows[0].active ? s : null;
    }, 10000, "the new account becomes the default");
    assert.equal(snap.rows[0].name, "acctQ");
    assert.equal(snap.rows[0].kind, "active");
    assert.equal(snap.rows[0].h5.left, 80);

    // a login that never finishes: cancel from the widget
    const env2 = { ...env, FAKE_DELAY: "120000" };
    const c = spawn(process.execPath, [SCRIPT, "login", "acctSlow"], { env: env2, stdio: "ignore" });
    const cExit = new Promise((r) => c.on("exit", r));
    await waitFor(() => (status() || {}).state === "browser", 15000, "slow login waiting in browser");
    fs.writeFileSync(path.join(home, "login.cancel"), "");
    const code = await Promise.race([cExit, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
    assert.equal(code, 1);
    assert.equal(status().state, "cancelled");
  } finally {
    fs.writeFileSync(path.join(home, "daemon.stop"), "");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    try {
      d.kill();
    } catch {}
    api.server.close();
  }
});

// ---------------------------------------------------------------- daemon end to end against a mock API
function mockApi(levels) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const tok = (req.headers.authorization || "").replace("Bearer ", "");
      const lv = levels[tok];
      hits.push(tok);
      if (!lv) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"type":"authentication_error","message":"bad"}}');
      const reset = Math.floor(Date.now() / 1000) + 3600;
      res.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": String(lv[0]),
        "anthropic-ratelimit-unified-5h-reset": String(reset),
        "anthropic-ratelimit-unified-7d-utilization": String(lv[1]),
        "anthropic-ratelimit-unified-7d-reset": String(reset + 86400),
      });
      res.end('{"content":[]}');
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const readSnap = (home) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "snapshot.json"), "utf8"));
  } catch {
    return null;
  }
};

test("daemon: single instance, writes snapshot + default, honours refresh and stop flags, leaks no token", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpool-daemon-"));
  const tA = token("A"), tB = token("B");
  const api = await mockApi({ [tA]: [0.2, 0.5], [tB]: [0.1, 0.1] }); // B has the most headroom (90 vs 50)
  const env = { ...process.env, CLAUDE_POOL_HOME: home, CLAUDE_POOL_NO_SYSTEM: "1", CLAUDE_POOL_PROBE_URL: api.url };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  assert.equal(run(["add", "acctA", tA]).status, 0);
  assert.equal(run(["add", "acctB", tB]).status, 0);

  let stdout = "", stderr = "";
  const d = spawn(process.execPath, [SCRIPT, "daemon", "1"], { env });
  d.stdout.on("data", (c) => (stdout += c));
  d.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((r) => d.on("exit", r));
  try {
    const snap = await waitFor(() => {
      const s = readSnap(home);
      return s && s.daemon && s.daemon.pid === d.pid && s.rows.every((r) => r.h5.left != null) && s.rows.some((r) => r.active) ? s : null;
    }, 15000, "first snapshot with readings");
    const byName = Object.fromEntries(snap.rows.map((r) => [r.name, r]));
    assert.equal(byName.acctB.active, true, "default goes to the account with the most headroom");
    assert.equal(byName.acctA.active, false);
    assert.deepEqual(byName.acctB.h5.left, 90);
    assert.equal(snap.usable.pct, 70); // (50 + 90) / 2

    const second = run(["daemon", "1"]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already running \(pid \d+\)/);

    const before = api.hits.length;
    fs.writeFileSync(path.join(home, "refresh.flag"), "");
    await waitFor(() => api.hits.length >= before + 2, 8000, "refresh to probe every account");

    fs.writeFileSync(path.join(home, "daemon.stop"), "");
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
    assert.equal(code, 0, "daemon exits cleanly on the stop flag");
    assert.equal(readSnap(home).daemon.stopped, true, "widget can tell the daemon stopped");

    const everything = stdout + stderr + fs.readFileSync(path.join(home, "pool.log"), "utf8") + fs.readFileSync(path.join(home, "snapshot.json"), "utf8");
    for (const t of [tA, tB]) assert.ok(!everything.includes(t.slice(-20)), "token leaked");
  } finally {
    try {
      d.kill();
    } catch {}
    api.server.close();
  }
});
