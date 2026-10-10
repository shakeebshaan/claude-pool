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
  assert.deepEqual(byName.acct1, { name: "acct1", active: true, h5: { left: 22, reset: "2h56" }, d7: { left: 88, reset: "6d21" }, status: "in use", kind: "active", stale: false });
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
  for (const s of ["acct1", "22%", "2h56", "88%", "6d21", "in use", "acct6", "21%", "of 6 accounts", "first acct2 in 56m", "first acct3 in 1d10"]) assert.ok(r.out.includes(s), `missing ${s}: ${r.out}`);
  assert.match(r.out, /FOOT=\s*$/m, "no footer when fresh");
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
  assert.match(widgetSelfTest(null).out, /FOOT=waiting for the pool daemon/);
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
