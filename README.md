# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent by Earendil Works.

## Extensions

### account-mux

Switch pi's `auth.json` between multiple accounts and API keys across providers (Anthropic by default; any provider works for API keys).

Named credential profiles live in `~/.pi/agent/auth-profiles.json`, keyed by provider; a switch swaps that provider's entry of `~/.pi/agent/auth.json`. Pi re-reads `auth.json` when its file revision changes, so switches take effect immediately, even in running sessions. The active **anthropic** profile is shown in the status bar (`⇄ name`).

| Command | What it does |
|---------|--------------|
| `/account` | Pick a profile to switch to (all providers). |
| `/account <name> [provider]` | Switch directly. Searches all providers if `provider` omitted; errors if the name exists under more than one. |
| `/account add <name> [provider]` | Prompt for an API key, store it as a profile, and switch to it. `provider` defaults to `anthropic` — use e.g. `openai` for a Codex key. |
| `/account save <name> [provider]` | Snapshot the current `auth.json` credential for `provider` as a profile and mark it active. |
| `/account remove <name> [provider]` | Delete a stored profile. |
| `/account list [provider]` | List profiles (all providers, or one) with emails / key prefixes; marks the active one. |
| `/account whoami [provider]` | Ask the Anthropic API which account the live token belongs to (anthropic oauth only). |

Safeguards, all of which exist because OAuth tokens rotate on refresh and several pi sessions share one `auth.json`:

- Switching syncs the live (possibly rotated) credential back into the profile it belongs to first, guarded by an identity check against `api.anthropic.com/api/oauth/profile` so a foreign credential is never written into the wrong profile. A foreign credential whose account matches another stored profile is synced into that profile instead.
- Writes cooperate with pi's `auth.json.lock` so a switch cannot race a concurrent OAuth refresh.
- A file watcher detects when another process overwrites `auth.json` with a different account — long-running pi sessions started under the old account do this — warns (`⇄ name ⚠ other@email`), and keeps known-profile credentials fresh. Re-assert with `/account <name>`, or restart the stale sessions.

#### Install

```bash
ln -s /path/to/pi-extensions/extensions/account-mux.ts ~/.pi/agent/extensions/account-mux.ts
```

Then restart pi (or `/reload`). Bootstrap by logging into each account via `/login` and running `/account save <name>` after each, or `/account add <name> [provider]` to register an API key profile without `/login`.

### bash-background

Run shell commands detached and wake the agent when they produce output or finish.

Tools:

| Tool | What it does |
|------|--------------|
| `bash_background({ command, timeout, description? })` | Spawn detached, capture combined stdout+stderr to a logfile, return immediately. Wake once on exit or timeout. |
| `monitor({ command, description? })` | Spawn detached and wake on new output in coalesced batches, plus once on exit. |
| `background_stop({ id })` | Tree-kill a running job by id. |
| `background_list()` | List live jobs. |

Use `bash_background` for finite long jobs like builds/tests, and `monitor` for streaming commands like dev servers or `tail -F`. `bash_background` requires a unit-bearing timeout such as `"30m"` or `"2h"` (maximum `24h`); bare numbers are rejected. `monitor` remains unbounded until stopped or the session shuts down. While the agent is busy, monitor output stays in one bounded extension-local batch; it is delivered after the agent settles, or discarded if the monitor is stopped first. This prevents uncancellable follow-up messages from accumulating in Pi's input queue.

Logs use random exclusive files with mode `0600`. They remain readable for 24 hours after completion and are then removed; stale logs are also cleaned on extension startup.

#### Install

Symlink into pi's global extensions directory:

```bash
ln -s /path/to/pi-extensions/extensions/bash-background.ts ~/.pi/agent/extensions/bash-background.ts
```

Or install this repo as a pi package:

```bash
pi install git:github.com/fl4p/pi-extensions
```

Then restart pi (or `/reload`).

### bash-duration

Overrides pi's built-in `bash` tool so timeout values require explicit units:

```json
{ "command": "python -m unittest", "timeout": "180s" }
```

Accepted units are `ms`, `s`, `m`, and `h`. Bare numbers are rejected, preventing confusion between tools that interpret numeric timeouts as seconds or milliseconds. Foreground commands are capped at one hour; use `bash_background` for longer jobs.

#### Install

Symlink into pi's global extensions directory:

```bash
ln -s /path/to/pi-extensions/extensions/bash-duration.ts ~/.pi/agent/extensions/bash-duration.ts
```

Or install the repo as a pi package. The extension is included in `package.json` and loads automatically:

```bash
pi install git:github.com/fl4p/pi-extensions
```

Then restart pi (or `/reload`).

### google-search

Adds `google_search`, which queries Google through [Serper](https://serper.dev) and returns raw titles, links, and snippets without model synthesis. Each call accepts one query or up to four query variants, with a 30-second deadline per request.

Set the API key through the environment:

```bash
export SERPER_API_KEY="..."
```

Or store it in `~/.pi/web-search.json` and restrict the file permissions:

```json
{ "serperApiKey": "..." }
```

```bash
chmod 600 ~/.pi/web-search.json
```

### block-web-search

Removes `web_search` (the Gemini-synthesis provider) from the active tool set at `session_start`, forcing the agent to use `google_search` (raw Google blue links via Serper) + `ctx_fetch_and_index` / `fetch_content` for primary sources instead.

Motivation: `web_search` returns an AI-synthesized answer that averages sources of different ages and quality into one confident paragraph — fine for conceptual questions, bad for any quantitative work where provenance and freshness matter (it gave stale supply figures and a 2×-inflated treasury number this session). `google_search` gives raw links with snippets; you judge and fetch primaries.

Hard block at the tool layer — the tool is removed before the agent sees it, so it can't be called. Equivalent to the CLI alias `pi -xt web_search` but permanent for every session that loads the extension.

#### Install

Install both the replacement and blocker together:

```bash
ln -s /path/to/pi-extensions/extensions/google-search.ts ~/.pi/agent/extensions/google-search.ts
ln -s /path/to/pi-extensions/extensions/block-web-search.ts ~/.pi/agent/extensions/block-web-search.ts
```

Or install the package, which loads both in the correct order:

```bash
pi install git:github.com/fl4p/pi-extensions
```

Then restart pi (or `/reload`).

### persistent-history

Makes pi's `<up>`/`<down>` editor prompt history persist across sessions and restarts.

pi keeps prompt history in memory on the `Editor` component. On startup it rebuilds that history from the *current session file*, so the history is per-session and never survives as a global, cross-session history. This extension seeds the editor from a JSON file on startup and writes new submissions back, so arrow-up recalls prompts across sessions and restarts.

History is stored at `~/.pi/agent/editor-history.json` (most-recent-first, capped at 100 entries). Concurrent sessions merge under a lock, and updates use atomic mode-`0600` replacement.

#### Install

Symlink the file into pi's global extensions directory:

```bash
ln -s /path/to/pi-extensions/extensions/persistent-history.ts ~/.pi/agent/extensions/persistent-history.ts
```

Or, as a pi package (resolves via the `pi.extensions` field in `package.json`):

```bash
pi install git:github.com/fl4p/pi-extensions
```

Then restart pi (or run `/reload`).

#### Notes

- Composes with other editor-replacing extensions: it wraps whatever factory is already registered via `getEditorComponent()`. For the persistence override to be effective, this extension must be the outermost editor wrapper — load it *after* any other `setEditorComponent()` extension.
- Only acts in TUI mode (`ctx.mode === "tui"`).
- Persists only on real keystroke-driven submissions, not on the initial session-restore rebuild, so resuming a session does not pollute the global history file with that session's messages.

### turn-timer

Shows how long the last agent turn took in the TUI status bar.

Records a timestamp at `agent_start` and, at `agent_end`, renders the elapsed time (e.g. `⏱ 42.3s` or `⏱ 2m5s`) as a dim status entry. The status is cleared when the next turn starts.

#### Install

```bash
ln -s /path/to/pi-extensions/extensions/turn-timer.ts ~/.pi/agent/extensions/turn-timer.ts
```

Then restart pi (or `/reload`).

### skill-reread

Re-anchors skill knowledge after compaction.

Pi loads skill bodies (SKILL.md and reference files) as ordinary `read` tool results, so compaction summarizes them away. Long agentic sessions then operate on summarized memory of API names and CLI flags and regress into invented-interface guess-loops (observed: six consecutive invented pcbnew attributes in one PCB-design run, all post-compaction).

On each compaction the extension scans the active session branch for skill files that entered context — successful `read` tool calls on paths under a skills directory, and `/skill:name` expansions (whose `<skill ... location>` header carries the exact path wherever the skill lives) — and injects a context-visible message listing them, instructing the agent to re-read before relying on any interface they document. For threshold/manual compactions the message is appended without continuing the agent run; overflow-retry compactions deliver it with the retried turn. Skill files read via bash (`cat`/`grep`) are not tracked.

Note for benchmarking/eval work: this actively helps the model — record its presence as part of the harness condition.

#### Install

```bash
ln -s /path/to/pi-extensions/extensions/skill-reread.ts ~/.pi/agent/extensions/skill-reread.ts
```

Then restart pi (or `/reload`).

### auto-continue

Nudges the agent when a run ends with a contentless turn.

Pi treats any assistant turn without a tool call as the end of the run and goes idle without warning. Providers produce such turns mid-task: `stopReason: "length"` with the whole token budget spent inside thinking (observed twice from GLM-5.3-Flash, at both 16k and 32k caps), and `stopReason: "stop"` with an entirely empty content array (observed once from the same serving at the context-window edge). Each one silently strands an unattended session until a human types "continue".

On `agent_settled` (fired only after the run, automatic retries, and post-run compaction have all finished) the extension inspects the final assistant message on the active branch. If it stalled — `length` or `stop` with no tool call and no non-whitespace text — it sends a neutral continue message (`customType: "auto-continue"`, visible in the session file) that triggers a fresh run.

Deliberately out of scope: `error` (pi's retry layer owns errors), `aborted` (the user pressed ESC), length-stops that did emit text (truncated but visible output — a human should judge it), and any stall a user message has already answered. Consecutive auto-continues are capped at 3; the cap resets on a productive turn end or human input (`interactive`/`rpc` — extension-sourced input does not rearm it), and at most one injection is sent per started run. While another run is live, a compaction is in flight, or a human's prompt is between `input` and its `agent_start` (the pre-prompt compaction window), it skips without queuing — skipping is the fail-safe direction.

Note for benchmarking/eval work: this actively helps the model — an unattended session survives stalls a bare harness would not. Record its presence as part of the harness condition and count its injections as run events.

#### Install

```bash
ln -s /path/to/pi-extensions/extensions/auto-continue.ts ~/.pi/agent/extensions/auto-continue.ts
```

Then restart pi (or `/reload`).

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
