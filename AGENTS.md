# Notes for coding agents

- **One file.** Everything is in `claude-pool.js` (Node 18+, standard library only). Do not add npm dependencies.
- **Embedded scripts.** The desktop widget (`WIDGET_SCRIPT`, Windows PowerShell 5.1 + WPF) and the login helper
  (`HELPER_SRC`, C# compiled with `Add-Type`) live in `String.raw` template literals. Do not use backticks or `${`
  inside them. PowerShell variable names are case-insensitive: a local `$foot` silently replaces a script-level
  `$Foot`, so pick distinct names.
- **Never print a token.** Route all output through `out` / `err` / `log`, which redact `sk-ant-...`. The widget
  data (`snapshot.json`, built by the pure `buildSnapshot`) must stay token-free; a test checks this.
- **Tests:** `npm test` (= `node --test test/widget.test.js`). They use `CLAUDE_POOL_HOME` temp folders,
  `CLAUDE_POOL_NO_SYSTEM=1` (no registry / PATH / process launches), a mock API (`CLAUDE_POOL_PROBE_URL`) and a fake
  `claude` (`CLAUDE_POOL_CLAUDE_BIN`). Windows-only tests run the widget headless (`widget.ps1 -SelfTest`) and login
  through the real pseudo console.
- **Docs images:** `widget.ps1 -SelfTest -Png docs/widget.png` renders the widget offscreen from a snapshot. Use demo
  account names only.
- Keep `README.md`, the header comment in `claude-pool.js` (printed by `cpool help`) and `llms.txt` in sync when
  commands change.
- **Encoding.** Files are UTF-8 without BOM, LF line endings; `claude-pool.js` must start with its `#!` line (a test
  checks this). Never round-trip a file through Windows PowerShell 5.1 `Get-Content`/`Set-Content`: it reads BOM-less
  UTF-8 as ANSI and rewrites every non-ASCII character (`·` becomes `Â·`) and adds a BOM.
