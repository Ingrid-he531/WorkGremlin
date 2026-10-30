# WorkGremlin

Turn the AI coding agents running on your machine into a **visible office**: who is busy, which session is working, and which floor is active — all at a glance. You can also invite agents from several floors into a **council** to review one proposal through several moderated rounds (a moderator, a main answerer and independent reviewers — no voting).

## Demo

![WorkGremlin demo: the main agent and gremlins in the office → the graphical board of task records](docs/assets/demo.gif)

## Quick start

```bash
# Requirements: Node >= 18 (Vite needs it in dev mode); on Linux also python3 + make + g++ (better-sqlite3 is compiled during npm install).
# server/client run on Electron's bundled Node, so you do not install Node separately.
node -v && npm -v && python3 --version && which make g++

# Install dependencies (postinstall runs electron-rebuild to rebuild better-sqlite3)
npm install

# Start (Electron's Node runs the server + opens the desktop window; after the app exits the server stays resident in the background)
npm run launch:electron

# Dev mode (Vite HMR + Electron window): npm run dev
# Build the renderer then start (prod): npm run build:electron
# Run only the local server, no window: npm run server
# Just check the native module works (create table → write → read back): npm run db:check
```

**Demo mode**: once it is up, click "Demo mode" on the bottom-right action bar (left of "Gather for a meeting") — the current floor gets an isolated virtual **demo session**, the main console follows the server-owned demo phase, and the office shows the demo team (6 experts + 2 temporary members). Task records and the conversation stay on the real project. Click "Exit demo" again to return to the previously selected real session.

### Remote access

The renderer only talks HTTP `/api/v1` + WebSocket `/ws`, so the window can be a thin client and a browser can open the UI directly.

**Server side** (the machine running the agents and the database):

```bash
# Browser mode: also serve the built UI
npm run build
node server/src/cli.js --host 0.0.0.0 --port 21800 --static renderer/dist --tls

# Window-client mode: expose the API + WS only
node server/src/cli.js --host 0.0.0.0 --port 21800 --tls
```

The token is generated on the **first** start and written to `~/.workgremlin/server.json` (mode `0600`, inside a `0700` directory). Later starts reuse it, so a remote client does not lose access every time the server restarts. Read it once on the server machine and give it to the clients:

```bash
node -e "const p=require('path'),os=require('os'),fs=require('fs');console.log(JSON.parse(fs.readFileSync(p.join(process.env.WORKGREMLIN_HOME||p.join(os.homedir(),'.workgremlin'),'server.json'),'utf8')).token)"
```

The same startup settings can live in `~/.workgremlin/config.json`, so the command line can stay short:

```json
{
  "server": { "host": "0.0.0.0", "port": 21800, "tls": true }
}
```

Then `node server/src/cli.js --static renderer/dist` is enough. Command-line flags and environment variables (`WORKGREMLIN_HOST`, `WORKGREMLIN_PORT`, `WORKGREMLIN_TLS`) override the file. The `server` section is read at startup, so a change needs a restart; `dispatch.mode` in the same file is re-read on demand.

**One launch for local and remote**: the same `server` section also drives the Electron launcher. With `host` set to `0.0.0.0`, run:

```bash
npm run build            # only needed when renderer/dist is missing or stale
npm run launch:electron -- --restart
```

That starts the server with the configured host/port/TLS, serves the built UI for browser clients, and opens the local window. The local window and a remote browser can use it at the same time; read the token from `server.json` for the browser URL. With `tls: true`, the local window trusts exactly the server's certificate fingerprint, while the browser shows the usual one-time self-signed warning. If `host` stays `127.0.0.1`, remote browsers cannot connect.

To rotate it, start once with `--rotate-token` (a new random token is generated and persisted; no secret on the command line), then update every client. Deleting `server.json` while the server is stopped has the same effect. `--token <value>` still works but is **not recommended**: the secret then appears in `ps`, shell history and process-manager configuration.

**TLS**: `--tls` makes the server speak HTTPS with a self-signed certificate (generated once into `~/.workgremlin/tls`, reused while valid), so the token and all data stop travelling in clear text. The startup log prints the certificate's SHA-256 fingerprint: the browser will warn once ("not private" → Advanced → Continue), and matching the fingerprint there is what makes that click-through meaningful. A self-signed certificate encrypts but does not *identify* the server —— if you need both, pass a real certificate instead:

```bash
node server/src/cli.js --static renderer/dist --tls-cert /path/server.crt --tls-key /path/server.key
```

In Vite dev mode, set `WORKGREMLIN_TLS=1` on both commands so the proxy targets `https`/`wss`.

**Client side** (no server, no database):

- **Browser — nothing to install**: open `https://<host>:21800/?token=<token from server.json>` with `--tls`, `http://…` without. The token is exchanged for an httpOnly cookie, so a refresh does not need it again. `msedge --app=<url>` / `chrome --app=<url>` gives a window without browser chrome.
- **Client-only window**: `npm run build:client` (Linux unpacked build), then put `client.json` `{ "host": "192.168.1.5", "port": 21800, "token": "<token from server.json>" }` next to the executable or in `~/.workgremlin/client.json`. On a Windows machine the same config produces the exe: `npx electron-builder --config electron-builder.client.yml --win portable`. The client package contains no server and no native module, so it is ~112 MB instead of ~125 MB and needs no SQLite toolchain. The `Client packages (Windows)` GitHub Actions workflow (`.github/workflows/client-windows.yml`) builds the zip + portable exe on `windows-latest` — run it from the Actions tab or push a `v*` tag.
- **Full package**: the same `client.json` turns it into a remote client; with a target configured it never starts or reads a local server.

Without `--tls` everything is plain HTTP/WS: use it only on a trusted network, or put an SSH tunnel or a TLS reverse proxy in front. `--no-token` disables the only gate, so never combine it with `--host 0.0.0.0` on a shared network.

### Remote task dispatch (4F Claude Code / 8F OpenCode)

A client can hand **one prompt** to one floor; the run happens on the server machine. The office and task records are written by the floor itself: the dispatched command is a normal, persistent session in the target directory, so the existing hooks/poller record it exactly like typing the prompt in a terminal. The dispatcher writes no ledger rows.

- **Server policy** (a file on the server, **not** a client setting) — `~/.workgremlin/config.json`:
  ```json
  {
    "server": { "host": "0.0.0.0", "port": 21800, "tls": true },
    "dispatch": { "mode": "off" }
  }
  ```
  - `off` — reject every request (default);
  - `auto` — start on arrival; the floor's selected permission mode is used (`opencode run --auto` / Claude's `--permission-mode`);
  - `confirm` — a dialog appears in the server's window before anything starts. A remote client cannot approve it: the decision endpoint only accepts loopback requests.

  The file is re-read on every policy check, so an edit takes effect without restarting the server; `WORKGREMLIN_DISPATCH_MODE` overrides it (containers/tests). An invalid value falls back to `off`. The client cannot change this policy: there is no HTTP write endpoint for it.
- **Client**: the **Remote tasks** tab (next to Council). Create a session with a floor and a project directory (absolute path **on the server**), then choose the model and permission mode in the composer for **each turn**: every prompt is a turn in the **same** product session (`--session` / `--resume`), so the office/ledger sees one long conversation. Output streams into the transcript while the turn runs; one turn per session at a time, cancellable; a pending turn expires after 5 minutes.
  - **4F Claude Code** offers `Auto`, `Accept edits`, `Bypass permissions` and `Plan (read-only)` per turn. These map to Claude's own `--permission-mode` (and the explicit bypass flag); `Plan` is read-only.
  - **8F OpenCode** offers only `Auto` (`opencode run --auto`).
- **Model**: optional per turn; leave empty to use the CLI's default. OpenCode exposes a catalog from `opencode models`; Claude Code's picker is read from `~/.claude/settings.json` (`modelPicker.options`), so you can choose the same provider/model refs you use in the terminal.
- **Persistence**: sessions are stored on the server in `~/.workgremlin/dispatch-sessions.json` (mode 0600), so restarting the server keeps the list and the client reopens the session it had last selected. A turn that was running when the server died is restored as **failed** with that reason, and a still-pending approval as **expired** — nothing is shown as if it had finished. Continuing a restored session reuses its product session id (OpenCode `ses_…` / Claude UUID).

This is reverse control: a dispatched task can modify files on the server. Keep the mode on `confirm` (or `off`) on networks you do not trust; the token is still plaintext HTTP/WS. Every request/decision is recorded in the `events` table (without the prompt text). The config path follows `WORKGREMLIN_HOME`, so a non-default home uses `<that home>/config.json`.

## Pages

### Office (default)

An isometric (2.5D) office that draws "which agent is doing what":

- **Floors**: pick a floor from the capsules on the left; switching plays an **elevator animation** (doors close, the car changes floors behind them, doors open on the new floor); each floor has its own furniture material/color so you can tell where you are. The dot/number on a capsule = whether that floor has active sessions and how many; products that are not installed are greyed out and not clickable. The lintel is the task ticker; the floor is shown in the left capsules/car.
- **Main agent console**: the floating screen shows its current phase — `idle / unreported / thinking / calling a tool / delegating to an expert / awaiting permission / waiting (for a subagent to report) / task done / task cancelled`. Hover the screen to pop up the action, target, skills and context; the bottom-left marks whether this phase is a **reported truth / inferred value / demo script**.
- **Gremlins (subagents at their desks)**: they walk in through the front door one by one and sit down; when summoned by the main agent (the `task` tool) they run to the **right side** of the console, take the task, reply "got it", then go back to their desk to work, and report the result at the console when done; while summoned, a **ghost** (this subagent instance) appears above their head and floats in through the front door. Idle ones go get water, print, or chat with someone; two or more blocked ones gather for a meeting on their own.
- **Interaction**: drag to pan · scroll to zoom · double-click to reset; click a desk for the task card; hover a gremlin for its current task; hover the console screen for phase details; `F` fullscreen / `Esc` exit fullscreen.
- **Top-bar session dropdown**: pick a session and the main console shows **that session's own** phase (with several sessions open, each shows its own — no cross-talk); with none picked it follows the current floor.
- Bottom-right action bar: `Demo mode` / `Gather for a meeting` / `Everyone back to their desks` / `Reset view`.

### Desk cards

One card per member on the current floor (the main agent is always the first):

- **Role**: main agent / project subagent / user subagent;
- **State**: only three levels — busy / idle / blocked (the status dot and the text share the same color; there is no offline or inferred state while the server is running);
- **Current task**: the one in progress; when idle it honestly says "idle" and does not leave the previous task on the card;
- **Description**: the "what it does" written in the subagent definition (static information, not state);
- **Time**: in progress shows "started MM-DD HH:mm", idle shows "last active MM-DD HH:mm";
- members that do not report are marked "passively observed"; unavailable fields stay empty instead of being inferred.

Only resident gremlins are listed; ghosts summoned temporarily do not take a card slot (avoiding the "summon once, one more in the list" confusion).

### Task records

The filters at the top apply to all three views at once:

- **Project / floor** (fetched from the server), **state / time / keyword** (filtered further on the current result);
- **Time** has eight presets: all time / today / yesterday / last 7 days / last 30 days / this month / last month / custom (custom reveals two date boxes). The basis is the task's **start time**, by calendar day.

1. **List view** — one row per task; open the details on the right: state, client, model, project, changed files, **tokens** (uncached input / cache read / cache write / output written separately; floors that cannot report it show "—" not 0), tool-usage counts, output result, and the subagent details it summoned. You can delete a single row, "delete the filtered results" for the current filter, and set the automatic retention days (default keeps the last 90 days; older ones are cleaned up by the server).
2. **Summary report** — the first tab is **data overview**: a per-row list `time / task / client / model / project / tokens / duration / state` (the task title takes only the first 10 characters plus an ellipsis; hover to see the full text; click any row to jump back to the list with that task selected). There are also **by project / by model / by floor** aggregate tables: task count, success count, cancelled count, changed-file count, total tokens, total duration, average duration; click a row to drill down to the list. The whole table can be exported to CSV.
3. **Graphical board (daily)** — one **floor × time** Gantt chart per day: the horizontal axis is 00:00–24:00 (one vertical line per hour), the vertical axis is floors (e.g. "3F Codex"), and the blocks in a row are that floor's tasks, colored by the task's state. When several run in parallel at the same time, the overlapping stretch is **darkened — the more tasks run at once, the deeper the colour** (one row per floor, no stacking downward), and hovering it names the count; when viewing today there is a "now" dashed line; click a block to jump to that task in the list. **Which days you can page back/forward to is decided by the time filter above** (buttons outside the window are greyed out). Days with no tasks still draw an empty table; when the filter is "all floors", **every installed floor gets its own row** (empty ones stay blank).

### Council

The first three pages are all about **looking** (others run the agents, we read the traces they leave). The council is the only page that **uses**: pick a few floors and start a multi-round discussion on one topic.

- **How to start**: write the topic → assign **one moderator, one main answerer and at least one reviewer** (three different floors) → optionally paste a few file paths (the server reads the text and inlines it into the prompt; over the limit it truncates and the UI states "original N bytes, only the first M inlined") → optionally set a **working directory** → set the max rounds → start. **Only floors that are installed and can be invoked headlessly are selectable**; the rest are greyed out with the reason (e.g. "no command-line executable found").
- **The process** (there is **no vote** at any point):
  1. **Round 0 — plan.** The moderator breaks the topic down and assigns review focus to each reviewer.
  2. **Round 1 — proposal.** The main answerer writes the first proposal. In later rounds it writes a revision.
  3. **Review.** Each reviewer answers independently, in a structured shape: `severity` (`blocker` / `major` / `minor` / `nit`), `dimension`, `issue`, optional `evidence`, `suggestion`, and `stance` (`reject` / `revise` / `accept`). Reviewers do not see each other's opinions.
  4. **Moderation.** The moderator writes a convergence summary and **hard revision directives** for the main answerer — no "it depends", no vague advice. Each directive must name the issue, the concrete change, and an acceptance condition: `【针对 <issue>】must <change>; acceptance: <checkable condition>`. The server flags vague directives and missing acceptance criteria.
  5. **Repeat** proposal → review → moderation for the configured number of rounds. A high score does not stop it early; **a failed turn does** — if a required participant times out, crashes, or returns something unparseable, the meeting ends right there instead of burning minutes on later rounds that can no longer add up. What was already produced is archived, and the reason names the round, phase and floor.
  6. **Adjudication → final draft.** The moderator gives the final adjudication; the main answerer produces the final draft with change notes. The report is archived to `~/.workgremlin/councils/<id>/` only (JSON + CSV + Markdown) — a working directory is read by the participants but never written to. Existing files are never overwritten.
- **You can see it working.** A turn can take minutes and says nothing until it ends, so right after you start a meeting a live strip shows `Working · floors · phase · round N`, pushed over the websocket and returned by the detail endpoint (a refresh keeps it). It disappears the moment the meeting ends.
- **Convergence is computed, not claimed.** The right-hand panel shows a score capped at 100:
  `100 − (blockers × 25 + majors × 8 + minors × 2 + conflicts × 10)`, clamped to 0..100. A model-reported score is ignored; `nit` carries no weight. The panel also shows the opinion/blocker/conflict counts and each role's floor, model and token usage. The complete process (plan, every proposal and its **diff against the previous version**, every review, the moderator's directives, adjudication and final draft) is collapsed by default.
- **Where to talk also has two modes**: **blank** (default) is isolated — a throwaway temp directory the server creates and deletes after each council. **An absolute path** (your project directory) is workspace mode — participants use it as the working directory. In **both** modes participants get **read-only tools**, so they can look up code themselves (read files, search by name/content); **they cannot modify any file or access the network**. The server **does not change a single line** in that directory and does not delete it afterwards. (Floors whose CLI cannot turn command execution off — 2F Cline's `--plan` and 3F Codex's read-only sandbox — may still run *read-only* commands; see `docs/requirements.md` §15.3.)
- **Not in the office**: participants do not appear in the office or in task records; they are visible only in the council. In workspace mode this takes two extra locks (turn off WorkGremlin's own reporting; 2F/6F/7F/8F participant sessions carry a fixed marker that the floor's session list skips, while 3F Codex writes no session at all) — see `docs/requirements.md` §15.3 for details.

Two things it does **not** do, to avoid misunderstanding: ① it does not touch the sessions you are running (no commands, no interruptions); ② it does not make up a conclusion for you — if someone did not answer, a process crashed, or the output cannot be parsed, that participant is shown with its **raw error**, no review point is invented, the meeting stops immediately instead of continuing, and a round with no diff says so instead of implying nothing changed. It **never treats "did not reply" as agreement, and never guesses from tone**. Tokens it cannot get show "—", not 0; when only part of a role's usage was reported the total is shown as a lower bound (`≥ N`).

## Supported floors

One monitored product per floor (the left capsules are ordered this way); **a floor is clickable only if installed**, otherwise greyed out:

| Floor | Product | Form |
| --- | --- | --- |
| 1F | CodeBuddy | CLI (terminal) and IDE plugin, merged into one floor |
| 2F | Cline | CLI and VS Code extension (same on-disk store, merged into one floor) |
| 3F | Codex | CLI and IDE plugin (same on-disk store, merged into one floor) |
| 4F | Claude Code | CLI and IDE plugin (same on-disk store, merged into one floor) |
| 5F | TraeCode | IDE proper and plugin |
| 6F | Qoder | CLI and plugin (same on-disk store, merged into one floor) |
| 7F | Kilo Code | Terminal TUI and VS Code extension |
| 8F | OpenCode | CLI / TUI / desktop / web (same data) |
| 9F | GitHub Copilot | CLI and VS Code extension (separate stores, merged into one floor) |

Among them, **1F / 2F / 3F / 4F / 6F / 7F / 8F can also join the council** (these are verified or documented to be invocable headlessly and narrowed to read-only tools); the other floors do not appear in the council candidates even if installed, and the other pages still show them.

## What it shows and does not show

- **Only truths**: state, tasks, files and duration all come from the agent's own reports or its local on-disk data; if it cannot get them it writes "unreported / —" rather than making up a number.
- **No fake progress**: the progress bar is gone — when there is no real per-round progress to advance, drawing one would only deceive.
- **Three workstation states**: busy / idle / blocked. Busy comes from a running task, blocked comes from an explicit authorization wait, and no explicit state means idle.
- **No business heartbeat**: task start / end times drive "last active". WebSocket ping only checks the network connection and never changes a workstation state.

## Data and configuration

- All data lives in `~/.workgremlin/`: `workgremlin.db` (one SQLite database) + each product's state files. Change the directory with `WORKGREMLIN_HOME`, change the database file with `WORKGREMLIN_DB`.
- At startup it **automatically writes the "status reporting hook" into the config of installed products** (only adds/updates our own entry, backing up to `.bak-workgremlin` before changing). To opt out of automatic config changes: `WORKGREMLIN_NO_AUTO_HOOKS=1`.
- Project follows the **selected session**: the session carries its workspace path, and the office loads that project's members. There is no global "open project" switch in the UI; project is only the ownership key for members/tasks/messages. The server keeps a default workspace for startup (`WORKGREMLIN_WORKSPACE=<dir>` / `--workspace <dir>` / cwd, remembered across restarts) as a fallback for legacy reports that omit `workspacePath` and for the floor poller. The project name is not shown as a separate global selector.
- Logs: by default outputs `info` / `warn` / `error`, and writes per-day to `~/.workgremlin/logs/workgremlin-<YYYY-MM-DD>.log`. For finer troubleshooting: `WORKGREMLIN_LOG=debug` (or `npm run server -- --log=debug`) enables per-event debug; to see only problems: `WORKGREMLIN_LOG=error`; `WORKGREMLIN_LOG_FILE=0` turns off file logging. **Keeps only 7 days by default** (`WORKGREMLIN_LOG_KEEP_DAYS` changes it): expired per-day files and expired lines in `hooks/events.log` are cleaned up at startup / when the day changes.

## Documentation

| What you want | Which file |
| --- | --- |
| What this release shipped, known issues | `docs/releases/` |
| What the product requires, acceptance criteria | `docs/requirements.md` |
| How the code actually works, where it diverges from the docs | `docs/implementation-status.md` |
| Tech choices and data structures | `docs/tech-design.md` |
| Run it / troubleshoot | `docs/runbook.md` |
