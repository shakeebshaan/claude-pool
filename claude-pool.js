#!/usr/bin/env node
/*
claude-pool.js - one file, zero dependencies (Node 18+). Keeps several Claude subscriptions as a pool so a
Claude Code session in any cmd window never stalls on a usage limit: when the account a session runs on is
exhausted, the wrapper kills claude, swaps to the account with the most headroom and resumes the SAME
conversation (claude --resume <id>) with the new account's token.

SETUP (once, on the PC that will use it)
  1. Copy this file anywhere, then:            node claude-pool.js install
     -> copies itself to %USERPROFILE%\.claude-pool\, writes cpool.cmd (+ claude-p.cmd) into
        %USERPROFILE%\.claude-pool\bin and adds that folder to the user PATH. Open a NEW cmd window.
  2. For EACH subscription:  log the real `claude` in to that account (claude /login), then run
        claude setup-token                      -> prints a long-lived token (sk-ant-oat01-... / sk-ant-at01-...)
        cpool add acct1                         -> prompts for the token with hidden input (or: cpool add acct1 <token>)
     Repeat for acct2 .. acct6. On Windows the widget's Log in buttons (or cpool login acct1) do this in one click.
  3. cpool limits                               -> table of every account's 5h / 7d limit
  4. cpool                                      -> starts claude on the best account, swaps live on limits
     Any claude arguments pass through:  cpool --model opus "fix the tests"   /   cpool --resume <id>

COMMANDS
  cpool [claude args...]           run (default): launch claude on the best account, auto-swap + resume on limit
  cpool run [claude args...]       same. Wrapper flags (never passed to claude):
                                     --pool-account <name>     start on this account (still swaps later)
                                     --pool-poll <seconds>     probe interval (default 90, env CLAUDE_POOL_POLL_MS)
                                     --pool-no-continue        after a swap, just resume; don't auto-send a prompt
                                     --pool-continue-prompt "<text>"   prompt sent after a swap
                                                               (default "continue where you left off")
  cpool limits                     one table: name, 5h left, 7d left (+time to reset), status
  cpool list                       accounts in pool order (token tails only)
  cpool login <name> [--email <a>] Windows: one-click login - opens a private browser window, you sign in as that
                                   account and click Authorize, the token is captured and stored (creates the account
                                   if needed; --email pre-fills the sign-in page). Same as the widget's Log in button.
                                   CLAUDE_POOL_LOGIN_BROWSER=normal|none: normal window / just print the URL.
  cpool add <name> [token]         add / replace an account (no token = hidden prompt, or pipe it on stdin)
  cpool add <name> --later [--email <a>]   add it as "needs login" (Log in button on the widget)
  cpool remove <name>              remove an account
  cpool rename <old> <new>         rename
  cpool on <name> | off <name>     enable / disable (off = never picked)
  cpool first <name>               move to position 1
  cpool reorder <name> <position>  move to a 1-based position
  cpool reset [name]               clear paused / login-expired flags (all accounts when no name)
  cpool use [name|best|off]        write that token as the USER env var CLAUDE_CODE_OAUTH_TOKEN (setx-style) so
                                   plain `claude` in NEW terminals starts on a live account. `off` removes it.
  cpool daemon [minutes] [--widget]  keep that user-level default pointed at the best account (poll, default 5 min;
                                   switches only when the best has 10+ points more headroom) and write snapshot.json
                                   for the widget every 15 s. One daemon per pool folder. --widget keeps the
                                   desktop widget alive (Windows).
  cpool background [on|off]        Windows: run the daemon (every 2 min) + the desktop widget hidden, now and at
                                   every sign-in (Task Scheduler logon task that also re-checks every 10 min as a
                                   watchdog, plus an HKCU Run entry as backup; both run wscript background.vbs).
                                   No argument = status.
  cpool widget [stop]              show / close the transparent desktop widget (drag to move, right-click for
                                   refresh, add account, re-login account, auto hi, background, lock position, close)
  cpool shim [on|off]              Windows: make plain `claude` start through the pool in new terminals (a small
                                   claude.exe first on the user PATH). Sessions switch accounts on limits;
                                   subcommands, -p, --bg, --version, --help go straight to the real claude.
                                   No argument = status.
  cpool autohi [on|off]            auto hi (default on, part of the daemon): the moment an account's 5h window
                                   resets, send it a 1-token "hi" so the next window starts at once - 24/7 while
                                   the PC is awake. CLAUDE_POOL_AUTO_HI=0 also turns it off.
  cpool install                    write the cpool / claude-p shims and put them on the user PATH
  cpool help

STORAGE   %USERPROFILE%\.claude-pool\   accounts.json (tokens - never printed, only last 4 chars), state.json
          (shared usage cache + live sessions), snapshot.json (widget data, no tokens), pool.lock, pool.log.
          Override the dir with CLAUDE_POOL_HOME. On Windows the folder ACL is locked to the current user (icacls).

ENV OVERRIDES   CLAUDE_POOL_HOME, CLAUDE_POOL_CLAUDE_BIN (path to claude.exe / claude.cmd), CLAUDE_POOL_PROBE_URL
          (API base, default https://api.anthropic.com), CLAUDE_POOL_POLL_MS, CLAUDE_POOL_CACHE_MS (usage cache,
          default 60000), CLAUDE_POOL_CONTINUE=0 (same as --pool-no-continue), CLAUDE_POOL_AUTO_HI=0 (no auto hi),
          CLAUDE_POOL_LOGIN_BROWSER=private|normal|none, CLAUDE_POOL_PROBE_MODEL (limit-probe model; falls back if
          retired), CLAUDE_POOL_NO_SYSTEM=1 (never touch the registry / ACLs / PATH - for tests).

LIMITATIONS
  - Only sessions started through cpool swap live. A plain `claude` started in some other window keeps the token
    it was born with; `cpool use` / `cpool daemon` only fix the default for NEW terminals.
  - The limit probe is a 1-token haiku request (the only way to read the limit headers for setup-tokens), so each
    probe spends a sliver of the account's usage. Probes are cached ~60 s and shared across sessions.
  - Running several subscriptions this way is between the owner and Anthropic's terms.
*/
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

// ---------------------------------------------------------------- config
const IS_WIN = process.platform === "win32";
const num = (v, d) => (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : d);
const HOME = process.env.CLAUDE_POOL_HOME || path.join(os.homedir(), ".claude-pool");
const ACCOUNTS_FILE = path.join(HOME, "accounts.json");
const STATE_FILE = path.join(HOME, "state.json");
const LOCK_DIR = path.join(HOME, "pool.lock");
const LOG_FILE = path.join(HOME, "pool.log");
const API = (process.env.CLAUDE_POOL_PROBE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const POLL_MS = Math.max(1, num(process.env.CLAUDE_POOL_POLL_MS, 90000));
const CACHE_MS = Math.max(0, num(process.env.CLAUDE_POOL_CACHE_MS, 60000));
const NO_SYSTEM = !!process.env.CLAUDE_POOL_NO_SYSTEM;
const TOKEN_RE = /sk-ant-o?at01-[A-Za-z0-9_\-]{40,}/;
const TOKEN_RE_G = /sk-ant-o?at01-[A-Za-z0-9_\-]{20,}/g;
const EXHAUSTED_PCT = 99; // utilization >= 0.99 counts as "out"
const MAX_PAUSE_MS = 8 * 24 * 3600 * 1000; // weekly limits exist; never park longer than 8 days
const DEFAULT_PAUSE_MS = 30 * 60 * 1000; // exhausted but the API gave no reset time
const LOCK_STALE_MS = 15000;
const PROBE_INFLIGHT_MS = 25000;
const UA = "claude-code/2.1.293";
const PROBE_MODEL = "claude-haiku-5-5";
const DEFAULT_CONTINUE_PROMPT = "continue where you left off";
const VERSION = "1.3.0";
// daemon + desktop widget
const SNAPSHOT_FILE = path.join(HOME, "snapshot.json");
const REFRESH_FLAG = path.join(HOME, "refresh.flag");
const STOP_FLAG = path.join(HOME, "daemon.stop");
const WIDGET_PS1 = path.join(HOME, "widget.ps1");
const WIDGET_PID = path.join(HOME, "widget.pid");
const WIDGET_CLOSED = path.join(HOME, "widget.closed");
const BG_VBS = path.join(HOME, "background.vbs");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "claude-pool";
const BG_MINUTES = 2; // probe interval of the background daemon
const SNAPSHOT_EVERY_MS = 15000;
const DAEMON_STALE_MS = 60000; // no snapshot for this long = daemon gone
const SWITCH_MARGIN = 10; // daemon keeps the current default unless the best has this many more points of headroom
const BAR_CELLS = 16;
// one-click login (widget buttons -> daemon -> claude setup-token in a hidden pseudo console)
const LOGIN_QUEUE = path.join(HOME, "login.queue"); // lines "name<TAB>email", appended by the widget
const LOGIN_STATUS = path.join(HOME, "login.json");
const LOGIN_CANCEL = path.join(HOME, "login.cancel");
const LOGIN_TIMEOUT_S = 600;
const LOGIN_BROWSER = (process.env.CLAUDE_POOL_LOGIN_BROWSER || "private").toLowerCase(); // private | normal | none
// auto hi: a 1-token message right after each account's 5h reset starts the next window at once, around the clock
const AUTO_HI_OFF = path.join(HOME, "autohi.off");
const AUTO_HI_LAST = path.join(HOME, "autohi.json");
const HI_DELAY_MS = 5000; // after the announced reset (clock skew margin)
const HI_RETRY_MS = 60000; // window not reset yet / network trouble: try again after this
const autoHiOn = () => process.env.CLAUDE_POOL_AUTO_HI !== "0" && !fs.existsSync(AUTO_HI_OFF);

// ---------------------------------------------------------------- output (always redacted)
const redact = (s) => String(s).replace(TOKEN_RE_G, (m) => "sk-ant-...." + m.slice(-4));
const out = (s = "") => process.stdout.write(redact(s) + "\n");
const err = (s = "") => process.stderr.write(redact(s) + "\n");
const tail = (t) => (t ? "..." + String(t).slice(-4) : "----");
// pool.log rotates at 2 MB (one previous file kept as pool.log.1) so a long-running daemon never fills the disk
let logWrites = 0;
function log(line) {
  try {
    ensureHome();
    if (logWrites++ % 200 === 0) {
      try {
        if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
      } catch {}
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${redact(line)}\n`);
  } catch {}
}

// ---------------------------------------------------------------- small utils
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    const t = Date.now() + ms;
    while (Date.now() < t) {}
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
function fmtLeft(ms) {
  if (ms == null || !isFinite(ms)) return "?";
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}
// compact form for the widget / summary lines: 56m, 2h56, 6d21
function fmtShort(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}`;
}
function fmtClock(ms, now = Date.now()) {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (Math.abs(ms - now) < 20 * 3600 * 1000) return hhmm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${hhmm}`;
}
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}h ` : "") + `${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}
// "--flag value" for the names in withValue, bare "--flag" = true, the rest positional in _
function parseFlags(args, withValue = []) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (withValue.includes(x)) o[x] = args[++i] || "";
    else if (x.startsWith("--")) o[x] = true;
    else o._.push(x);
  }
  return o;
}
function currentUser() {
  let name = "";
  try {
    name = os.userInfo().username;
  } catch {}
  name = name || process.env.USERNAME || process.env.USER || "";
  return IS_WIN && process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

// ---------------------------------------------------------------- storage: lock + atomic json
let homeReady = false;
function ensureHome() {
  if (homeReady) return;
  let created = false;
  if (!fs.existsSync(HOME)) {
    fs.mkdirSync(HOME, { recursive: true });
    created = true;
  }
  homeReady = true;
  if (created) lockDown();
}
// Only the current user may read the folder (tokens live here).
function lockDown() {
  if (NO_SYSTEM) return;
  try {
    if (IS_WIN) {
      const user = currentUser();
      if (!user) return;
      spawnSync("icacls", [HOME, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
    } else {
      fs.chmodSync(HOME, 0o700);
      for (const f of [ACCOUNTS_FILE, STATE_FILE]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
  } catch {}
}

// strict: a file that exists but cannot be read or parsed is an error, never "empty" - used for accounts.json, where
// treating it as empty would let the next write replace every stored token with nothing.
function readJson(file, fallback, { strict = false } = {}) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff/, "")); // tolerate a BOM added by an editor
    } catch (e) {
      if (e.code === "ENOENT") return fallback();
      last = e;
      sleepSync(15 + i * 25); // a writer may be mid-rename or an antivirus scan may hold it (Windows) - retry
    }
  }
  if (strict) throw new Error(`${path.basename(file)} cannot be read (${(last && last.message) || last}) - fix it, or restore ${path.basename(file)}.bak next to it`);
  return fallback();
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (!IS_WIN) {
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 25 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EEXIST"].includes(e.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw e;
      }
      sleepSync(10 + i * 10);
    }
  }
}
// Cross-process lock: mkdir is atomic everywhere. Stale = owner pid gone or older than LOCK_STALE_MS. The owner file
// holds pid + nonce: release only removes our own lock (never one taken over while we were suspended), and a stale lock
// is re-checked right before it is moved away, so two waiters cannot both break it and both proceed.
function acquireLock(timeoutMs = 15000) {
  const ownerFile = path.join(LOCK_DIR, "owner");
  const me = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
  const owner = () => {
    try {
      return fs.readFileSync(ownerFile, "utf8");
    } catch {
      return "";
    }
  };
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      try {
        fs.writeFileSync(ownerFile, me);
      } catch {}
      return () => {
        if (owner() !== me) return; // taken over meanwhile: not ours to remove
        try {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      const seen = owner();
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
        else {
          const pid = Number(seen.split(":")[0]);
          if (pid && pid !== process.pid && !pidAlive(pid) && Date.now() - st.mtimeMs > 500) stale = true;
        }
      } catch {}
      if (stale && owner() === seen) {
        const grave = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
        try {
          fs.renameSync(LOCK_DIR, grave); // atomic: only one waiter wins
          fs.rmSync(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error("could not acquire pool.lock (held by another cpool process)");
      sleepSync(15 + Math.random() * 35);
    }
  }
}
const defaultAccounts = () => ({ version: 1, accounts: [] });
const defaultState = () => ({ version: 1, usage: {}, sessions: {}, defaultAccountId: null });
function normalizeAccounts(a) {
  if (!a || !Array.isArray(a.accounts)) return defaultAccounts();
  for (const x of a.accounts) {
    x.enabled = x.enabled !== false;
    x.pausedUntil = Number(x.pausedUntil) || 0;
    x.dead = !!x.dead;
    x.token = x.token || null; // null = added, not logged in yet
  }
  return a;
}
function normalizeState(s) {
  if (!s || typeof s !== "object") return defaultState();
  s.usage = s.usage && typeof s.usage === "object" ? s.usage : {};
  s.sessions = s.sessions && typeof s.sessions === "object" ? s.sessions : {};
  return s;
}
function loadAccounts() {
  const raw = readJson(ACCOUNTS_FILE, defaultAccounts, { strict: true });
  if (!raw || !Array.isArray(raw.accounts)) throw new Error("accounts.json has no account list - fix it, or restore accounts.json.bak next to it");
  return normalizeAccounts(raw);
}
const loadState = () => normalizeState(readJson(STATE_FILE, defaultState));
// Read-modify-write both files under the lock. fn(accountsDoc, stateDoc) may mutate; only changed docs are written.
function withLock(fn) {
  ensureHome();
  const release = acquireLock();
  try {
    const acc = loadAccounts();
    const st = loadState();
    const a0 = JSON.stringify(acc), s0 = JSON.stringify(st);
    // drop sessions whose process is gone
    for (const k of Object.keys(st.sessions)) if (!pidAlive(Number(k))) delete st.sessions[k];
    const r = fn(acc, st);
    if (JSON.stringify(acc) !== a0) {
      try {
        if (fs.existsSync(ACCOUNTS_FILE)) fs.copyFileSync(ACCOUNTS_FILE, ACCOUNTS_FILE + ".bak"); // last good copy
      } catch {}
      writeJsonAtomic(ACCOUNTS_FILE, acc);
    }
    if (JSON.stringify(st) !== s0) writeJsonAtomic(STATE_FILE, st);
    return r;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- accounts
const newId = () => "a" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
// An exact name always wins; a number is a 1-based position only when no account has that name (byIndex: false for
// "find or create by name" - a login for an account called "2" must never land on the second account).
function findAccount(doc, ref, { byIndex = true } = {}) {
  if (ref == null) return null;
  const s = String(ref).trim();
  const named = doc.accounts.find((a) => a.name.toLowerCase() === s.toLowerCase());
  if (named || !byIndex || !/^\d+$/.test(s)) return named || null;
  return doc.accounts[Number(s) - 1] || null;
}
const accountUsable = (a, now = Date.now()) => a.enabled && !!a.token && !a.dead && !(a.pausedUntil > now);
function statusOf(a, now = Date.now(), inUse = 0) {
  if (!a.enabled) return "off";
  if (!a.token) return "needs login";
  if (a.dead) return "login expired";
  if (a.pausedUntil > now) return `paused until ${fmtClock(a.pausedUntil, now)}`;
  if (inUse) return `in use by ${inUse} session${inUse === 1 ? "" : "s"}`;
  return "ready";
}
function liveSessionsByAccount(state) {
  const m = {};
  for (const s of Object.values(state.sessions || {})) m[s.accountId] = (m[s.accountId] || 0) + 1;
  return m;
}

// ---------------------------------------------------------------- limit probe (copied from the bot's status-panel)
// Setup tokens get 429 from /api/oauth/usage, but every /v1/messages answer carries
// anthropic-ratelimit-unified-{5h,7d}-{utilization,reset} headers; a 1-token haiku call reads them.
// If a model id is retired the probe would 404 forever and limits would never be seen: fall back to the next id and
// remember the one that works (CLAUDE_POOL_PROBE_MODEL overrides the first choice).
const PROBE_MODELS = [...new Set([process.env.CLAUDE_POOL_PROBE_MODEL || PROBE_MODEL, PROBE_MODEL, "claude-haiku-4-5"])];
let probeModelIdx = 0;
async function probeToken(token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const base = { at: Date.now(), http: 0, session: null, weekly: null, rateLimited: false, dead: false, error: null, retryAt: null };
  try {
    let r, text;
    for (let tries = 0; tries < PROBE_MODELS.length; tries++) {
      r = await fetch(`${API}/v1/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify({
          model: PROBE_MODELS[probeModelIdx],
          max_tokens: 1,
          system: "You are Claude Code, Anthropic's official CLI for Claude.",
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: ctl.signal,
      });
      text = await r.text().catch(() => "");
      const modelGone = r.status === 404 && /not_found_error/.test(text) && !r.headers.get("anthropic-ratelimit-unified-5h-utilization");
      if (!modelGone) break;
      log(`probe model ${PROBE_MODELS[probeModelIdx]} not found - trying the next one`);
      probeModelIdx = (probeModelIdx + 1) % PROBE_MODELS.length;
    }
    const h = (k) => r.headers.get(k);
    const win = (p) => {
      const u = h(`anthropic-ratelimit-unified-${p}-utilization`);
      if (u == null) return null;
      const reset = Number(h(`anthropic-ratelimit-unified-${p}-reset`));
      return { used: Number(u) * 100, resetsAt: reset ? reset * 1000 : null };
    };
    const v = { ...base, http: r.status, session: win("5h"), weekly: win("7d") };
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const msg = (body && body.error && body.error.message) || "";
    if (r.status === 401 || (body && body.error && body.error.type === "authentication_error")) {
      v.dead = true;
      v.error = `401 ${msg}`.trim().slice(0, 120);
      return v;
    }
    if (r.status === 429) {
      const type = body && body.error && body.error.type;
      if (!type || type === "rate_limit_error") v.rateLimited = true;
      v.error = `429 ${msg}`.trim().slice(0, 160);
      const ra = Number(h("retry-after"));
      const wait = ra ? ra * 1000 : parseLimitWaitMs(msg);
      v.retryAt = wait ? Date.now() + wait : null;
      return v;
    }
    if (!v.session && !v.weekly) v.error = `no limit headers (HTTP ${r.status})`;
    return v;
  } catch (e) {
    return { ...base, error: String((e && e.message) || e).slice(0, 100) };
  } finally {
    clearTimeout(timer);
  }
}

// How long until a limit resets, from the CLI / API message ("resets 1:50am (UTC)", "try again in 20 minutes",
// weekly "resets Oct 12, 3pm (UTC)"). null when the text gives no time.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseLimitWaitMs(t, nowMs = Date.now()) {
  const s = String(t || "");
  let m = s.match(/(?:try again|retry|wait|available again)\D{0,12}(\d+)\s*(second|minute|hour)s?/i);
  if (m) {
    const n = +m[1], u = m[2].toLowerCase();
    return u === "second" ? n * 1000 : u === "minute" ? n * 60000 : n * 3600000;
  }
  const utc = /\bUTC\b/i.test(s);
  const to24 = (hh, ap) => {
    ap = (ap || "").toLowerCase();
    if (ap === "pm" && hh < 12) return hh + 12;
    if (ap === "am" && hh === 12) return 0;
    return hh;
  };
  m = s.match(/resets?\s+(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = +m[2], hh = m[3] ? to24(+m[3], m[5]) : 0, mm = m[4] ? +m[4] : 0;
    const base = new Date(nowMs);
    const mk = (y) => (utc ? Date.UTC(y, mon, day, hh, mm) : new Date(y, mon, day, hh, mm).getTime());
    let r = mk(base.getUTCFullYear());
    if (r <= nowMs) r = mk(base.getUTCFullYear() + 1);
    return r - nowMs;
  }
  m = s.match(/resets?\D{0,12}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    const hh = to24(+m[1], m[3]), mm = m[2] ? +m[2] : 0;
    const r = new Date(nowMs);
    if (utc) r.setUTCHours(hh, mm, 0, 0);
    else r.setHours(hh, mm, 0, 0);
    if (r.getTime() <= nowMs) r.setTime(r.getTime() + 24 * 3600 * 1000);
    return r.getTime() - nowMs;
  }
  return null;
}

// ---------------------------------------------------------------- judging a reading
const hasData = (u) => !!(u && (u.session || u.weekly));
function judge(u) {
  if (!u) return "unknown";
  if (u.dead) return "dead";
  if (u.rateLimited) return "limited";
  if ((u.session && u.session.used >= EXHAUSTED_PCT) || (u.weekly && u.weekly.used >= EXHAUSTED_PCT)) return "limited";
  return hasData(u) ? "ok" : "unknown";
}
// usable headroom in percent = min(5h left, 7d left); unknown readings sort last but stay pickable
function headroom(u) {
  if (!hasData(u)) return 0;
  const s = u.session ? 100 - u.session.used : 100;
  const w = u.weekly ? 100 - u.weekly.used : 100;
  return Math.max(0, Math.min(s, w));
}
// How long an exhausted account stays paused. Only reset times still ahead count; an exhausted window whose announced
// reset has just passed (PC clock a little ahead of the server) is re-checked in a minute, not parked for 30.
const SHORT_PAUSE_MS = 60000;
const AUTH_RECHECK_MS = Math.max(0, num(process.env.CLAUDE_POOL_AUTH_RECHECK_MS, 5000)); // tests shorten it
function pauseUntilFor(u, now = Date.now()) {
  const future = [], passed = [];
  for (const w of [u.session, u.weekly]) if (w && w.used >= EXHAUSTED_PCT && w.resetsAt) (w.resetsAt > now ? future : passed).push(w.resetsAt);
  let until = future.length ? Math.max(...future) : u.retryAt > now ? u.retryAt : passed.length ? now + SHORT_PAUSE_MS : now + DEFAULT_PAUSE_MS;
  return Math.min(now + MAX_PAUSE_MS, Math.max(now + 5000, until));
}
// Write what a reading means into the account (called under the lock).
function applyReading(a, u, now = Date.now()) {
  if (!a || !u) return;
  const j = judge(u);
  if (j === "dead") {
    a.dead = true;
    a.deadReason = u.error || "auth";
  } else if (j === "limited") {
    a.pausedUntil = pauseUntilFor(u, now);
    a.pauseNote = u.error || "limit reached";
    if (a.dead) a.dead = false; // the token works, it is just out of limit
  } else if (j === "ok") {
    a.dead = false;
    a.deadReason = "";
    if (a.pausedUntil > now) a.pausedUntil = 0; // reset came earlier than announced
    a.pauseNote = "";
  }
}

// ---------------------------------------------------------------- shared usage cache (state.json)
const resetPassed = (c, now) => [c.session, c.weekly].some((w) => w && w.resetsAt && w.resetsAt <= now);
function isFresh(c, maxAge, now = Date.now()) {
  return !!c && !c.probingAt && c.at && now - c.at < maxAge && !resetPassed(c, now);
}
const peekUsage = (id) => loadState().usage[id] || null;
// Cached per account for CACHE_MS; concurrent cpool processes share the reading and never probe the same account
// at the same time (a "probingAt" marker makes the others wait for the first probe's result).
async function getUsage(a, { maxAge = CACHE_MS } = {}) {
  const now = Date.now();
  let c = peekUsage(a.id);
  if (isFresh(c, maxAge, now)) return c;
  const mine = withLock((acc, st) => {
    const u = st.usage[a.id] || {};
    if (isFresh(u, maxAge)) return "fresh";
    if (u.probingAt && Date.now() - u.probingAt < PROBE_INFLIGHT_MS) return false;
    st.usage[a.id] = { ...u, probingAt: Date.now() };
    return true;
  });
  if (mine === "fresh") return peekUsage(a.id);
  if (!mine) {
    for (let i = 0; i < Math.ceil(PROBE_INFLIGHT_MS / 250); i++) {
      await sleep(250);
      c = peekUsage(a.id);
      if (c && !c.probingAt && c.at >= now - maxAge) return c;
    }
  }
  let v = await probeToken(a.token);
  if (v.dead) {
    // one 401 can be a server-side blip: confirm before an account is marked "login expired" and sessions are killed
    await sleep(AUTH_RECHECK_MS);
    const again = await probeToken(a.token);
    if (!again.dead) v = again;
  }
  return withLock((acc, st) => {
    const cur = acc.accounts.find((x) => x.id === a.id);
    if (cur && cur.token !== a.token) {
      // the account was re-logged while this probe ran: this reading is about the old token - keep it out of the pool
      const u = st.usage[a.id];
      if (u && u.probingAt) delete u.probingAt;
      return { ...v, staleToken: true };
    }
    const prev = st.usage[a.id] || null;
    let outv = v;
    const transient = v.error && !hasData(v) && !v.dead && !v.rateLimited;
    if (transient && prev && hasData(prev)) outv = { ...prev, at: Date.now(), stale: true, error: v.error };
    delete outv.probingAt;
    st.usage[a.id] = outv;
    applyReading(cur, outv);
    return outv;
  });
}
function invalidateUsage(id) {
  withLock((acc, st) => {
    delete st.usage[id];
  });
}

// ---------------------------------------------------------------- pick
// Account with the most usable headroom among enabled, not dead, not paused. Tie -> pool order.
async function pickBest({ exclude = [], maxAge = CACHE_MS } = {}) {
  const now = Date.now();
  const cands = loadAccounts().accounts.filter((a) => accountUsable(a, now) && !exclude.includes(a.id));
  if (!cands.length) return null;
  const readings = await Promise.all(cands.map((a) => getUsage(a, { maxAge })));
  const fresh = loadAccounts().accounts; // applyReading may have paused / killed some
  let best = null, bestU = null, bestH = -1;
  cands.forEach((a, i) => {
    const cur = fresh.find((x) => x.id === a.id);
    if (!cur || !accountUsable(cur) || judge(readings[i]) === "limited" || judge(readings[i]) === "dead") return;
    const h = headroom(readings[i]);
    if (h > bestH) (best = cur), (bestU = readings[i]), (bestH = h);
  });
  return best ? { account: best, usage: bestU, headroom: bestH } : null;
}
function earliestReset() {
  const now = Date.now();
  const times = loadAccounts()
    .accounts.filter((a) => a.enabled && !a.dead && a.pausedUntil > now)
    .map((a) => ({ at: a.pausedUntil, account: a }))
    .sort((x, y) => x.at - y.at);
  return times[0] || null;
}

// ---------------------------------------------------------------- claude binary + launching
// Pure. The real claude among the candidates: never one of our own shims (cpool shim puts a claude.exe into
// HOME/bin, first on PATH - launching it would loop back into cpool). .exe beats .cmd.
function chooseClaude(candidates, ownBin, exists = fs.existsSync, isShim = isOurShim) {
  const own = [].concat(ownBin).map((d) => path.resolve(d).toLowerCase());
  const real = candidates.filter((p) => !own.includes(path.resolve(path.dirname(p)).toLowerCase()) && exists(p) && !isShim(p));
  return real.find((p) => /\.exe$/i.test(p)) || real.find((p) => /\.cmd$/i.test(p)) || real[0] || null;
}
// our own claude.exe shim, wherever it is (another CLAUDE_POOL_HOME, a copied bin folder): small, carries its class name
function isOurShim(p) {
  try {
    return fs.statSync(p).size < 512 * 1024 && fs.readFileSync(p).includes("ClaudePoolShim");
  } catch {
    return false;
  }
}
function resolveClaude() {
  const envBin = process.env.CLAUDE_POOL_CLAUDE_BIN;
  if (envBin) return envBin;
  const home = os.homedir();
  const candidates = [];
  if (IS_WIN) {
    // PATH only - not `where`, which looks in the current folder first: a claude.exe dropped into a cloned repo must
    // never be started with a pool token
    for (const d of (process.env.PATH || "").split(";").filter(Boolean)) for (const n of ["claude.exe", "claude.cmd"]) candidates.push(path.join(d.replace(/^"|"$/g, ""), n));
    candidates.push(path.join(home, ".local", "bin", "claude.exe"));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
    return chooseClaude(candidates, [path.join(HOME, "bin"), path.join(path.dirname(__filename), "bin")]) || "claude.cmd";
  }
  try {
    const r = spawnSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" });
    const p = (r.stdout || "").trim();
    if (r.status === 0 && p) return p;
  } catch {}
  for (const p of [path.join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]) if (fs.existsSync(p)) return p;
  return "claude";
}
function childEnv(token) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN") delete env[k];
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}
// How to start claude without cmd.exe. npm installs `claude.cmd`, a stub that runs node on the package's entry script
// (or its native binary); going through cmd.exe would re-parse every argument (`&`, `|`, `%VAR%`, quotes), so a prompt
// could run commands. Read the target out of the stub instead and start it directly.
function claudeCommand(bin) {
  if (!(IS_WIN && /\.(cmd|bat)$/i.test(bin))) return { file: bin, pre: [] };
  try {
    const stub = fs.readFileSync(bin, "utf8");
    const found = [...stub.matchAll(/"%~?dp0%?\\?([^"%]+\.(?:js|mjs|cjs|exe))"/gi)].map((m) => path.join(path.dirname(bin), m[1])).filter((p) => fs.existsSync(p));
    const script = found.find((p) => /\.(?:js|mjs|cjs)$/i.test(p));
    if (script) return { file: process.execPath, pre: [script] };
    const exe = found.find((p) => /\.exe$/i.test(p) && !/[\\/]node\.exe$/i.test(p)); // the stub also names node.exe itself
    if (exe) return { file: exe, pre: [] };
  } catch {}
  return { file: bin, pre: [], shell: true }; // unknown stub: last resort, arguments are quoted for cmd.exe
}
const winQuote = (s) => (/[\s"&|<>^()%!]/.test(s) || s === "" ? `"${s.replace(/(["%!^])/g, "^$1")}"` : s);
function spawnClaude(bin, args, opts) {
  const c = claudeCommand(bin);
  if (c.shell) return spawn([bin, ...args].map(winQuote).join(" "), { ...opts, shell: true });
  return spawn(c.file, [...c.pre, ...args], opts);
}
function launchClaude(bin, args, token, cwd = process.cwd()) {
  return spawnClaude(bin, args, { stdio: "inherit", env: childEnv(token), cwd });
}
function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 3000).unref();
}
const waitExit = (child) =>
  new Promise((resolve) => {
    let done = false;
    child.on("error", (e) => {
      if (done) return;
      done = true;
      resolve({ code: 127, signal: null, error: e });
    });
    child.on("exit", (code, signal) => {
      if (done) return;
      done = true;
      resolve({ code, signal, error: null });
    });
  });
// A killed claude cannot restore the terminal; put it back so the next launch / our prompts behave.
function restoreTty() {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.setRawMode(false);
    }
    if (!IS_WIN && process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: "inherit" });
  } catch {}
}
// Newest session file for this cwd (how we learn the id of a `--continue` / picker-resumed session).
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
// Claude Code keeps ~/.claude/sessions/<pid>.json per running process with the conversation it is on right now.
// Our child is claude itself (native claude.exe) or a shell around it (npm claude.cmd); in the second case the entry
// is found by folder + start time, and must be the only one that matches.
function childSession(childPid, cwd, sinceMs, knownPid = null, parentOf = parentPid) {
  const dir = path.join(claudeDir(), "sessions");
  const read = (pid) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
      // a file left by an earlier process whose pid Windows has since reused started before our launch: not ours
      return j && j.sessionId && !(j.startedAt < sinceMs - 5000) ? { pid, sessionId: j.sessionId, cwd: j.cwd || null } : null;
    } catch {
      return null;
    }
  };
  const direct = read(knownPid || childPid);
  if (direct || knownPid) return direct;
  try {
    const hits = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (j.sessionId && j.cwd && j.cwd.toLowerCase() === cwd.toLowerCase() && j.startedAt >= sinceMs && j.startedAt <= sinceMs + 60000) hits.push({ pid: j.pid, sessionId: j.sessionId, cwd: j.cwd });
      } catch {}
    }
    // must be our own claude: the process our shell child started (another window may have started in this folder too)
    const ours = hits.filter((h) => parentOf(h.pid) === childPid);
    return ours.length === 1 ? ours[0] : null;
  } catch {
    return null;
  }
}
// parent pid of a process (Windows), 0 if unknown
function parentPid(pid) {
  if (!IS_WIN) {
    try {
      return Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }
  const r = psRun("(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:CPOOL_PID)).ParentProcessId", { CPOOL_PID: String(pid) });
  return Number((r.stdout || "").trim()) || 0;
}
// Is a conversation saved under this id in any project folder? (claude --resume <id> finds it from any folder)
function transcriptExists(id) {
  const root = path.join(claudeDir(), "projects");
  try {
    return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`)));
  } catch {
    return false;
  }
}
// Last resort when the registry gave nothing: the conversation written in this folder since the launch - only if it
// is the only one (several claude windows in one folder must never resume each other's conversation).
function findLatestSession(cwd, sinceMs) {
  try {
    const dir = path.join(claudeDir(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    const hits = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.jsonl$/i.test(f) && fs.statSync(path.join(dir, f)).mtimeMs >= sinceMs - 2000);
    return hits.length === 1 ? hits[0].slice(0, -6) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- run args
// claude flags that take a value (so the arg after them is not mistaken for the prompt)
const VALUE_FLAGS = new Set([
  "--model", "--fallback-model", "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--tools", "--permission-mode", "--permission-prompt-tool", "--settings", "--setting-sources", "--mcp-config", "--agents",
  "--agent", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file",
  "--output-format", "--input-format", "--max-turns", "--max-budget-usd", "--json-schema", "--session-id", "--effort",
  "--betas", "--name", "--from-pr", "--worktree", "-w", "--plugin-dir", "--file", "--debug-file", "--pool-account",
  "--pool-poll", "--pool-continue-prompt",
]);
function parseRunArgs(argv) {
  const o = {
    claudeArgs: [], // exactly what the user typed (minus --pool-* flags), used for the first launch
    passFlags: [], // same minus session flags and positional prompts, used for relaunches
    sessionId: null,
    mode: "new", // new | given | continue | picker
    autoContinue: process.env.CLAUDE_POOL_CONTINUE !== "0",
    continuePrompt: DEFAULT_CONTINUE_PROMPT,
    pollMs: POLL_MS,
    account: null,
  };
  // "--resume=<id>" / "--session-id=<id>" / "--worktree=<name>" = the two-word forms
  const a = argv.flatMap((x) => {
    const m = /^(--resume|--session-id|--worktree|--model|--add-dir)=(.*)$/.exec(x);
    return m ? [m[1], m[2]] : [x];
  });
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const next = () => (i + 1 < a.length && !a[i + 1].startsWith("-") ? a[++i] : null);
    if (x === "--pool-no-continue") o.autoContinue = false;
    else if (x === "--pool-continue-prompt") o.continuePrompt = a[++i] || o.continuePrompt;
    else if (x.startsWith("--pool-continue-prompt=")) o.continuePrompt = x.split("=").slice(1).join("=");
    else if (x === "--pool-poll") o.pollMs = Math.max(1000, num(a[++i], POLL_MS / 1000) * 1000);
    else if (x.startsWith("--pool-poll=")) o.pollMs = Math.max(1000, num(x.slice(12), POLL_MS / 1000) * 1000);
    else if (x === "--pool-account") o.account = a[++i] || null;
    else if (x.startsWith("--pool-account=")) o.account = x.slice(15);
    else if (x === "--session-id") {
      o.sessionId = a[++i] || null;
      o.mode = "given";
      o.claudeArgs.push(x, o.sessionId);
    } else if (x === "--resume" || x === "-r") {
      const v = next();
      o.claudeArgs.push(x);
      if (v) {
        o.claudeArgs.push(v);
        o.sessionId = v;
        o.mode = "given";
      } else o.mode = "picker";
    } else if (x === "--continue" || x === "-c") {
      o.mode = "continue";
      o.claudeArgs.push(x);
    } else if (x === "--fork-session") o.claudeArgs.push(x);
    else if (x === "-w" || x === "--worktree") {
      // first launch only: a relaunch runs inside that worktree's folder (see cmdRun) - repeating -w would make a new one
      o.claudeArgs.push(x);
      if (i + 1 < a.length && !a[i + 1].startsWith("-")) o.claudeArgs.push(a[++i]);
    } else if (x.startsWith("-")) {
      o.claudeArgs.push(x);
      o.passFlags.push(x);
      if (VALUE_FLAGS.has(x) && i + 1 < a.length) {
        o.claudeArgs.push(a[i + 1]);
        o.passFlags.push(a[i + 1]);
        i++;
      }
    } else o.claudeArgs.push(x); // positional prompt: first launch only
  }
  return o;
}
function buildArgs(o, launches, sessionId) {
  if (launches === 0) {
    const args = o.claudeArgs.slice();
    if (o.mode === "new" && sessionId) args.push("--session-id", sessionId);
    return args;
  }
  const args = o.passFlags.slice();
  if (sessionId) args.push("--resume", sessionId);
  else args.push("--continue");
  if (o.autoContinue && o.continuePrompt) args.push(o.continuePrompt);
  return args;
}

// ---------------------------------------------------------------- run
function registerSession(accountId, sessionId) {
  withLock((acc, st) => {
    st.sessions[process.pid] = { pid: process.pid, accountId, sessionId: sessionId || null, startedAt: Date.now(), cwd: process.cwd() };
    const a = acc.accounts.find((x) => x.id === accountId);
    if (a) a.lastUsedAt = new Date().toISOString();
  });
}
function unregisterSession() {
  try {
    withLock((acc, st) => {
      delete st.sessions[process.pid];
    });
  } catch {}
}
const leftTxt = (u) => `5h ${u && u.session ? Math.max(0, Math.round(100 - u.session.used)) + "%" : "?"} left, 7d ${u && u.weekly ? Math.max(0, Math.round(100 - u.weekly.used)) + "%" : "?"} left`;

async function waitForReset(interruptRef) {
  const e = earliestReset();
  if (!e) return false;
  const total = loadAccounts().accounts.filter((a) => a.enabled && !a.dead).length;
  out(`[pool] all ${total} accounts are out of limit - soonest: ${e.account.name} resets at ${fmtClock(e.at)} (in ${fmtLeft(e.at - Date.now())}). Waiting; Ctrl+C to stop.`);
  log(`waiting for ${e.account.name} until ${new Date(e.at).toISOString()}`);
  const tty = process.stdout.isTTY;
  for (let tick = 0; Date.now() < e.at + 1500; tick++) {
    if (interruptRef.interrupted) return false;
    // an account may come back early (auto hi, a reset sooner than announced, a re-login): stop waiting then
    if (tick > 0 && tick % 15 === 0 && loadAccounts().accounts.some((a) => accountUsable(a))) break;
    const line = `[pool] resuming on ${e.account.name} in ${fmtCountdown(e.at + 1500 - Date.now())}`;
    if (tty) process.stdout.write(`\r${line.padEnd(70)}`);
    else if (Math.floor((e.at + 1500 - Date.now()) / 1000) % 30 === 0) out(line);
    await sleep(1000);
  }
  if (tty) process.stdout.write("\r" + " ".repeat(70) + "\r");
  withLock((acc) => {
    const a = acc.accounts.find((x) => x.id === e.account.id);
    if (a && a.pausedUntil <= Date.now() + 2000) a.pausedUntil = 0;
  });
  invalidateUsage(e.account.id);
  return true;
}

async function cmdRun(argv) {
  const o = parseRunArgs(argv);
  const bin = resolveClaude();
  if (!loadAccounts().accounts.length) {
    err("[pool] no accounts yet. On each subscription run `claude setup-token`, then `cpool add <name>`.");
    return 2;
  }
  let sessionId = o.sessionId || (o.mode === "new" ? crypto.randomUUID() : null);
  let launches = 0, swaps = 0;
  let child = null;
  let pendingSwap = null; // { from, reason, waited }
  let runCwd = process.cwd(); // after a swap: the folder the conversation was running in (a -w worktree, say)
  const intr = { interrupted: false };
  const onSigint = () => {
    if (child) return; // claude owns the terminal; it handles Ctrl+C itself
    intr.interrupted = true;
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);
  const swapTimes = [];
  try {
    for (;;) {
      if (intr.interrupted) return 130;
      let picked = null;
      if (launches === 0 && o.account) {
        const a = findAccount(loadAccounts(), o.account);
        if (!a) err(`[pool] no account named ${o.account} - picking the best one instead`);
        else if (!accountUsable(a)) err(`[pool] ${a.name} is ${statusOf(a)} - picking the best one instead`);
        else picked = { account: a, usage: await getUsage(a) };
        if (picked && (judge(picked.usage) === "limited" || judge(picked.usage) === "dead")) {
          err(`[pool] ${a.name} is ${judge(picked.usage)} - picking the best one instead`);
          picked = null;
        }
      }
      // right after a swap the exhausted account is left out - but not once we have waited for its reset
      if (!picked) picked = await pickBest({ exclude: pendingSwap && !pendingSwap.waited ? [pendingSwap.from.id] : [] });
      if (!picked) {
        if (!earliestReset()) {
          err("[pool] no usable account: every account is off or its login expired. `cpool limits` / `cpool add`.");
          return 2;
        }
        const ok = await waitForReset(intr);
        if (!ok) return 130;
        if (pendingSwap) pendingSwap.waited = true;
        continue;
      }
      const a = picked.account;
      if (pendingSwap) {
        out(`[pool] ${pendingSwap.from.name} ${pendingSwap.reason === "dead" ? "login expired" : "out of limit"} -> switching to ${a.name}, resuming session`);
        log(`swap ${pendingSwap.from.name} -> ${a.name} (${pendingSwap.reason}) session ${sessionId || "latest"}`);
        pendingSwap = null;
        swapTimes.push(Date.now());
        if (swapTimes.filter((t) => t > Date.now() - 10 * 60000).length > 20) {
          err("[pool] more than 20 swaps in 10 minutes - something is wrong, stopping.");
          return 3;
        }
      } else {
        out(`[pool] ${a.name} (${leftTxt(picked.usage)}) - session ${sessionId || "(claude picks)"}`);
      }
      let args = buildArgs(o, launches, sessionId);
      if (launches > 0 && (!sessionId || !transcriptExists(sessionId))) {
        // Nothing saved under that id (an empty session), or the conversation could not be identified: resuming would
        // fail, and --continue could pick up another window's conversation in this folder - start fresh instead.
        log(sessionId ? `no transcript for session ${sessionId} - starting a new session` : "conversation unknown - starting a new session");
        out(`[pool] ${sessionId ? `no saved conversation for session ${sessionId}` : "could not tell which conversation to resume"} - starting a new session on ${a.name}`);
        sessionId = crypto.randomUUID();
        args = [...o.passFlags, "--session-id", sessionId];
      }
      const startedAt = Date.now();
      registerSession(a.id, sessionId);
      let swapping = null;
      child = launchClaude(bin, args, a.token, runCwd);
      log(`launch #${launches + 1} on ${a.name} pid ${child.pid}: ${bin} ${args.join(" ")}${runCwd !== process.cwd() ? ` (in ${runCwd})` : ""}`);
      // Follow the conversation claude is actually on: /resume or /clear inside claude switch it to another id.
      const tracked = { pid: null, sessionId: null, cwd: null };
      const launchCwd = runCwd;
      const track = () => {
        const s = child && childSession(child.pid, launchCwd, startedAt, tracked.pid);
        if (s) Object.assign(tracked, s);
      };
      const tracker = setInterval(track, 3000);
      const me = child; // a check that finishes after this launch ended must never touch the next one
      const monitor = setInterval(async () => {
        if (child !== me || swapping) return;
        try {
          const u = await getUsage(a, { maxAge: Math.min(CACHE_MS, o.pollMs) });
          const j = judge(u);
          if (child === me && !swapping && (j === "limited" || j === "dead")) {
            swapping = j;
            track(); // last look before the process goes
            withLock((acc) => applyReading(acc.accounts.find((x) => x.id === a.id), u));
            log(`monitor: ${a.name} is ${j} (${u.error || leftTxt(u)}) - killing pid ${child.pid}`);
            killTree(child);
          }
        } catch (e) {
          log(`monitor error: ${e.message}`);
        }
      }, o.pollMs);
      const res = await waitExit(child);
      clearInterval(monitor);
      clearInterval(tracker);
      if (tracked.sessionId && tracked.sessionId !== sessionId) {
        log(`session ${sessionId || "(new)"} -> ${tracked.sessionId} (switched inside claude)`);
        sessionId = tracked.sessionId;
      }
      if (tracked.cwd && fs.existsSync(tracked.cwd)) runCwd = tracked.cwd;
      child = null;
      launches++;
      unregisterSession();
      restoreTty();
      if (res.error) {
        err(`[pool] could not start claude (${bin}): ${res.error.message}. Set CLAUDE_POOL_CLAUDE_BIN to the claude executable.`);
        return 127;
      }
      if (!sessionId) sessionId = findLatestSession(launchCwd, startedAt);
      if (swapping) {
        pendingSwap = { from: a, reason: swapping };
        swaps++;
        continue;
      }
      if (res.code !== 0) {
        // claude may have died on "Failed to authenticate" or a limit we could not see (stdio is inherited)
        const u = await getUsage(a, { maxAge: 0 });
        const j = judge(u);
        if (j === "limited" || j === "dead") {
          pendingSwap = { from: a, reason: j };
          continue;
        }
      }
      log(`claude exited ${res.code}${res.signal ? " signal " + res.signal : ""} after ${launches} launch(es), ${swaps} swap(s)`);
      return res.code == null ? 1 : res.code;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    unregisterSession();
  }
}

// ---------------------------------------------------------------- limits / list
function table(rows, headers) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
  return [line(headers), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}
const pctCell = (w, now) => {
  if (!w) return "n/a";
  const left = Math.max(0, Math.min(100, Math.round(100 - w.used)));
  return `${String(left).padStart(3)}%` + (w.resetsAt ? ` (${fmtLeft(w.resetsAt - now)})` : "");
};
async function cmdLimits() {
  const doc = loadAccounts();
  if (!doc.accounts.length) {
    out("no accounts. `cpool add <name>` after `claude setup-token`.");
    return 0;
  }
  await Promise.all(doc.accounts.filter((a) => a.enabled && a.token).map((a) => getUsage(a)));
  const now = Date.now();
  const fresh = loadAccounts();
  const st = loadState();
  const inUse = liveSessionsByAccount(st);
  const rows = fresh.accounts.map((a, i) => {
    const u = st.usage[a.id] || null;
    return [
      String(i + 1),
      a.name,
      tail(a.token),
      a.enabled ? pctCell(u && u.session, now) : "-",
      a.enabled ? pctCell(u && u.weekly, now) : "-",
      statusOf(a, now, inUse[a.id] || 0) + (u && u.stale ? " (last known)" : "") + (a.enabled && u && !hasData(u) && u.error && !a.dead ? ` [${u.error}]` : ""),
    ];
  });
  out(table(rows, ["#", "Account", "Token", "5h left", "7d left", "Status"]));
  const best = await pickBest();
  out("");
  out(best ? `next session starts on: ${best.account.name} (usable ${Math.round(best.headroom)}% = min of 5h/7d left)` : "no account is ready right now");
  out("");
  let cli = cliInfo();
  if (cli && !cli.usage) {
    const v = await fetchCliUsage(); // no daemon (or stale): read it now
    if (v && !v.error && v.email === cli.email) cli = { ...cli, usage: { session: v.session, weekly: v.weekly } };
  }
  const snap = buildSnapshot(loadAccounts(), liveState(loadState()), Date.now(), null, [], { on: autoHiOn(), last: readJson(AUTO_HI_LAST, () => null) }, cli);
  for (const l of summaryLines(snap)) out(l);
  return 0;
}

// ---------------------------------------------------------------- snapshot (what the desktop widget shows)
// Pure: (accounts doc, state doc, now) -> display model. Names and numbers only - never a token.
const clampPct = (x) => Math.max(0, Math.min(100, x));
function windowCell(w, now) {
  if (!w) return { left: null, reset: "" };
  return { left: Math.round(clampPct(100 - w.used)), reset: w.resetsAt && w.resetsAt > now ? fmtShort(w.resetsAt - now) : "" };
}
function rowStatus(a, u, now, sessions, active) {
  if (!a.enabled) return { text: "off", kind: "off" };
  if (!a.token) return { text: "needs login", kind: "login" };
  if (a.dead) return { text: "login expired", kind: "dead" };
  if (a.pausedUntil > now) return { text: `paused to ${fmtClock(a.pausedUntil, now)}`, kind: "paused" };
  // in use = a live cpool session runs on it; new terminals = the daemon's default (CLAUDE_CODE_OAUTH_TOKEN), which
  // only processes started after it was set pick up - an IDE opened earlier keeps its own claude /login
  if (active) return { text: sessions > 1 ? `in use (${sessions})` : sessions ? "in use" : "new terminals", kind: "active" };
  if (!hasData(u)) return { text: u && u.error ? "no data" : "checking", kind: "unknown" };
  return { text: "ready", kind: "ready" };
}
// "first acct2 in 36m - all in 4h56 (09:20)": soonest and latest reset among accounts that used that window.
function resetLine(pool, usage, key, now) {
  const c = [];
  let any = false;
  for (const a of pool) {
    const w = !a.dead && a.token && usage[a.id] && usage[a.id][key];
    if (!w) continue;
    any = true;
    if (w.used > 0 && w.resetsAt > now) c.push({ name: a.name, at: w.resetsAt });
  }
  if (!c.length) return any ? "all full" : "-";
  c.sort((x, y) => x.at - y.at);
  const first = c[0], last = c[c.length - 1];
  const clock = fmtClock(last.at, now);
  if (c.length === 1) return `${first.name} in ${fmtShort(first.at - now)} (${clock})`;
  return `first ${first.name} in ${fmtShort(first.at - now)} \u00b7 all in ${fmtShort(last.at - now)} (${clock})`;
}
// The arrow (active) marks the account new terminals log in with (daemon default) and accounts with live cpool sessions.
// Usable = weekly budget left across the pool: sum of 7d left / (enabled accounts x 100).
// login = { name, state, message, at } of the current / last widget login, queue = names waiting for their turn.
const LOGIN_BUSY = { starting: "opening browser...", browser: "finish in browser...", saving: "saving..." };
// hi = { on, last: { name, at } } of auto hi. Until some account is logged in, the summary lines say what will appear.
// cli = { email, org } of `claude /login` (~/.claude.json): what claude uses when CLAUDE_CODE_OAUTH_TOKEN is not set.
function buildSnapshot(accDoc, state, now = Date.now(), login = null, queue = [], hi = { on: true, last: null }, cli = null) {
  const sessions = liveSessionsByAccount(state);
  const pool = accDoc.accounts.filter((a) => a.enabled);
  const rows = accDoc.accounts.map((a) => {
    const u = state.usage[a.id] || null;
    const n = sessions[a.id] || 0;
    const active = a.enabled && !!a.token && (n > 0 || state.defaultAccountId === a.id);
    let s = rowStatus(a, u, now, n, active);
    const mine = login && login.name.toLowerCase() === a.name.toLowerCase() && now - login.at < (LOGIN_TIMEOUT_S + 120) * 1000;
    if (mine && LOGIN_BUSY[login.state]) s = { text: LOGIN_BUSY[login.state], kind: "signing" };
    else if (queue.some((q) => q.toLowerCase() === a.name.toLowerCase())) s = { text: "queued", kind: "queued" };
    return {
      name: a.name,
      active,
      h5: windowCell(a.enabled && a.token && u ? u.session : null, now), // no token = no numbers, not stale ones
      d7: windowCell(a.enabled && a.token && u ? u.weekly : null, now),
      status: s.text,
      kind: s.kind,
      stale: !!(u && u.stale),
    };
  });
  let left7 = 0;
  for (const a of pool) {
    const u = state.usage[a.id];
    if (a.dead || !a.token || !hasData(u)) continue;
    left7 += u.weekly ? clampPct(100 - u.weekly.used) : 100;
  }
  const pct = pool.length ? left7 / pool.length : 0;
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS)));
  const eq = Math.floor(Math.round(left7) / 10) / 10; // floor: "~1.2" never overstates
  const loggedIn = pool.filter((a) => a.token && !a.dead).length;
  const waiting = pool.length > 0 && loggedIn === 0; // placeholder text until the first login
  const hiText = !hi.on ? "off - cpool autohi on" : waiting ? "on - starts after you log in" : hi.last ? `on \u00b7 last ${hi.last.name} at ${fmtClock(hi.last.at, now)}` : "on \u00b7 sends hi at every 5h reset";
  const def = accDoc.accounts.find((a) => a.id === state.defaultAccountId && a.enabled && a.token);
  const cliEmail = cli && cli.email ? String(cli.email) : "";
  // which pool account IS the /login account: an email you gave it, else its usage windows (never a name guess)
  const byEmail = cliEmail && accDoc.accounts.find((a) => a.email && a.email.toLowerCase() === cliEmail.toLowerCase());
  const cliAcct = byEmail || (cli && matchCliAccount(accDoc, state.usage, cli.usage));
  // matched by usage under a name that is not the mailbox: show the real email so crossed names are visible
  const crossed = cliAcct && !byEmail && cliAcct.name.toLowerCase() !== cliEmail.split("@")[0].toLowerCase();
  const cliText = !cliAcct ? cliEmail : crossed ? `${cliAcct.name} (${cliEmail})` : cliAcct.name;
  const loginsText = `new terminals \u2192 ${def ? def.name : "their own claude /login"}` + (cliEmail ? ` \u00b7 claude /login \u2192 ${cliText}` : "");
  return {
    version: 1,
    generatedAt: now,
    empty: !accDoc.accounts.length,
    rows,
    usable: {
      pct: Math.round(pct),
      filled,
      cells: BAR_CELLS,
      accounts: eq,
      total: pool.length,
      text: waiting
        ? `log in to see usage \u00b7 0 of ${pool.length} logged in`
        : `${Math.round(pct)}% \u00b7 \u2248${eq.toFixed(1)} of ${pool.length} account${pool.length === 1 ? "" : "s"}`,
    },
    resets: waiting
      ? { h5: "after login", d7: "after login" }
      : { h5: resetLine(pool, state.usage, "session", now), d7: resetLine(pool, state.usage, "weekly", now) },
    autoHi: { on: !!hi.on, text: hiText },
    logins: { text: loginsText, cli: cliAcct ? cliAcct.name : cliEmail || null },
    needLogin: rows.filter((r) => r.kind === "login" || r.kind === "dead").length,
    login: login ? { name: login.name, state: login.state, message: login.message || "", at: login.at } : null,
  };
}
function summaryLines(snap) {
  const u = snap.usable;
  return [
    `Usable     ${"\u2588".repeat(u.filled)}${"\u2591".repeat(u.cells - u.filled)}  ${u.text}`,
    `5h resets  ${snap.resets.h5}`,
    `7d resets  ${snap.resets.d7}`,
    `Auto hi    ${snap.autoHi.text}`,
    `Logins     ${snap.logins.text}`,
  ];
}
// Pure. The pool account that is the same Claude account as `claude /login`: its weekly window (and 5h window when
// both have one) must agree - reset within 2 minutes, use within 10 points - and only one account may match.
// Reset times alone can coincide between accounts, so no match / several matches = null, never a guess.
function matchCliAccount(accDoc, usage, cliUsage) {
  if (!cliUsage || !cliUsage.weekly || !cliUsage.weekly.resetsAt) return null;
  const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
  const same = (w, v) => near(w.resetsAt, v.resetsAt, 120000) && near(w.used, v.used, 10);
  const hits = accDoc.accounts.filter((a) => {
    const u = a.token && usage[a.id];
    if (!u || !u.weekly || !same(cliUsage.weekly, u.weekly)) return false;
    return !cliUsage.session || !u.session || !cliUsage.session.resetsAt || same(cliUsage.session, u.session);
  });
  return hits.length === 1 ? hits[0] : null;
}
// Usage of the `claude /login` account from the official /api/oauth/usage endpoint (what /usage shows; spends no
// tokens). Reads the access token Claude Code keeps in ~/.claude/.credentials.json, read-only: never refreshed, never
// stored or printed, skipped when expired or missing (macOS keeps it in the Keychain).
const CLI_USAGE_FILE = path.join(HOME, "cli-usage.json");
const CLI_USAGE_EVERY_MS = 5 * 60000;
async function fetchCliUsage() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  let cred;
  try {
    cred = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth || {};
  } catch {
    return null;
  }
  if (!cred.accessToken || (cred.expiresAt && cred.expiresAt < Date.now() + 60000)) return null;
  const login = readClaudeLogin();
  const base = { at: Date.now(), email: login ? login.email : null };
  try {
    const r = await fetch(`${API}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ...base, error: `HTTP ${r.status}` };
    const j = await r.json();
    const w = (x) => (x && x.utilization != null ? { used: Number(x.utilization), resetsAt: x.resets_at ? Date.parse(x.resets_at) : null } : null);
    return { ...base, session: w(j.five_hour), weekly: w(j.seven_day) };
  } catch (e) {
    return { ...base, error: String((e && e.message) || e).slice(0, 100) };
  }
}
// /login account + its latest usage reading (when it is for the same email and under 15 minutes old)
function cliInfo() {
  const login = readClaudeLogin();
  if (!login) return null;
  const u = readJson(CLI_USAGE_FILE, () => null);
  const fresh = u && !u.error && u.email === login.email && Date.now() - u.at < 15 * 60000;
  return { ...login, usage: fresh ? { session: u.session, weekly: u.weekly } : null };
}
// The account `claude /login` is signed in to (shown by /status). Cached by file time; ~/.claude.json can be large.
let cliCache = { mtime: 0, value: null };
function readClaudeLogin() {
  try {
    const f = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
    const m = fs.statSync(f).mtimeMs;
    if (m !== cliCache.mtime) {
      const oa = JSON.parse(fs.readFileSync(f, "utf8")).oauthAccount || {};
      cliCache = { mtime: m, value: oa.emailAddress ? { email: oa.emailAddress, org: oa.organizationName || "" } : null };
    }
    return cliCache.value;
  } catch {
    return null;
  }
}
// state with sessions of dead processes dropped (loadState does not prune; withLock does)
function liveState(st) {
  const sessions = {};
  for (const [k, v] of Object.entries(st.sessions || {})) if (pidAlive(Number(k))) sessions[k] = v;
  return { ...st, sessions };
}
function writeSnapshot(daemon) {
  const snap = buildSnapshot(loadAccounts(), liveState(loadState()), Date.now(), readJson(LOGIN_STATUS, () => null), readLoginQueue().map((q) => q.name), {
    on: autoHiOn(),
    last: readJson(AUTO_HI_LAST, () => null),
  }, cliInfo());
  snap.daemon = daemon || null;
  writeJsonAtomic(SNAPSHOT_FILE, snap);
  return snap;
}
// pid of a live daemon for this pool folder (its snapshot heartbeat is fresh), else 0
function runningDaemonPid(now = Date.now()) {
  const s = readJson(SNAPSHOT_FILE, () => null);
  const d = s && s.daemon;
  if (!d || d.stopped || !d.pid || d.pid === process.pid || now - (s.generatedAt || 0) > DAEMON_STALE_MS) return 0;
  return pidAlive(d.pid) ? d.pid : 0;
}
function cmdList() {
  const doc = loadAccounts();
  if (!doc.accounts.length) return out("no accounts. `cpool add <name>` after `claude setup-token`."), 0;
  const st = loadState();
  const inUse = liveSessionsByAccount(st);
  const now = Date.now();
  out(table(
    doc.accounts.map((a, i) => [String(i + 1), a.name, tail(a.token), statusOf(a, now, inUse[a.id] || 0), (a.addedAt || "").slice(0, 10)]),
    ["#", "Account", "Token", "Status", "Added"]
  ));
  return 0;
}

// ---------------------------------------------------------------- account commands
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let d = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (d += c));
      stdin.on("end", () => resolve((d.trim().split(/\r?\n/)[0] || "").trim()));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(buf.trim());
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
// placeholder account (no token yet): shows up as "needs login" with a Log in button on the widget
function ensureAccount(name, email) {
  return withLock((acc) => {
    let a = findAccount(acc, name, { byIndex: false });
    const created = !a;
    if (!a) {
      a = { id: newId(), name: String(name).slice(0, 40), token: null, enabled: true, addedAt: new Date().toISOString(), pausedUntil: 0, pauseNote: "", dead: false, deadReason: "", lastUsedAt: null };
      acc.accounts.push(a);
    }
    if (email) a.email = String(email).trim();
    return { id: a.id, name: a.name, email: a.email || "", created };
  });
}
async function cmdAdd(args) {
  const flags = parseFlags(args, ["--email"]);
  const [name, token0] = flags._;
  let token = token0;
  if (!name || name.startsWith("-")) return err("usage: cpool add <name> [token] [--email <address>] [--later]"), 2;
  if (flags["--later"]) {
    const r = ensureAccount(name, flags["--email"]);
    out(`[pool] ${r.created ? "added" : "updated"} ${r.name}${r.email ? ` (${r.email})` : ""} - not logged in yet: Log in on the widget, or cpool login ${r.name}`);
    return 0;
  }
  if (!token) token = await promptHidden(`paste the token from \`claude setup-token\` for ${name} (input hidden): `);
  const m = String(token || "").match(TOKEN_RE);
  if (!m) return err("that does not look like a setup token (expected sk-ant-oat01-... / sk-ant-at01-...)."), 2;
  token = m[0];
  const r = withLock((acc) => {
    const existing = findAccount(acc, name);
    const same = acc.accounts.find((a) => a.token === token && a !== existing);
    if (same) return { error: `that token is already in the pool as ${same.name}` };
    if (existing) {
      const replaced = !!existing.token;
      Object.assign(existing, { token, dead: false, deadReason: "", pausedUntil: 0, pauseNote: "", enabled: true });
      if (flags["--email"]) existing.email = flags["--email"];
      return { account: existing, replaced };
    }
    const a = { id: newId(), name: String(name).slice(0, 40), token, enabled: true, addedAt: new Date().toISOString(), pausedUntil: 0, pauseNote: "", dead: false, deadReason: "", lastUsedAt: null };
    if (flags["--email"]) a.email = flags["--email"];
    acc.accounts.push(a);
    return { account: a, position: acc.accounts.length };
  });
  if (r.error) return err(`[pool] ${r.error}`), 2;
  lockDown();
  invalidateUsage(r.account.id);
  out(`[pool] ${r.replaced ? "replaced token of" : "added"} ${r.account.name} (${tail(token)})${r.position ? ` as #${r.position}` : ""}`);
  log(`add ${r.account.name} ${tail(token)}`);
  return 0;
}
function mutate(ref, fn, what) {
  const r = withLock((acc) => {
    const a = findAccount(acc, ref);
    if (!a) return { error: `no account "${ref}"` };
    return fn(acc, a) || { account: a };
  });
  if (r.error) return err(`[pool] ${r.error}`), 2;
  out(`[pool] ${what(r.account)}`);
  log(what(r.account));
  return 0;
}
const cmdRemove = (ref) => mutate(ref, (acc, a) => (acc.accounts.splice(acc.accounts.indexOf(a), 1), { account: a }), (a) => `removed ${a.name} (${tail(a.token)})`);
const cmdRename = (ref, name) => (!name ? (err("usage: cpool rename <old> <new>"), 2) : mutate(ref, (acc, a) => ((a.name = String(name).slice(0, 40)), null), (a) => `renamed to ${a.name}`));
const cmdOn = (ref) => mutate(ref, (acc, a) => ((a.enabled = true), null), (a) => `${a.name} is on`);
const cmdOff = (ref) => mutate(ref, (acc, a) => ((a.enabled = false), null), (a) => `${a.name} is off (never picked)`);
const cmdFirst = (ref) => cmdReorder(ref, 1);
function cmdReorder(ref, pos) {
  const p = Number(pos);
  if (!p || p < 1) return err("usage: cpool reorder <name> <position>  (1-based)"), 2;
  return mutate(ref, (acc, a) => {
    acc.accounts.splice(acc.accounts.indexOf(a), 1);
    acc.accounts.splice(Math.min(p, acc.accounts.length + 1) - 1, 0, a);
    return null;
  }, (a) => `${a.name} is now #${loadAccounts().accounts.findIndex((x) => x.id === a.id) + 1}`);
}
function cmdReset(ref) {
  const n = withLock((acc, st) => {
    const targets = ref ? [findAccount(acc, ref)].filter(Boolean) : acc.accounts;
    for (const a of targets) {
      Object.assign(a, { dead: false, deadReason: "", pausedUntil: 0, pauseNote: "" });
      delete st.usage[a.id];
    }
    return targets.length;
  });
  if (ref && !n) return err(`[pool] no account "${ref}"`), 2;
  out(`[pool] reset ${n} account${n === 1 ? "" : "s"}`);
  return 0;
}

// ---------------------------------------------------------------- use / daemon (machine-wide default)
function setUserEnv(value) {
  if (NO_SYSTEM) return out(`[pool] (CLAUDE_POOL_NO_SYSTEM) would ${value ? "set" : "remove"} user env var CLAUDE_CODE_OAUTH_TOKEN`), true;
  if (IS_WIN) {
    // PowerShell's SetEnvironmentVariable(User) writes HKCU\Environment AND broadcasts WM_SETTINGCHANGE.
    // The value travels in an env var, never on a command line.
    const ps = "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_OAUTH_TOKEN', $env:CLAUDE_POOL_SET_VALUE, 'User')";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      env: { ...process.env, CLAUDE_POOL_SET_VALUE: value || "" },
      stdio: "ignore",
      windowsHide: true,
    });
    // no reg.exe fallback: it would put the token on a command line (visible to process listings and audit logs)
    return r.status === 0;
  }
  const f = path.join(HOME, "env.sh");
  fs.writeFileSync(f, value ? `export CLAUDE_CODE_OAUTH_TOKEN='${value}'\n` : "unset CLAUDE_CODE_OAUTH_TOKEN\n", { mode: 0o600 });
  out(`[pool] wrote ${f} - add \`. ${f}\` to your shell rc so new terminals pick it up`);
  return true;
}
async function cmdUse(ref) {
  if (ref === "off" || ref === "none" || ref === "clear") {
    if (!setUserEnv("")) return err("[pool] could not remove the user env var"), 1;
    withLock((acc, st) => (st.defaultAccountId = null));
    return out("[pool] removed user env var CLAUDE_CODE_OAUTH_TOKEN (new terminals use claude's own login)"), 0;
  }
  let a;
  if (!ref || ref === "best") {
    const p = await pickBest();
    if (!p) return err("[pool] no account is ready right now"), 1;
    a = p.account;
  } else {
    a = findAccount(loadAccounts(), ref);
    if (!a) return err(`[pool] no account "${ref}"`), 2;
    if (!a.token) return err(`[pool] ${a.name} is not logged in yet: cpool login ${a.name}`), 2;
  }
  if (!setDefault(a)) return err("[pool] could not write the user env var"), 1;
  out(`[pool] user env var CLAUDE_CODE_OAUTH_TOKEN -> ${a.name} (${tail(a.token)}). NEW terminals start on it; running claude processes keep their old token.`);
  log(`use ${a.name}`);
  return 0;
}
// Keep the current default while it is usable and within SWITCH_MARGIN points of the best, so near-equal accounts
// do not flap (new terminals and the widget arrow stay put).
function keepDefault(cur, curUsage, bestHeadroom, now = Date.now()) {
  return !!cur && accountUsable(cur, now) && judge(curUsage) === "ok" && headroom(curUsage) + SWITCH_MARGIN > bestHeadroom;
}
// The default account and a fingerprint of the token written for it: re-logging the default account changes its token
// without changing the account, and the env var must follow.
const tokenFp = (t) => crypto.createHash("sha256").update(String(t || "")).digest("hex").slice(0, 16);
function setDefault(a) {
  if (!setUserEnv(a.token)) return false;
  withLock((acc, s) => {
    s.defaultAccountId = a.id;
    s.defaultTokenFp = tokenFp(a.token);
  });
  return true;
}
const DEAD_RECHECK_MS = 30 * 60000;
async function daemonCycle(force) {
  // refresh: re-read every enabled account (paused ones too - a reset may have come early)
  if (force) await Promise.all(loadAccounts().accounts.filter((a) => a.enabled && a.token).map((a) => getUsage(a, { maxAge: 0 })));
  // "login expired" accounts get another look every 30 min: a server-side blip heals itself, no re-login needed
  const deadOnes = loadAccounts().accounts.filter((a) => a.enabled && a.token && a.dead && !((peekUsage(a.id) || {}).at > Date.now() - DEAD_RECHECK_MS));
  await Promise.all(deadOnes.map((a) => getUsage(a, { maxAge: 0 })));
  const p = await pickBest();
  const stamp = new Date().toTimeString().slice(0, 5);
  if (!p) return out(`[pool] ${stamp} no account ready; leaving the default as is`);
  const st = loadState();
  const cur = loadAccounts().accounts.find((a) => a.id === st.defaultAccountId);
  const stay = cur && (cur.id === p.account.id || keepDefault(cur, st.usage[cur.id], p.headroom));
  if (stay) {
    // same account - but if it was re-logged, new terminals must get the new token
    if (st.defaultTokenFp !== tokenFp(cur.token) && setDefault(cur)) log(`daemon: default ${cur.name} token refreshed after a re-login`);
    return;
  }
  if (!setDefault(p.account)) return err(`[pool] ${stamp} could not write the user env var`);
  out(`[pool] ${stamp} default -> ${p.account.name} (${leftTxt(p.usage)})`);
  log(`daemon: default -> ${p.account.name}`);
}
// Auto hi. Accounts whose 5h window has ended and that have not had their hi for that reset yet. done: id ->
// { resetsAt: reset already handled, retryAt }. Weekly-exhausted accounts are skipped: a hi cannot start anything.
function dueHis(accDoc, usage, done, now = Date.now()) {
  const due = [];
  for (const a of accDoc.accounts) {
    if (!a.enabled || !a.token || a.dead) continue;
    const u = usage[a.id];
    const w = u && u.session;
    if (!w || !w.resetsAt || now < w.resetsAt + HI_DELAY_MS) continue;
    if (u.weekly && u.weekly.used >= EXHAUSTED_PCT && u.weekly.resetsAt > now) continue;
    const d = done[a.id];
    if (d && (d.resetsAt >= w.resetsAt || d.retryAt > now)) continue;
    due.push({ account: a, resetsAt: w.resetsAt });
  }
  return due;
}
// The hi is the usual limit probe (1-token haiku "hi"); it also refreshes the reading and clears a 5h pause.
async function sayHi(a, prevReset, done) {
  const u = await getUsage(a, { maxAge: 0 });
  const next = u && u.session ? u.session.resetsAt : null;
  if (u && !u.error && hasData(u) && (!next || next > prevReset)) {
    done[a.id] = { resetsAt: prevReset };
    try {
      writeJsonAtomic(AUTO_HI_LAST, { name: a.name, at: Date.now(), until: next });
    } catch {}
    log(`auto hi: ${a.name} - new 5h window${next ? ` until ${new Date(next).toISOString()}` : ""}`);
    return true;
  }
  done[a.id] = { resetsAt: 0, retryAt: Date.now() + HI_RETRY_MS };
  log(`auto hi: ${a.name} - window not reset yet (${(u && u.error) || "same reset time"}), retrying`);
  return false;
}
function cmdAutoHi(sub) {
  if (sub === "off") fs.writeFileSync(AUTO_HI_OFF, "");
  else if (sub === "on") takeFlag(AUTO_HI_OFF);
  const last = readJson(AUTO_HI_LAST, () => null);
  out(`[pool] auto hi is ${autoHiOn() ? "on" : "off"}${last ? ` - last: ${last.name} at ${fmtClock(last.at)}` : ""}${process.env.CLAUDE_POOL_AUTO_HI === "0" ? " (CLAUDE_POOL_AUTO_HI=0)" : ""}`);
  return 0;
}
// add / remove / rename / on / off / reset / pause changes trigger an immediate cycle
const accountsSig = () => JSON.stringify(loadAccounts().accounts.map((a) => [a.id, a.name, a.enabled, a.dead, a.pausedUntil > 0, tail(a.token)]));
const takeFlag = (f) => {
  try {
    fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
};
async function cmdDaemon(args = []) {
  const minutes = args.find((x) => /^\d+(\.\d+)?$/.test(x));
  const every = Math.max(1, num(minutes, 5)) * 60000;
  const withWidget = IS_WIN && args.includes("--widget");
  const info = { pid: process.pid, everyMs: every, startedAt: Date.now() };
  ensureHome();
  // one daemon per pool folder: claim the heartbeat under the lock
  let other = 0;
  const release = acquireLock();
  try {
    other = runningDaemonPid();
    if (!other) writeSnapshot(info);
  } finally {
    release();
  }
  if (other) return out(`[pool] daemon already running (pid ${other})`), 0;
  for (const f of [STOP_FLAG, REFRESH_FLAG]) takeFlag(f);
  const ls = readJson(LOGIN_STATUS, () => null); // a login cut off by the previous daemon's exit
  if (ls && LOGIN_BUSY[ls.state]) writeJsonAtomic(LOGIN_STATUS, { ...ls, state: "error", message: "interrupted - click Log in again", at: Date.now() });
  out(`[pool] daemon: keeping the user-level CLAUDE_CODE_OAUTH_TOKEN on the best account, checking every ${every / 60000} min. Ctrl+C to stop.`);
  out("[pool] note: only NEW terminals see the change; running plain claude sessions can't be switched (use cpool for live swaps).");
  log(`daemon start, every ${every / 60000} min${withWidget ? ", with widget" : ""}`);
  let stop = false;
  const onSig = () => (stop = true);
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const beat = setInterval(() => {
    try {
      writeSnapshot(info);
    } catch (e) {
      log(`snapshot error: ${e.message}`);
    }
  }, SNAPSHOT_EVERY_MS);
  let sig = null, nextProbe = 0, nextWidget = 0, loginBusy = false, nextCli = 0;
  const hiDone = {}, hiBusy = new Set();
  const snapNow = () => {
    try {
      writeSnapshot(info);
    } catch (e) {
      log(`snapshot error: ${e.message}`);
    }
  };
  try {
    while (!stop && !fs.existsSync(STOP_FLAG)) {
      try {
      // widget Log in buttons append to login.queue; one login at a time, in order
      const req = !loginBusy && shiftLoginQueue();
      if (req) {
        loginBusy = true;
        loginAccount(req.name, { email: req.email, onStatus: snapNow })
          .catch((e) => log(`login error: ${(e && e.stack) || e}`))
          .finally(() => {
            loginBusy = false;
            snapNow();
          });
      }
      if (autoHiOn()) {
        for (const h of dueHis(loadAccounts(), loadState().usage, hiDone)) {
          if (hiBusy.has(h.account.id)) continue;
          hiBusy.add(h.account.id);
          sayHi(h.account, h.resetsAt, hiDone)
            .catch((e) => log(`auto hi error: ${e.message}`))
            .finally(() => {
              hiBusy.delete(h.account.id);
              snapNow();
            });
        }
      }
      const force = takeFlag(REFRESH_FLAG);
      if (force || Date.now() >= nextProbe || accountsSig() !== sig) {
        try {
          await daemonCycle(force);
        } catch (e) {
          err(`[pool] daemon error: ${e.message}`);
          log(`daemon error: ${(e && e.stack) || e}`);
        }
        sig = accountsSig();
        nextProbe = Date.now() + every;
        try {
          writeSnapshot(info);
        } catch (e) {
          log(`snapshot error: ${e.message}`);
        }
      }
      if (Date.now() >= nextCli) {
        nextCli = Date.now() + CLI_USAGE_EVERY_MS; // which pool account the claude /login session is on
        fetchCliUsage()
          .then((v) => {
            if (v && /HTTP 429/.test(v.error || "")) nextCli = Date.now() + 30 * 60000;
            if (v) writeJsonAtomic(CLI_USAGE_FILE, v);
            snapNow();
          })
          .catch((e) => log(`cli usage error: ${e.message}`));
      }
      if (withWidget && Date.now() >= nextWidget) {
        nextWidget = Date.now() + 30000;
        if (!widgetPid() && !fs.existsSync(WIDGET_CLOSED)) startWidget();
      }
      } catch (e) {
        // one bad pass (a locked file, an unreadable accounts.json) must never end the daemon
        log(`daemon loop error: ${(e && e.stack) || e}`);
        await sleep(5000);
      }
      await sleep(1000);
    }
  } finally {
    clearInterval(beat);
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    if (loginChild) spawnSync("taskkill", ["/T", "/F", "/PID", String(loginChild.pid)], { stdio: "ignore", windowsHide: true });
    takeFlag(STOP_FLAG);
    try {
      writeSnapshot({ ...info, stopped: true });
    } catch {}
    log("daemon stop");
  }
  return 0;
}

// ---------------------------------------------------------------- install
// The user PATH (HKCU\Environment\Path) as a list; writing it back also tells running programs, so new terminals see it.
const samePath = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
// Read raw (unexpanded) and carried as base64 UTF-8: reg.exe output is in the console code page, which would turn a
// folder like C:\Users\Jorg into garbage that a later write would make permanent. null = could not read (never write).
function readUserPath() {
  const r = psRun("$v = (Get-Item 'HKCU:\\Environment').GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); if ($null -eq $v) { 'NONE' } else { 'B64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }");
  const s = (r.stdout || "").trim();
  if (r.status !== 0) return null;
  if (s === "NONE") return [];
  const m = /^B64:(\S*)$/m.exec(s);
  return m ? Buffer.from(m[1], "base64").toString("utf8").split(";").filter(Boolean) : null;
}
function writeUserPath(parts) {
  if (!Array.isArray(parts)) return false;
  const old = readUserPath();
  if (old === null) return false;
  try {
    fs.appendFileSync(path.join(HOME, "user-path.bak"), `${new Date().toISOString()} ${old.join(";")}\n`); // undo trail
  } catch {}
  const r = psRun("$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', $env:CPOOL_PATH, [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()", { CPOOL_PATH: parts.join(";") });
  if (r.status !== 0) return false;
  const ps = "$s=Add-Type -Name W -Namespace P -PassThru -MemberDefinition '[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'; [UIntPtr]$r=[UIntPtr]::Zero; $s::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r) | Out-Null";
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore", windowsHide: true });
  return true;
}
function cmdInstall() {
  ensureHome();
  const dest = path.join(HOME, "claude-pool.js");
  if (path.resolve(__filename).toLowerCase() !== path.resolve(dest).toLowerCase()) fs.copyFileSync(__filename, dest);
  const bin = path.join(HOME, "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (IS_WIN) {
    // node: the one that ran install, else node.exe from PATH (%%~$PATH:I never looks in the current folder)
    const shim = [
      "@echo off",
      "setlocal",
      `set "CP_NODE="`,
      `for %%I in (node.exe) do set "CP_NODE=%%~$PATH:I"`,
      `if exist "${process.execPath}" set "CP_NODE=${process.execPath}"`,
      `if not defined CP_NODE (echo cpool: node.exe not found 1>&2 & exit /b 9009)`,
      `"%CP_NODE%" "%~dp0..\\claude-pool.js" %*`,
      "",
    ].join("\r\n");
    for (const n of ["cpool.cmd", "claude-p.cmd"]) fs.writeFileSync(path.join(bin, n), shim);
    out(`[pool] wrote ${path.join(bin, "cpool.cmd")} and claude-p.cmd (both = node claude-pool.js ...; the real \`claude\` is untouched)`);
    if (NO_SYSTEM) out("[pool] (CLAUDE_POOL_NO_SYSTEM) skipped PATH update");
    else {
      const parts = readUserPath();
      if (parts === null) err(`[pool] could not read the user PATH - add this folder yourself: ${bin}`);
      else if (parts.some((p) => samePath(p, bin))) out("[pool] bin folder already on the user PATH");
      else if (!writeUserPath([...parts, bin])) err(`[pool] could not update the user PATH - add this folder yourself: ${bin}`);
      else out(`[pool] added ${bin} to the user PATH - open a NEW cmd window, then type cpool`);
    }
  } else {
    const f = path.join(bin, "cpool");
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/../claude-pool.js" "$@"\n`, { mode: 0o755 });
    try {
      fs.copyFileSync(f, path.join(bin, "claude-p"));
      fs.chmodSync(path.join(bin, "claude-p"), 0o755);
    } catch {}
    out(`[pool] wrote ${f}. Add to your shell rc:  export PATH="${bin}:$PATH"`);
  }
  lockDown();
  out("[pool] next: on each subscription run `claude setup-token`, then `cpool add acct1` ... `cpool limits`, then `cpool`");
  if (IS_WIN) out("[pool] background daemon + desktop widget (now and at every logon): cpool background on");
  return 0;
}

// ---------------------------------------------------------------- one-click login (Windows)
// `claude setup-token` is an interactive screen: it needs a real terminal and prints the token there. A small C# helper
// (compiled once into the pool folder) runs it in a hidden 400-column pseudo console (ConPTY), so the token lands on one
// line that cpool reads, and it is also claude's BROWSER command, so cpool gets the sign-in URL and opens it in a private
// window - sign in as the account you clicked, not whoever the normal browser is signed in as. The token is stored,
// never printed.
const HELPER_SRC = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// claude-pool login helper. "<url>": BROWSER hook, hands the URL to cpool via %CLAUDE_POOL_URL_FILE%.
// "pty <timeoutSec> <exe> [args]" or "pty <timeoutSec> <command line>": runs it in a hidden pseudo console and
// copies its screen output to stdout.
public static class CPoolHelper {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2); sb.Append('"');
    return sb.ToString();
  }

  public static int Main(string[] args) {
    if (args.Length == 1 && (args[0].StartsWith("http://") || args[0].StartsWith("https://"))) {
      string f = Environment.GetEnvironmentVariable("CLAUDE_POOL_URL_FILE");
      if (string.IsNullOrEmpty(f)) return 1;
      File.WriteAllText(f, args[0]);
      return 0;
    }
    if (args.Length >= 3 && args[0] == "pty") return Pty(int.Parse(args[1]), args, 2);
    return 2;
  }

  static int Pty(int timeoutSec, string[] args, int first) {
    SafeFileHandle inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) return 90;
    IntPtr hpc;
    COORD size; size.X = 400; size.Y = 60;
    if (CreatePseudoConsole(size, inRead, outWrite, 0, out hpc) != 0) return 91;
    inRead.Dispose(); outWrite.Dispose(); // the pseudo console holds its own ends
    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrs = Marshal.AllocHGlobal(attrSize);
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref attrSize)) return 92;
    if (!UpdateProcThreadAttribute(attrs, 0, (IntPtr)0x00020016, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) return 93;
    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES with null handles: use the pseudo console, not our redirected stdio
    si.lpAttributeList = attrs;
    var cmd = new StringBuilder();
    if (args.Length == first + 1) cmd.Append(args[first]); // one argument = a ready command line, used verbatim
    else for (int i = first; i < args.Length; i++) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(args[i])); }
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, null, ref si, out pi)) return 94;
    Stream stdout = Console.OpenStandardOutput();
    var reader = new Thread(() => {
      var buf = new byte[8192];
      try {
        using (var fs = new FileStream(outRead, FileAccess.Read)) {
          int n;
          while ((n = fs.Read(buf, 0, buf.Length)) > 0) { stdout.Write(buf, 0, n); stdout.Flush(); }
        }
      } catch { }
    });
    reader.IsBackground = true;
    reader.Start();
    uint wait = WaitForSingleObject(pi.hProcess, timeoutSec <= 0 ? 0xFFFFFFFF : (uint)timeoutSec * 1000);
    uint code = 124;
    if (wait != 0) TerminateProcess(pi.hProcess, 124); else GetExitCodeProcess(pi.hProcess, out code);
    Thread.Sleep(300); // let the last frame through
    ClosePseudoConsole(hpc);
    reader.Join(3000);
    inWrite.Dispose();
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs);
    return (int)code;
  }
}
`;
function ensureHelper() {
  const h = crypto.createHash("sha1").update(HELPER_SRC).digest("hex").slice(0, 8);
  const exe = path.join(HOME, `cpool-helper-${h}.exe`);
  if (fs.existsSync(exe)) return exe;
  ensureHome();
  const src = exe.replace(/\.exe$/, ".cs");
  fs.writeFileSync(src, HELPER_SRC);
  const ps = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CPOOL_SRC)) -OutputAssembly $env:CPOOL_EXE -OutputType WindowsApplication";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    env: { ...process.env, CPOOL_SRC: src, CPOOL_EXE: exe },
    encoding: "utf8",
    windowsHide: true,
  });
  if (!fs.existsSync(exe)) throw new Error(`could not build the login helper: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  for (const f of fs.readdirSync(HOME)) {
    if (/^cpool-helper-[0-9a-f]{8}\.(exe|cs)$/.test(f) && !f.startsWith(`cpool-helper-${h}.`)) {
      try {
        fs.unlinkSync(path.join(HOME, f)); // older versions (an in-use one just stays until next time)
      } catch {}
    }
  }
  return exe;
}
function defaultBrowserExe() {
  const q = (key, val) => {
    const r = spawnSync("reg", ["query", key, ...(val ? ["/v", val] : ["/ve"])], { encoding: "utf8", windowsHide: true });
    return r.status === 0 ? r.stdout : "";
  };
  const prog = (q("HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "ProgId").match(/ProgId\s+REG_SZ\s+(\S+)/i) || [])[1];
  if (!prog) return null;
  const cmd = (q(`HKCR\\${prog}\\shell\\open\\command`).match(/REG_(?:EXPAND_)?SZ\s+(.+)/i) || [])[1] || "";
  const m = cmd.match(/^\s*"([^"]+)"|^\s*(\S+)/);
  const exe = m && (m[1] || m[2]);
  return exe && fs.existsSync(exe) ? exe : null;
}
const PRIVATE_FLAG = { "msedge.exe": "--inprivate", "firefox.exe": "-private-window", "opera.exe": "--private", "launcher.exe": "--private" };
function openSignIn(url) {
  if (LOGIN_BROWSER === "none") return "none";
  const exe = LOGIN_BROWSER === "private" ? defaultBrowserExe() : null;
  if (exe) {
    const base = path.basename(exe).toLowerCase();
    spawn(exe, [PRIVATE_FLAG[base] || "--incognito", url], { detached: true, stdio: "ignore" }).unref(); // chromium family: --incognito
    return "private";
  }
  spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return "default";
}
// The pseudo console separates lines with cursor moves (ESC[7;1H), not newlines: turn those into line breaks so the
// token never runs into the next line's text; colours and other controls just go.
const stripAnsi = (s) =>
  s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*([@-~])/g, (m, f) => ("ABEFHdf".includes(f) ? "\n" : "CG".includes(f) ? " " : ""))
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78DEHMNOZc]/g, "");
function tokenFromScreen(raw) {
  const all = (stripAnsi(raw).match(TOKEN_RE_G) || []).filter((t) => TOKEN_RE.test(t));
  return all.sort((a, b) => b.length - a.length)[0] || null;
}
function screenError(raw) {
  const lines = stripAnsi(raw).split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|fail|denied|invalid|expired|not permit|cancel/i.test(l));
  return lines.length ? redact(lines[lines.length - 1]).slice(0, 140) : "";
}
function readLoginQueue() {
  try {
    return fs.readFileSync(LOGIN_QUEUE, "utf8").replace(/^\ufeff/, "").split(/\r?\n/).map((l) => {
      const [name, email] = l.split("\t");
      return { name: (name || "").trim(), email: (email || "").trim() };
    }).filter((q) => q.name);
  } catch {
    return [];
  }
}
// Take the next request without racing the widget's appends: claim the whole file with an atomic rename, keep the
// first entry, and append the rest back (anything the widget appended meanwhile lands in a fresh login.queue).
function shiftLoginQueue() {
  if (!fs.existsSync(LOGIN_QUEUE)) return null;
  const claim = `${LOGIN_QUEUE}.${process.pid}`;
  try {
    fs.renameSync(LOGIN_QUEUE, claim);
  } catch {
    return null; // the widget is writing it right now: next second
  }
  let q = [];
  try {
    q = fs.readFileSync(claim, "utf8").replace(/^\ufeff/, "").split(/\r?\n/).map((l) => {
      const [name, email] = l.split("\t");
      return { name: (name || "").trim(), email: (email || "").trim() };
    }).filter((x) => x.name);
  } catch {}
  const [first, ...rest] = q;
  const left = first ? rest.filter((x) => x.name.toLowerCase() !== first.name.toLowerCase()) : [];
  if (left.length) fs.appendFileSync(LOGIN_QUEUE, left.map((x) => `${x.name}\t${x.email}\r\n`).join(""));
  takeFlag(claim);
  return first || null;
}
let loginChild = null;
// Runs one login end to end. Resolves to the final status {name, state: done|error|cancelled, message}.
async function loginAccount(name, { email = "", onStatus = () => {} } = {}) {
  const acct = ensureAccount(name, email);
  const status = (state, message = "") => {
    const s = { name: acct.name, state, message: redact(message), at: Date.now() };
    try {
      writeJsonAtomic(LOGIN_STATUS, s);
    } catch {}
    onStatus(s);
    return s;
  };
  if (!IS_WIN) return status("error", "one-click login is Windows-only: claude setup-token, then cpool add <name>");
  status("starting");
  takeFlag(LOGIN_CANCEL);
  let helper;
  try {
    helper = ensureHelper();
  } catch (e) {
    return status("error", e.message);
  }
  const urlFile = path.join(HOME, `login-${process.pid}.url`);
  takeFlag(urlFile);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "CLAUDE_CODE_OAUTH_TOKEN") delete env[k]; // else claude warns about it
  env.BROWSER = helper;
  env.CLAUDE_POOL_URL_FILE = urlFile;
  const bin = resolveClaude();
  const cmdLine = /\.(cmd|bat)$/i.test(bin) ? `"${process.env.ComSpec || "cmd.exe"}" /d /s /c ""${bin}" setup-token"` : `"${bin}" setup-token`;
  const child = (loginChild = spawn(helper, ["pty", String(LOGIN_TIMEOUT_S), cmdLine], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }));
  log(`login ${acct.name}: started`);
  let screen = "", cancelled = false, opened = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    screen += d;
    if (screen.length > 2e6) screen = screen.slice(-1e6);
  });
  const tick = setInterval(() => {
    try {
      if (!opened && fs.existsSync(urlFile)) {
        let url = fs.readFileSync(urlFile, "utf8").trim();
        takeFlag(urlFile);
        if (acct.email && !/[?&]login_hint=/.test(url)) url += (url.includes("?") ? "&" : "?") + "login_hint=" + encodeURIComponent(acct.email);
        opened = true;
        openSignIn(url);
        status("browser", LOGIN_BROWSER === "none" ? url : "");
      }
      if (fs.existsSync(LOGIN_CANCEL)) {
        takeFlag(LOGIN_CANCEL);
        cancelled = true;
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      }
    } catch (e) {
      log(`login tick: ${e.message}`);
    }
  }, 250);
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    child.on("error", () => resolve(-1));
  });
  clearInterval(tick);
  takeFlag(urlFile);
  loginChild = null;
  if (cancelled) return log(`login ${acct.name}: cancelled`), status("cancelled", "login cancelled");
  const token = tokenFromScreen(screen);
  const why = token ? "" : code === 124 ? `not finished within ${LOGIN_TIMEOUT_S / 60} minutes` : screenError(screen) || `sign-in did not finish (exit ${code})`;
  screen = ""; // holds the token - drop it early
  if (!token) {
    log(`login ${acct.name}: failed - ${why}`);
    return status("error", why);
  }
  status("saving");
  const r = withLock((acc) => {
    const a = acc.accounts.find((x) => x.id === acct.id);
    if (!a) return { error: "the account was removed meanwhile" };
    const same = acc.accounts.find((x) => x !== a && x.token === token);
    if (same) return { error: `that token is already in the pool as ${same.name}` };
    Object.assign(a, { token, dead: false, deadReason: "", pausedUntil: 0, pauseNote: "", enabled: true });
    return { ok: true };
  });
  if (r.error) return status("error", r.error);
  lockDown();
  invalidateUsage(acct.id);
  const a = loadAccounts().accounts.find((x) => x.id === acct.id);
  const u = a ? await getUsage(a, { maxAge: 0 }) : null;
  log(`login ${acct.name}: token ${tail(token)} saved, check: ${judge(u)}`);
  if (judge(u) === "dead") return status("error", "the new token was rejected - log in again");
  return status("done", hasData(u) ? leftTxt(u) : "");
}
async function cmdLogin(args) {
  const flags = parseFlags(args, ["--email"]);
  const name = flags._[0];
  if (!name) return err("usage: cpool login <name> [--email <address>]"), 2;
  out(`[pool] ${name}: a ${LOGIN_BROWSER === "private" ? "private " : ""}browser window opens - sign in with that account and click Authorize. Ctrl+C stops.`);
  const onInt = () => {
    if (loginChild) spawnSync("taskkill", ["/T", "/F", "/PID", String(loginChild.pid)], { stdio: "ignore", windowsHide: true });
    process.exit(130);
  };
  process.on("SIGINT", onInt);
  const r = await loginAccount(name, {
    email: flags["--email"] || "",
    onStatus: (s) => {
      if (s.state === "browser") out(s.message ? `[pool] open this URL to sign in: ${s.message}` : "[pool] waiting for you to finish in the browser...");
    },
  });
  process.off("SIGINT", onInt);
  if (r.state === "done") return out(`[pool] ${r.name} logged in${r.message ? ` (${r.message})` : ""}`), 0;
  return err(`[pool] ${r.name}: ${r.message}`), 1;
}

// ---------------------------------------------------------------- `claude` = a pool session (Windows, opt-in)
// cpool shim on: a tiny claude.exe in HOME/bin, first on the user PATH. Typing `claude` runs
// `node claude-pool.js shim-run <same args>`: sessions go through cpool (live account switching); anything that is not
// an interactive session goes straight to the real claude. An .exe rather than a .cmd: no "Terminate batch job (Y/N)?"
// after Ctrl+C and no % expansion in prompts. Apps that run claude by full path (the VS Code panel) are not affected.
const CLAUDE_SUBCOMMANDS = new Set([
  "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp", "plugin", "plugins",
  "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade", "help",
]);
const PASS_FLAGS = new Set(["-p", "--print", "--bg", "-v", "--version", "-h", "--help"]);
const passThrough = (argv, subcommands = CLAUDE_SUBCOMMANDS) => (argv.length > 0 && subcommands.has(argv[0])) || argv.some((a) => PASS_FLAGS.has(a));
// The subcommands of the installed claude, from its `--help` (cached per binary size + time, so only re-read after an
// update): a subcommand added by a future claude still goes straight through instead of becoming a "prompt".
function claudeSubcommands(bin) {
  let key;
  try {
    const st = fs.statSync(bin);
    key = `${bin}|${st.size}|${st.mtimeMs}`;
  } catch {
    return CLAUDE_SUBCOMMANDS;
  }
  const cacheFile = path.join(HOME, "claude-commands.json");
  const c = readJson(cacheFile, () => null);
  let cmds = c && c.key === key && Array.isArray(c.cmds) ? c.cmds : null;
  if (!cmds) {
    const c = claudeCommand(bin);
    const r = c.shell
      ? spawnSync(`"${bin}" --help`, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: true })
      : spawnSync(c.file, [...c.pre, "--help"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    const text = r.stdout || "";
    const i = text.indexOf("Commands:");
    cmds = [];
    if (i >= 0) {
      for (const line of text.slice(i).split(/\r?\n/).slice(1)) {
        const m = line.match(/^ {2}([a-z][\w-]*)((?:\|[a-z][\w-]*)*)/); // "  update|upgrade   Check for updates..."
        if (m) cmds.push(m[1], ...m[2].split("|").filter(Boolean));
      }
    }
    if (r.status === 0) {
      try {
        writeJsonAtomic(cacheFile, { key, cmds }); // cached even when empty: never re-run --help on every launch
      } catch {}
    }
  }
  return new Set([...CLAUDE_SUBCOMMANDS, ...cmds]);
}
async function cmdShimRun(argv) {
  const ready = loadAccounts().accounts.some((a) => a.enabled && a.token && !a.dead);
  if (ready && !passThrough(argv, claudeSubcommands(resolveClaude()))) return cmdRun(argv);
  // not a session, or nothing in the pool yet: be the real claude, untouched
  const bin = resolveClaude();
  const child = spawnClaude(bin, argv, { stdio: "inherit" });
  const ignore = () => {}; // Ctrl+C belongs to claude
  process.on("SIGINT", ignore);
  const res = await waitExit(child);
  process.off("SIGINT", ignore);
  if (res.error) return err(`[pool] could not start claude (${bin}): ${res.error.message}`), 127;
  return res.code == null ? 1 : res.code;
}
const SHIM_SRC = String.raw`using System;
using System.Diagnostics;
using System.IO;

// claude-pool shim (cpool shim on): typing claude runs  node claude-pool.js shim-run <the same arguments>.
public static class ClaudePoolShim {
  const string NODE = NODE_PATH_LITERAL;
  public static int Main(string[] args) {
    Console.CancelKeyPress += (s, e) => { e.Cancel = true; }; // Ctrl+C belongs to claude, not to this shim
    string dir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    string script = Path.GetFullPath(Path.Combine(dir, "..", "claude-pool.js"));
    string node = FindNode();
    if (node == null) { Console.Error.WriteLine("claude (claude-pool shim): node.exe not found - cpool shim off restores the real claude"); return 9009; }
    var psi = new ProcessStartInfo(node, "\"" + script + "\" shim-run " + RawArgs());
    psi.UseShellExecute = false;
    try {
      using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    } catch (Exception e) {
      Console.Error.WriteLine("claude (claude-pool shim): could not start node: " + e.Message + " - cpool shim off restores the real claude");
      return 127;
    }
  }
  // the node that ran cpool shim on, else node.exe from PATH (never from the current folder)
  static string FindNode() {
    if (File.Exists(NODE)) return NODE;
    foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
      string dir = d.Trim().Trim('"');
      if (dir.Length == 0) continue;
      try { string p = Path.Combine(dir, "node.exe"); if (File.Exists(p)) return p; } catch { }
    }
    return null;
  }
  // everything after the program name, exactly as typed (no re-quoting)
  static string RawArgs() {
    string cl = Environment.CommandLine;
    int i = 0;
    if (cl.Length > 0 && cl[0] == '"') { i = cl.IndexOf('"', 1); i = i < 0 ? cl.Length : i + 1; }
    else { while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++; }
    return cl.Substring(i).TrimStart();
  }
}
`;
function buildShim() {
  ensureHome();
  const bin = path.join(HOME, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const srcFile = path.join(HOME, "claude-shim.cs");
  fs.writeFileSync(srcFile, SHIM_SRC.replace("NODE_PATH_LITERAL", JSON.stringify(process.execPath))); // a JSON string is a valid C# literal
  const tmp = path.join(bin, `claude-new-${process.pid}.exe`);
  const ps = "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CPOOL_SRC)) -OutputAssembly $env:CPOOL_EXE -OutputType ConsoleApplication";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    env: { ...process.env, CPOOL_SRC: srcFile, CPOOL_EXE: tmp },
    encoding: "utf8",
    windowsHide: true,
  });
  if (!fs.existsSync(tmp)) throw new Error(`could not build the claude shim: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  const dest = path.join(bin, "claude.exe");
  try {
    fs.renameSync(tmp, dest);
  } catch {
    try {
      fs.renameSync(dest, `${dest}.old-${Date.now()}`); // a running claude.exe can be renamed, not overwritten
    } catch {}
    fs.renameSync(tmp, dest);
  }
  for (const f of fs.readdirSync(bin)) if (/^claude\.exe\.old-\d+$/.test(f)) takeFlag(path.join(bin, f));
  return dest;
}
// first claude a NEW terminal finds: machine PATH, then user PATH (from the registry, not this process's PATH)
function claudeForNewTerminals() {
  const q = spawnSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true });
  const m = (q.stdout || "").match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
  const dirs = [...(m ? m[1].trim().split(";") : []), ...(readUserPath() || [])].filter(Boolean).map((d) => d.replace(/%([^%]+)%/g, (x, v) => process.env[v] || x));
  for (const d of dirs) for (const ext of [".exe", ".cmd", ".bat"]) if (fs.existsSync(path.join(d, "claude" + ext))) return path.join(d, "claude" + ext);
  return null;
}
function cmdShim(sub) {
  if (!IS_WIN) return err("[pool] the claude shim is Windows-only; on macOS / Linux add  alias claude=cpool  to your shell rc"), 2;
  const bin = path.join(HOME, "bin");
  const shim = path.join(bin, "claude.exe");
  if (sub === "on") {
    const script = path.join(HOME, "claude-pool.js"); // where the shim looks for it
    if (path.resolve(__filename).toLowerCase() !== script.toLowerCase()) fs.copyFileSync(__filename, script);
    try {
      buildShim();
    } catch (e) {
      return err(`[pool] ${e.message}`), 1;
    }
    if (NO_SYSTEM) out("[pool] (CLAUDE_POOL_NO_SYSTEM) skipped the PATH change");
    else {
      const cur = readUserPath();
      if (cur === null || !writeUserPath([bin, ...cur.filter((p) => !samePath(p, bin))])) return err("[pool] could not read or update the user PATH - nothing changed"), 1;
    }
    out("[pool] claude now starts through the pool in NEW terminals: sessions switch accounts when one hits its limit.");
    out(`[pool] claude update / mcp / -p / --bg / --version ... go straight to the real claude (${resolveClaude()}). The VS Code panel is not affected.`);
    out("[pool] undo: cpool shim off");
    log("shim on");
    return 0;
  }
  if (sub === "off") {
    if (!takeFlag(shim)) {
      try {
        fs.renameSync(shim, `${shim}.old-${Date.now()}`);
      } catch {}
    }
    out("[pool] claude is the real claude again in new terminals (cpool still works). Already open terminals keep what they had.");
    log("shim off");
    return 0;
  }
  const found = claudeForNewTerminals();
  out(`shim      ${fs.existsSync(shim) ? "on" : "off"} (${shim})`);
  out(`claude    new terminals run: ${found || "not found"}${found && samePath(path.dirname(found), bin) ? " -> pool session" : ""}`);
  out(`real      ${resolveClaude()}`);
  return 0;
}

// ---------------------------------------------------------------- background (Windows): daemon + desktop widget
// Image name of a live pid ("node.exe"), "" when gone. Guards every kill against pid reuse.
function imageName(pid) {
  if (!pid || !pidAlive(pid)) return "";
  if (!IS_WIN) return "?";
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  const m = (r.stdout || "").match(/^"([^"]+)","(\d+)"/m);
  return m && Number(m[2]) === pid ? m[1].toLowerCase() : "";
}
// Only our widget counts: a pid file left over from before a reboot is ignored, and the process must really be
// powershell running our widget.ps1 - a reused pid (the user's own PowerShell window) is never stopped or trusted.
function widgetPid() {
  let pid = 0;
  try {
    if (fs.statSync(WIDGET_PID).mtimeMs < Date.now() - os.uptime() * 1000) return 0; // written before this boot
    pid = Number(fs.readFileSync(WIDGET_PID, "utf8").trim());
  } catch {}
  if (!pid || imageName(pid) !== "powershell.exe") return 0;
  const cmd = processCommandLine(pid);
  return cmd.toLowerCase().includes(WIDGET_PS1.toLowerCase()) ? pid : 0;
}
function processCommandLine(pid) {
  if (!IS_WIN) return "";
  const r = psRun("[string](Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:CPOOL_PID)).CommandLine", { CPOOL_PID: String(pid) });
  return (r.stdout || "").trim();
}
// A .vbs run by wscript starts a console program with a new, hidden console: no window flash, and it does not die
// with the terminal it was launched from. (powershell.exe spawned DETACHED exits without running the script.)
// nodePath: the command line starts with node; if that exact node.exe is gone (a node upgrade moved it), fall back to
// node from PATH instead of failing silently (wscript //B shows no errors).
function writeVbs(file, commandLine, what, nodePath = null) {
  const q = (s) => s.replace(/"/g, '""');
  const lines = [`' claude-pool: ${what}. Written by claude-pool.js.`];
  if (nodePath) {
    lines.push('Set fso = CreateObject("Scripting.FileSystemObject")', `node = "${q(nodePath)}"`, 'If Not fso.FileExists(node) Then node = "node.exe"');
    lines.push(`CreateObject("WScript.Shell").Run """" & node & """ ${q(commandLine)}", 0, False`);
  } else lines.push(`CreateObject("WScript.Shell").Run "${q(commandLine)}", 0, False`);
  const vbs = [...lines, ""].join("\r\n");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, "utf16le")])); // UTF-16 BOM: any user-folder name
}
const runVbs = (file) => spawn("wscript.exe", ["//B", "//Nologo", file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
// The widget script is embedded below and rewritten on every start, so updating claude-pool.js updates the widget.
function startWidget() {
  if (!IS_WIN) return false;
  ensureHome();
  fs.writeFileSync(WIDGET_PS1, "\ufeff" + WIDGET_SCRIPT.replace(/\r?\n/g, "\r\n")); // BOM: PowerShell 5.1 reads BOM-less files as ANSI
  const vbs = path.join(HOME, "widget.vbs");
  writeVbs(vbs, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "${WIDGET_PS1}" -StateDir "${HOME}"`, "desktop widget, no window");
  if (NO_SYSTEM) return false;
  runVbs(vbs);
  log("widget start");
  return true;
}
function stopWidget() {
  const pid = widgetPid();
  if (pid) spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
  takeFlag(WIDGET_PID);
  return pid;
}
async function stopDaemon() {
  const pid = runningDaemonPid();
  if (!pid) return 0;
  fs.writeFileSync(STOP_FLAG, "");
  for (let i = 0; i < 80 && pidAlive(pid); i++) await sleep(100); // it checks the flag every second
  if (pidAlive(pid) && imageName(pid) === path.basename(process.execPath).toLowerCase()) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); // with its login helper
  }
  takeFlag(STOP_FLAG);
  return pid;
}
// PowerShell with the script base64-encoded: no quoting trouble on the command line
function psRun(script, env = {}) {
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
}
// A Task Scheduler "at log on" task starts within seconds of sign-in. HKCU\Run entries wait their turn behind every
// other startup app, one at a time with ~30 s waits (minutes on a busy PC). Both stay registered: whichever starts
// first runs the daemon, the second sees it running and exits.
const TASK_NAME = "claude-pool";
function registerLogonTask() {
  const r = psRun(
    [
      "$ErrorActionPreference = 'Stop'",
      "$me = $env:USERDOMAIN + '\\' + $env:USERNAME",
      "$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo \"' + $env:CPOOL_VBS + '\"')",
      "$t = New-ScheduledTaskTrigger -AtLogOn -User $me",
      // watchdog: every 10 minutes; a running daemon makes the extra start exit at once, a crashed one comes back
      "$w = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Minutes 10)",
      "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable",
      "$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited",
      "Register-ScheduledTask -TaskName $env:CPOOL_TASK -Action $a -Trigger @($t, $w) -Settings $s -Principal $p -Description 'claude-pool daemon + desktop widget (cpool background on); repeats every 10 min as a watchdog' -Force | Out-Null",
    ].join("\n"),
    { CPOOL_VBS: BG_VBS, CPOOL_TASK: TASK_NAME }
  );
  return r.status === 0 ? null : (r.stderr || r.stdout || "failed").trim().split(/\r?\n/)[0].slice(0, 160);
}
const unregisterLogonTask = () => psRun("Unregister-ScheduledTask -TaskName $env:CPOOL_TASK -Confirm:$false -ErrorAction SilentlyContinue", { CPOOL_TASK: TASK_NAME });
const logonTaskExists = () => /yes/.test(psRun("if (Get-ScheduledTask -TaskName $env:CPOOL_TASK -ErrorAction SilentlyContinue) { 'yes' }", { CPOOL_TASK: TASK_NAME }).stdout || "");
async function bgOn() {
  ensureHome();
  const script = path.join(HOME, "claude-pool.js");
  if (path.resolve(__filename).toLowerCase() !== script.toLowerCase()) fs.copyFileSync(__filename, script);
  writeVbs(BG_VBS, `"${script}" daemon ${BG_MINUTES} --widget`, "pool daemon + desktop widget, no window (cpool background on)", process.execPath);
  const runCmd = `wscript.exe //B //Nologo "${BG_VBS}"`;
  if (NO_SYSTEM) out("[pool] (CLAUDE_POOL_NO_SYSTEM) skipped the logon entry and launch");
  else {
    const r = spawnSync("reg", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", runCmd, "/f"], { stdio: "ignore", windowsHide: true });
    if (r.status !== 0) return err("[pool] could not write the logon entry (HKCU Run)"), 1;
    const terr = registerLogonTask();
    if (terr) err(`[pool] logon task not created (${terr}) - the startup entry still works, it just starts later after sign-in`);
  }
  // restart both so the running copies are this version
  const old = await stopDaemon();
  stopWidget();
  takeFlag(WIDGET_CLOSED);
  if (NO_SYSTEM) return 0;
  runVbs(BG_VBS);
  let pid = 0;
  for (let i = 0; i < 50 && !(pid = runningDaemonPid()); i++) await sleep(200);
  if (!pid) return err(`[pool] logon entry written, but the daemon did not report in within 10 s - see ${LOG_FILE}`), 1;
  out(`[pool] background on: daemon ${old ? "restarted" : "started"} (pid ${pid}, checks every ${BG_MINUTES} min) + desktop widget. Starts hidden at every logon.`);
  out("[pool] widget: drag to move, right-click for refresh / background / lock / close. `cpool background off` undoes all of it.");
  log(`background on, daemon pid ${pid}`);
  return 0;
}
async function bgOff() {
  if (!NO_SYSTEM) {
    spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { stdio: "ignore", windowsHide: true });
    unregisterLogonTask();
  }
  const d = await stopDaemon();
  const w = stopWidget();
  out(`[pool] background off: logon entry removed${d ? `, daemon (pid ${d}) stopped` : ""}${w ? ", widget closed" : ""}.`);
  out("[pool] CLAUDE_CODE_OAUTH_TOKEN (user env) stays on its last account; `cpool use off` removes it.");
  log("background off");
  return 0;
}
function bgStatus() {
  const onLogon = !NO_SYSTEM && spawnSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], { stdio: "ignore", windowsHide: true }).status === 0;
  const snap = readJson(SNAPSHOT_FILE, () => null);
  const d = runningDaemonPid();
  const w = widgetPid();
  const st = loadState();
  const def = loadAccounts().accounts.find((a) => a.id === st.defaultAccountId);
  const age = snap && snap.generatedAt ? fmtLeft(Date.now() - snap.generatedAt) : "never";
  const task = !NO_SYSTEM && logonTaskExists();
  out(`logon     ${onLogon || task ? `on - ${task ? "logon task (starts at sign-in)" : "no logon task"}${onLogon ? " + startup entry" : ""}` : "off - cpool background on"}`);
  out(`daemon    ${d ? `running, pid ${d}, checks every ${snap.daemon.everyMs / 60000} min` : `not running (last snapshot ${age} ago)`}`);
  out(`widget    ${w ? `running, pid ${w}` : fs.existsSync(WIDGET_CLOSED) ? "closed - cpool widget shows it" : "not running"}`);
  out(`default   ${def ? def.name : "none"} (CLAUDE_CODE_OAUTH_TOKEN for new terminals)`);
  return 0;
}
async function cmdBackground(sub) {
  if (!IS_WIN) return err("[pool] background mode is Windows-only; elsewhere run `cpool daemon` from your login items / init system"), 2;
  if (sub === "on" || sub === "start") return bgOn();
  if (sub === "off" || sub === "stop") return bgOff();
  return bgStatus();
}
function cmdWidget(sub) {
  if (!IS_WIN) return err("[pool] the desktop widget is Windows-only"), 2;
  if (sub === "stop" || sub === "off" || sub === "close") {
    const pid = stopWidget();
    fs.writeFileSync(WIDGET_CLOSED, ""); // the daemon will not bring it back
    return out(pid ? "[pool] widget closed" : "[pool] widget was not running"), 0;
  }
  takeFlag(WIDGET_CLOSED);
  if (widgetPid()) return out("[pool] widget already running"), 0;
  startWidget();
  out("[pool] widget started - drag to move, right-click for refresh / background / lock / close");
  if (!runningDaemonPid()) out("[pool] the daemon is not running, so the widget has no live data: cpool background on");
  return 0;
}

// Desktop widget (Windows PowerShell 5.1 + WPF, no installs). It only draws snapshot.json - never probes, never sees
// a token. Transparent, behind normal windows (owned by the desktop window), not in taskbar / Alt+Tab.
// Kept free of backticks and dollar-brace so it can live in this template literal.
const WIDGET_SCRIPT = String.raw`# claude-pool desktop widget - rewritten by claude-pool.js on every start; edit claude-pool.js, not this copy.
param([string]$StateDir = (Join-Path $env:USERPROFILE '.claude-pool'), [switch]$SelfTest, [string]$Png = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$SnapFile = Join-Path $StateDir 'snapshot.json'
$PrefsFile = Join-Path $StateDir 'widget-prefs.json'
$PidFile = Join-Path $StateDir 'widget.pid'
$ClosedFlag = Join-Path $StateDir 'widget.closed'
$RefreshFlag = Join-Path $StateDir 'refresh.flag'
$LoginQueue = Join-Path $StateDir 'login.queue'
$LoginCancel = Join-Path $StateDir 'login.cancel'
$LogFile = Join-Path $StateDir 'widget.log'
# widget.log: rotated at 1 MB; the same message at most once a minute (Tick runs every 2 s)
try { if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile ($LogFile + '.1') -Force } } catch {}
$script:LastLogMsg = ''; $script:LastLogAt = [datetime]::MinValue
function Write-Log([string]$m) {
  if ($m -eq $script:LastLogMsg -and ((Get-Date) - $script:LastLogAt).TotalSeconds -lt 60) { return }
  $script:LastLogMsg = $m; $script:LastLogAt = Get-Date
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format s) + ' ' + $m) -Encoding UTF8 } catch {}
}

# one widget per pool folder
$created = $false
$mutex = New-Object System.Threading.Mutex($true, ('Local\ClaudePoolWidget_' + ($StateDir.ToLowerInvariant() -replace '[^a-z0-9]', '_')), [ref]$created)
if (-not $created) { exit 0 }
Set-Content -Path $PidFile -Value $PID -Encoding ASCII

Add-Type -Namespace ClaudePool -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
[DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
'@

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="claude-pool" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ShowActivated="False" Topmost="False" ResizeMode="NoResize"
        SizeToContent="WidthAndHeight" WindowStartupLocation="Manual" Left="-32000" Top="-32000"
        UseLayoutRounding="True" FontFamily="Cascadia Mono, Consolas" FontSize="12">
  <Window.Resources>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Foreground" Value="#FFF0A588"/>
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Focusable" Value="False"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="#26E38D6D" BorderBrush="#80E38D6D" BorderThickness="1" CornerRadius="4" Padding="7,0,7,1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#4DE38D6D"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Background" Value="#80E38D6D"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="QuietBtn" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Foreground" Value="#B3C3CBD5"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="#14FFFFFF" BorderBrush="#40FFFFFF" BorderThickness="1" CornerRadius="4" Padding="7,0,7,1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#2EFFFFFF"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="Background" Value="#4DFFFFFF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Card" CornerRadius="10" BorderThickness="1" Padding="14,10,14,10">
    <StackPanel x:Name="Body">
      <StackPanel.Effect><DropShadowEffect ShadowDepth="0" BlurRadius="4" Opacity="0.6" Color="Black"/></StackPanel.Effect>
      <Grid x:Name="Table"/>
      <Grid x:Name="Summary" Margin="0,8,0,0"/>
      <StackPanel x:Name="Actions" Orientation="Horizontal" Margin="0,9,0,0" Visibility="Collapsed"/>
      <TextBlock x:Name="Foot" Margin="0,6,0,0" FontSize="11" Visibility="Collapsed" TextWrapping="Wrap" MaxWidth="560" HorizontalAlignment="Left"/>
    </StackPanel>
  </Border>
</Window>
'@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$Card = $win.FindName('Card'); $Body = $win.FindName('Body'); $Table = $win.FindName('Table')
$Summary = $win.FindName('Summary'); $Foot = $win.FindName('Foot'); $Actions = $win.FindName('Actions')

$conv = New-Object Windows.Media.BrushConverter
function New-Brush([string]$hex) { $b = $conv.ConvertFromString($hex); $b.Freeze(); return $b }
$Fg = New-Brush '#EDEEF1F5'; $Muted = New-Brush '#9EC3CBD5'; $RailBrush = New-Brush '#38C3CBD5'
$Accent = New-Brush '#FFE38D6D'; $Low = New-Brush '#FFEC9A8A'; $Mid = New-Brush '#FFE4C88C'
$Backgrounds = @('#01101318', '#8C101318', '#E6101318')   # clear stays hit-testable (alpha 1) so it can be dragged
$Borders = @('#00FFFFFF', '#22FFFFFF', '#2EFFFFFF')
$BgNames = @('clear', 'glass', 'solid')
$Arrow = [string][char]0x203A
$BarWidth = 116   # about 16 characters
$Win32Flags = 0x13   # SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE

$Prefs = @{ top = $null; left = 0.0; right = 0.0; anchorRight = $true; locked = $false; bg = 1 }
if (Test-Path $PrefsFile) {
  try {
    $p = Get-Content -Raw -Path $PrefsFile | ConvertFrom-Json
    foreach ($k in @('top', 'left', 'right', 'anchorRight', 'locked', 'bg')) { if ($null -ne $p.$k) { $Prefs[$k] = $p.$k } }
  } catch {}
}
function Save-Prefs { try { ($Prefs | ConvertTo-Json -Compress) | Set-Content -Path $PrefsFile -Encoding UTF8 } catch {} }

foreach ($i in 1..7) { $c = New-Object Windows.Controls.ColumnDefinition; $c.Width = [Windows.GridLength]::Auto; [void]$Table.ColumnDefinitions.Add($c) }
foreach ($i in 1..2) { $c = New-Object Windows.Controls.ColumnDefinition; $c.Width = [Windows.GridLength]::Auto; [void]$Summary.ColumnDefinitions.Add($c) }

function Reset-Rows($grid, [int]$n) {
  $grid.Children.Clear(); $grid.RowDefinitions.Clear()
  for ($i = 0; $i -lt $n; $i++) { $r = New-Object Windows.Controls.RowDefinition; $r.Height = [Windows.GridLength]::Auto; [void]$grid.RowDefinitions.Add($r) }
}
function Place-Cell($grid, $el, [int]$row, [int]$col, [int]$span) {
  [Windows.Controls.Grid]::SetRow($el, $row); [Windows.Controls.Grid]::SetColumn($el, $col)
  if ($span -gt 1) { [Windows.Controls.Grid]::SetColumnSpan($el, $span) }
  [void]$grid.Children.Add($el)
}
function Add-Text($grid, [int]$row, [int]$col, [string]$text, $brush, [double]$gap = 0, [string]$align = 'Left', [int]$span = 1) {
  $t = New-Object Windows.Controls.TextBlock
  $t.Text = $text; $t.Foreground = $brush; $t.HorizontalAlignment = $align
  $t.Margin = New-Object Windows.Thickness -ArgumentList $gap, 0, 0, 2
  Place-Cell $grid $t $row $col $span
}
function Pct-Brush($left, [bool]$dim) {
  if ($dim -or $null -eq $left) { return $Muted }
  if ($left -le 10) { return $Low }
  if ($left -le 30) { return $Mid }
  return $Fg
}
function Add-Window([int]$row, [int]$col, $w, [bool]$dim, [string]$temp = '') {
  # $temp: placeholder reset text for accounts that are not logged in yet (keeps the columns readable)
  $txt = if ($null -ne $w.left) { [string]$w.left + '%' } elseif ($temp) { '--%' } else { '-' }
  $reset = if ($null -eq $w.left -and $temp) { $temp } else { [string]$w.reset }
  Add-Text $Table $row $col $txt (Pct-Brush $w.left $dim) 14 'Right'
  Add-Text $Table $row ($col + 1) $reset $(if ($temp -and $null -eq $w.left) { $RailBrush } else { $Muted }) 6
}
function Format-Age([double]$ms) {
  $m = [math]::Floor($ms / 60000)
  if ($m -lt 1) { return '<1m' }
  if ($m -lt 60) { return [string]$m + 'm' }
  if ($m -lt 1440) { return [string][math]::Floor($m / 60) + 'h' + ([string]($m % 60)).PadLeft(2, '0') }
  return [string][math]::Floor($m / 1440) + 'd'
}

function New-Button([string]$text, [string]$style, $tag, [scriptblock]$onClick, [double]$gap = 8) {
  $b = New-Object Windows.Controls.Button
  $b.Content = $text; $b.Tag = $tag; $b.Style = $win.FindResource($style)
  $b.Margin = New-Object Windows.Thickness -ArgumentList $gap, 0, 0, 0
  $b.VerticalAlignment = 'Center'
  $b.Add_Click($onClick)
  return $b
}
# the daemon picks the queue up within a second and runs the logins one after another
function Request-Login([string[]]$names, [string]$email = '') {
  try {
    [void][ClaudePool.Native]::AllowSetForegroundWindow(-1)   # let the sign-in window come to the front
    $lines = ($names | Where-Object { $_ } | ForEach-Object { $_ + [char]9 + $email + [Environment]::NewLine }) -join ''
    [IO.File]::AppendAllText($LoginQueue, $lines)
  } catch { Write-Log ('login request: ' + $_.Exception.Message) }
}
function Add-Account {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $name = [Microsoft.VisualBasic.Interaction]::InputBox('Name for the new account (for example work2):', 'claude-pool - add account', '')
  $name = ($name -replace '[^A-Za-z0-9._@-]', '').Trim()
  if (-not $name) { return }
  $email = [Microsoft.VisualBasic.Interaction]::InputBox('Its email (optional - pre-fills the sign-in page):', 'claude-pool - add account', '')
  Request-Login @($name) ($email.Trim())
}
function Add-Status([int]$row, $r) {
  $panel = New-Object Windows.Controls.StackPanel
  $panel.Orientation = 'Horizontal'
  $panel.Margin = New-Object Windows.Thickness -ArgumentList 14, 0, 0, 2
  $t = New-Object Windows.Controls.TextBlock
  $t.Text = $r.status; $t.VerticalAlignment = 'Center'
  $t.Foreground = switch ($r.kind) { 'active' { $Accent } 'signing' { $Accent } 'dead' { $Low } 'login' { $Mid } default { $Muted } }
  [void]$panel.Children.Add($t)
  if ($r.kind -eq 'login' -or $r.kind -eq 'dead') {
    [void]$panel.Children.Add((New-Button 'Log in' 'Btn' ([string]$r.name) { param($s, $e) Request-Login @([string]$s.Tag) }))
  } elseif ($r.kind -eq 'signing') {
    [void]$panel.Children.Add((New-Button 'cancel' 'QuietBtn' $null { param($s, $e) try { Set-Content -Path $LoginCancel -Value '' } catch {} }))
  }
  Place-Cell $Table $panel $row 6 1
}

function Render {
  $snap = $script:Snap
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $note = ''
  $noteBrush = $Muted
  if ($null -eq $snap) { $note = 'waiting for the pool daemon - cpool background on' }
  elseif ($snap.daemon -and $snap.daemon.stopped) { $note = 'pool daemon stopped - cpool background on' }
  elseif ($null -eq $snap.daemon -or ($nowMs - [double]$snap.generatedAt) -gt 60000) {
    $note = 'pool daemon not running - data ' + (Format-Age ($nowMs - [double]$snap.generatedAt)) + ' old'
  }
  $Body.Opacity = if ($note) { 0.6 } else { 1.0 }

  if ($null -eq $snap -or $snap.empty) {
    Reset-Rows $Table 1
    Add-Text $Table 0 0 $(if ($null -eq $snap) { 'no data yet' } else { 'no accounts yet' }) $Muted 0 'Left' 7
    $Summary.Visibility = 'Collapsed'
    if (-not $note -and $snap) { $note = 'add your Claude accounts with + Add account' }
  } else {
    $rows = @($snap.rows | Where-Object { $_ })
    Reset-Rows $Table ($rows.Count + 1)
    Add-Text $Table 0 1 'Account' $Muted 6
    Add-Text $Table 0 2 '5h left' $Muted 14 'Left' 2
    Add-Text $Table 0 4 '7d left' $Muted 14 'Left' 2
    Add-Text $Table 0 6 'Status' $Muted 14
    $i = 1
    foreach ($r in $rows) {
      $dim = @('paused', 'off', 'dead', 'login', 'signing', 'queued') -contains $r.kind
      Add-Text $Table $i 0 $(if ($r.active) { $Arrow } else { ' ' }) $Accent
      Add-Text $Table $i 1 $r.name $(if ($r.active) { $Accent } elseif ($dim) { $Muted } else { $Fg }) 6
      $waitingRow = @('login', 'signing', 'queued') -contains $r.kind
      Add-Window $i 2 $r.h5 $dim $(if ($waitingRow) { '-h--' } else { '' })
      Add-Window $i 4 $r.d7 $dim $(if ($waitingRow) { '-d--' } else { '' })
      Add-Status $i $r
      $i++
    }
    $Summary.Visibility = 'Visible'
    Reset-Rows $Summary 5
    Add-Text $Summary 0 0 'Usable' $Muted
    Add-Text $Summary 1 0 '5h resets' $Muted
    Add-Text $Summary 2 0 '7d resets' $Muted
    Add-Text $Summary 3 0 'Auto hi' $Muted
    $hiText = if ($snap.autoHi) { [string]$snap.autoHi.text } else { '-' }
    Add-Text $Summary 3 1 $hiText $(if ($snap.autoHi -and $snap.autoHi.on) { $Fg } else { $Muted }) 12
    Add-Text $Summary 4 0 'Logins' $Muted
    Add-Text $Summary 4 1 $(if ($snap.logins) { [string]$snap.logins.text } else { '-' }) $Fg 12
    $u = $snap.usable
    $bar = New-Object Windows.Controls.StackPanel
    $bar.Orientation = 'Horizontal'
    $bar.Margin = New-Object Windows.Thickness -ArgumentList 12, 0, 0, 2
    $rail = New-Object Windows.Controls.Border
    $rail.Width = $BarWidth; $rail.Height = 6; $rail.VerticalAlignment = 'Center'
    $rail.CornerRadius = New-Object Windows.CornerRadius 3; $rail.Background = $RailBrush
    $level = New-Object Windows.Controls.Border
    $level.HorizontalAlignment = 'Left'; $level.CornerRadius = New-Object Windows.CornerRadius 3
    $level.Width = [math]::Max(0, [math]::Min($BarWidth, $BarWidth * [double]$u.pct / 100))
    $level.Background = $(if ([double]$u.pct -le 10) { $Low } else { $Accent })
    $rail.Child = $level
    [void]$bar.Children.Add($rail)
    $label = New-Object Windows.Controls.TextBlock
    $label.Text = '  ' + $u.text; $label.Foreground = $Fg
    [void]$bar.Children.Add($label)
    Place-Cell $Summary $bar 0 1 1
    Add-Text $Summary 1 1 ([string]$snap.resets.h5) $Fg 12
    Add-Text $Summary 2 1 ([string]$snap.resets.d7) $Fg 12
  }

  # buttons only while something needs doing; Add account stays in the right-click menu otherwise
  $Actions.Children.Clear()
  $need = if ($snap) { [int]$snap.needLogin } else { 0 }
  if ($snap -and ($snap.empty -or $need -gt 0)) {
    if ($need -gt 1) {
      $todo = @($snap.rows | Where-Object { $_.kind -eq 'login' -or $_.kind -eq 'dead' } | ForEach-Object { [string]$_.name })
      [void]$Actions.Children.Add((New-Button ('Log in all (' + $need + ')') 'Btn' $todo { param($s, $e) Request-Login ([string[]]$s.Tag) } 0))
    }
    [void]$Actions.Children.Add((New-Button '+ Add account' 'QuietBtn' $null { param($s, $e) Add-Account } $(if ($need -gt 1) { 8 } else { 0 })))
    $Actions.Visibility = 'Visible'
  } else { $Actions.Visibility = 'Collapsed' }

  # last login result (errors stay 5 minutes, success 2)
  if (-not $note -and $snap -and $snap.login) {
    $age = $nowMs - [double]$snap.login.at
    $msg = [string]$snap.login.message
    if (@('error', 'cancelled') -contains $snap.login.state -and $age -lt 300000) { $note = $snap.login.name + ': ' + $msg; $noteBrush = $Low }
    elseif ($snap.login.state -eq 'done' -and $age -lt 120000) { $note = $snap.login.name + ' logged in' + $(if ($msg) { ' - ' + $msg } else { '' }); $noteBrush = $Accent }
    elseif ($snap.login.state -eq 'browser') { $note = 'sign in as ' + $snap.login.name + ' in the browser window, then click Authorize'; $noteBrush = $Muted }
  }
  $Foot.Text = $note
  $Foot.Foreground = $noteBrush
  $Foot.Visibility = if ($note) { 'Visible' } else { 'Collapsed' }
}

$script:Snap = $null
$script:SnapTime = [datetime]::MinValue
$script:TickN = 0
function Tick {
  try {
    $changed = $false
    if ([IO.File]::Exists($SnapFile)) {
      $t = [IO.File]::GetLastWriteTimeUtc($SnapFile)
      if ($t -ne $script:SnapTime) {
        $script:Snap = [IO.File]::ReadAllText($SnapFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $script:SnapTime = $t
        $changed = $true
      }
    }
    if ($changed -or ($script:TickN % 15) -eq 0) { Render }
    $script:TickN++
  } catch { Write-Log ('tick: ' + $_.Exception.Message + ' (line ' + $_.InvocationInfo.ScriptLineNumber + ')') }
}

$script:Hwnd = [IntPtr]::Zero
function Send-ToBack { if ($script:Hwnd -ne [IntPtr]::Zero) { [void][ClaudePool.Native]::SetWindowPos($script:Hwnd, [IntPtr]1, 0, 0, 0, 0, $Win32Flags) } }
function Place {
  $w = $win.ActualWidth
  if ($w -le 0) { return }
  $vl = [Windows.SystemParameters]::VirtualScreenLeft; $vt = [Windows.SystemParameters]::VirtualScreenTop
  $vw = [Windows.SystemParameters]::VirtualScreenWidth; $vh = [Windows.SystemParameters]::VirtualScreenHeight
  $x = if ($Prefs.anchorRight) { [double]$Prefs.right - $w } else { [double]$Prefs.left }
  $ok = $null -ne $Prefs.top -and [double]$Prefs.top -ge $vt -and [double]$Prefs.top -lt ($vt + $vh - 30) -and $x -ge ($vl - $w + 40) -and $x -le ($vl + $vw - 40)
  if (-not $ok) {
    $wa = [Windows.SystemParameters]::WorkArea
    $Prefs.anchorRight = $true; $Prefs.right = $wa.Right - 112; $Prefs.top = $wa.Top + 24   # 112: clear of a right-hand desktop icon column
    $x = $Prefs.right - $w
  }
  $win.Left = $x; $win.Top = [double]$Prefs.top
}
function Apply-Background {
  $i = [int]$Prefs.bg
  if ($i -lt 0 -or $i -gt 2) { $i = 1; $Prefs.bg = 1 }
  $Card.Background = New-Brush $Backgrounds[$i]
  $Card.BorderBrush = New-Brush $Borders[$i]
  if ($script:BgItem) { $script:BgItem.Header = 'Background: ' + $BgNames[$i] }
}

$win.Add_SourceInitialized({
  $script:Hwnd = (New-Object Windows.Interop.WindowInteropHelper $win).Handle
  $ex = [ClaudePool.Native]::GetWindowLongPtr($script:Hwnd, -20).ToInt64()
  [void][ClaudePool.Native]::SetWindowLongPtr($script:Hwnd, -20, [IntPtr]($ex -bor 0x08000080))   # NOACTIVATE | TOOLWINDOW
  $desk = [ClaudePool.Native]::FindWindow('Progman', [NullString]::Value)
  if ($desk -ne [IntPtr]::Zero) { [void][ClaudePool.Native]::SetWindowLongPtr($script:Hwnd, -8, $desk) }   # owned by the desktop
  Send-ToBack
})
$win.Add_SizeChanged({ Place })
$win.Add_MouseLeftButtonDown({
  if ($Prefs.locked) { return }
  try { $win.DragMove() } catch {}
  $vl = [Windows.SystemParameters]::VirtualScreenLeft; $vw = [Windows.SystemParameters]::VirtualScreenWidth
  $Prefs.anchorRight = ($win.Left + $win.ActualWidth / 2) -gt ($vl + $vw / 2)   # right half: grow leftwards
  $Prefs.left = $win.Left; $Prefs.right = $win.Left + $win.ActualWidth; $Prefs.top = $win.Top
  Save-Prefs
  Send-ToBack
})

$menu = New-Object Windows.Controls.ContextMenu
function Add-MenuItem([string]$header, [scriptblock]$onClick) {
  $mi = New-Object Windows.Controls.MenuItem
  $mi.Header = $header
  $mi.Add_Click($onClick)
  [void]$menu.Items.Add($mi)
  return $mi
}
[void](Add-MenuItem 'Refresh now' { try { Set-Content -Path $RefreshFlag -Value '' } catch {} })
[void](Add-MenuItem 'Add account...' { Add-Account })
# Re-login: replace any account's login (wrong account signed in, token revoked, ...) - same flow as Log in
$script:ReloginItem = Add-MenuItem 'Re-login account' {}
function Fill-ReloginMenu {
  $script:ReloginItem.Items.Clear()
  $names = @($script:Snap.rows | Where-Object { $_ } | ForEach-Object { [string]$_.name })
  foreach ($n in $names) {
    $mi = New-Object Windows.Controls.MenuItem
    $mi.Header = $n.Replace('_', '__'); $mi.Tag = $n   # double _ : no access-key underline
    $mi.Add_Click({ param($s, $e) Request-Login @([string]$s.Tag) })
    [void]$script:ReloginItem.Items.Add($mi)
  }
  $script:ReloginItem.IsEnabled = $names.Count -gt 0
}
$AutoHiOff = Join-Path $StateDir 'autohi.off'
$script:HiItem = Add-MenuItem 'Auto hi at every 5h reset' {
  try { if (Test-Path $AutoHiOff) { Remove-Item $AutoHiOff } else { Set-Content -Path $AutoHiOff -Value '' } } catch {}
}
$menu.Add_Opened({ $script:HiItem.IsChecked = -not (Test-Path $AutoHiOff); Fill-ReloginMenu })
$script:BgItem = Add-MenuItem 'Background' { $Prefs.bg = ([int]$Prefs.bg + 1) % 3; Apply-Background; Save-Prefs }
$script:LockItem = Add-MenuItem 'Lock position' { $Prefs.locked = -not $Prefs.locked; $script:LockItem.IsChecked = [bool]$Prefs.locked; Save-Prefs }
$script:LockItem.IsChecked = [bool]$Prefs.locked
[void]$menu.Items.Add((New-Object Windows.Controls.Separator))
[void](Add-MenuItem 'Close widget' { try { Set-Content -Path $ClosedFlag -Value '' } catch {}; $win.Close() })
$Card.ContextMenu = $menu

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Tick })
$win.Add_Closed({ $timer.Stop(); $win.Dispatcher.InvokeShutdown() })   # also fires if Explorer restarts; the daemon relaunches us

Apply-Background
if ($SelfTest) {   # render snapshot.json once without showing a window; print the drawn text (used by the tests)
  try {
    if ([IO.File]::Exists($SnapFile)) { $script:Snap = [IO.File]::ReadAllText($SnapFile, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    Render
    function Get-Drawn($el) {
      if ($el -is [Windows.Controls.TextBlock]) { return $el.Text }
      if ($el -is [Windows.Controls.Button]) { return '[' + $el.Content + ']' }
      if ($el -is [Windows.Controls.Panel]) { foreach ($c in $el.Children) { Get-Drawn $c } }
    }
    $drawn = foreach ($el in @($Table.Children) + @($Summary.Children) + @($Actions.Children)) { Get-Drawn $el }
    'DRAWN=' + ($drawn -join '|')
    'FOOT=' + $Foot.Text
    Fill-ReloginMenu
    'RELOGIN=' + ((@($script:ReloginItem.Items) | ForEach-Object { [string]$_.Tag }) -join '|') + ' enabled=' + $script:ReloginItem.IsEnabled
    if ($Png) {   # docs image: the card alone on a neutral backdrop (no desktop behind it), 2x scale
      $win.Content = $null
      $wrap = New-Object Windows.Controls.Grid
      $wrap.Background = New-Object Windows.Media.LinearGradientBrush -ArgumentList ([Windows.Media.ColorConverter]::ConvertFromString('#FF2B2F3A')), ([Windows.Media.ColorConverter]::ConvertFromString('#FF4A3A44')), 35
      $Card.Margin = New-Object Windows.Thickness 28
      [Windows.Documents.TextElement]::SetFontFamily($wrap, $win.FontFamily)   # the window's font, now that the card left it
      [Windows.Documents.TextElement]::SetFontSize($wrap, $win.FontSize)
      [void]$wrap.Children.Add($Card)
      $wrap.Measure((New-Object Windows.Size ([double]::PositiveInfinity), ([double]::PositiveInfinity)))
      $wrap.Arrange((New-Object Windows.Rect 0, 0, $wrap.DesiredSize.Width, $wrap.DesiredSize.Height))
      $wrap.UpdateLayout()
      $bmp = New-Object Windows.Media.Imaging.RenderTargetBitmap -ArgumentList ([int]($wrap.ActualWidth * 2)), ([int]($wrap.ActualHeight * 2)), 192, 192, ([Windows.Media.PixelFormats]::Pbgra32)
      $bmp.Render($wrap)
      $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
      $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
      $fs = [IO.File]::Create($Png); $enc.Save($fs); $fs.Close()
      'PNG=' + $Png
    }
    exit 0
  } catch { 'ERROR ' + $_.Exception.Message + ' (line ' + $_.InvocationInfo.ScriptLineNumber + ')'; exit 1 }
}
Tick
$timer.Start()
$win.Show()
[Windows.Threading.Dispatcher]::Run()
Remove-Item -Path $PidFile -ErrorAction SilentlyContinue
$mutex.ReleaseMutex()
`;

// ---------------------------------------------------------------- help / main
function help() {
  const src = fs.readFileSync(__filename, "utf8");
  const m = src.match(/\/\*([\s\S]*?)\*\//);
  out((m ? m[1] : "see the header comment").trim());
  return 0;
}
const COMMANDS = {
  run: (a) => cmdRun(a),
  limits: () => cmdLimits(),
  limit: () => cmdLimits(),
  status: () => cmdLimits(),
  list: () => cmdList(),
  ls: () => cmdList(),
  add: (a) => cmdAdd(a),
  login: (a) => cmdLogin(a),
  remove: (a) => cmdRemove(a[0]),
  rm: (a) => cmdRemove(a[0]),
  rename: (a) => cmdRename(a[0], a[1]),
  on: (a) => cmdOn(a[0]),
  off: (a) => cmdOff(a[0]),
  first: (a) => cmdFirst(a[0]),
  reorder: (a) => cmdReorder(a[0], a[1]),
  reset: (a) => cmdReset(a[0]),
  use: (a) => cmdUse(a[0]),
  env: (a) => cmdUse(a[0]),
  daemon: (a) => cmdDaemon(a),
  watch: (a) => cmdDaemon(a),
  background: (a) => cmdBackground(a[0]),
  bg: (a) => cmdBackground(a[0]),
  widget: (a) => cmdWidget(a[0]),
  autohi: (a) => cmdAutoHi(a[0]),
  shim: (a) => cmdShim(a[0]),
  "shim-run": (a) => cmdShimRun(a),
  install: () => cmdInstall(),
  help: () => help(),
  "--help": () => help(),
  "-h": () => help(),
  version: () => (out(`claude-pool ${VERSION}`), 0),
  "--version": () => (out(`claude-pool ${VERSION}`), 0),
};
async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd.startsWith("-")) return await cmdRun(argv);
    if (COMMANDS[cmd]) return await COMMANDS[cmd](rest);
    return await cmdRun(argv); // anything else is a claude argument (e.g. a prompt)
  } catch (e) {
    err(`[pool] error: ${(e && e.message) || e}`);
    log(`error: ${(e && e.stack) || e}`);
    return 1;
  }
}

module.exports = {
  withLock, loadAccounts, loadState, probeToken, getUsage, pickBest, judge, headroom, parseLimitWaitMs, parseRunArgs, buildArgs, redact, HOME,
  fmtShort, buildSnapshot, summaryLines, keepDefault, startWidget, WIDGET_SCRIPT, SNAPSHOT_FILE, SWITCH_MARGIN,
  tokenFromScreen, ensureHelper, readLoginQueue, dueHis, matchCliAccount, fetchCliUsage, passThrough, chooseClaude, buildShim,
  childSession, transcriptExists, claudeSubcommands, findLatestSession, pauseUntilFor, findAccount, acquireLock,
  shiftLoginQueue, claudeCommand, widgetPid, daemonCycle, LOGIN_QUEUE, WIDGET_PID, ACCOUNTS_FILE, STATE_FILE,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  });
}
