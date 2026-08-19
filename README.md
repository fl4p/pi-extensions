# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent by Earendil Works.

## Extensions

### bash-background

Run shell commands detached and wake the agent when they produce output or finish.

Tools:

| Tool | What it does |
|------|--------------|
| `bash_background({ command, timeout, description? })` | Spawn detached, capture combined stdout+stderr to a logfile, return immediately. Wake once on exit or timeout. |
| `monitor({ command, description? })` | Spawn detached and wake on new output in coalesced batches, plus once on exit. |
| `background_stop({ id })` | Tree-kill a running job by id. |
| `background_list()` | List live jobs. |

Use `bash_background` for finite long jobs like builds/tests, and `monitor` for streaming commands like dev servers or `tail -F`. `bash_background` requires a unit-bearing timeout such as `"30m"` or `"2h"` (maximum `24h`); bare numbers are rejected. `monitor` remains unbounded until stopped or the session shuts down.

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

### block-web-search

Removes `web_search` (the Gemini-synthesis provider) from the active tool set at `session_start`, forcing the agent to use `google_search` (raw Google blue links via Serper) + `ctx_fetch_and_index` / `fetch_content` for primary sources instead.

Motivation: `web_search` returns an AI-synthesized answer that averages sources of different ages and quality into one confident paragraph — fine for conceptual questions, bad for any quantitative work where provenance and freshness matter (it gave stale supply figures and a 2×-inflated treasury number this session). `google_search` gives raw links with snippets; you judge and fetch primaries.

Hard block at the tool layer — the tool is removed before the agent sees it, so it can't be called. Equivalent to the CLI alias `pi -xt web_search` but permanent for every session that loads the extension.

#### Install

Symlink into pi's global extensions directory:

```bash
ln -s /Users/fab/dev/vibe/pi-extensions/extensions/block-web-search.ts ~/.pi/agent/extensions/block-web-search.ts
```

Then restart pi (or `/reload`).

### persistent-history

Makes pi's `<up>`/`<down>` editor prompt history persist across sessions and restarts.

pi keeps prompt history in memory on the `Editor` component. On startup it rebuilds that history from the *current session file*, so the history is per-session and never survives as a global, cross-session history. This extension seeds the editor from a JSON file on startup and writes new submissions back, so arrow-up recalls prompts across sessions and restarts.

History is stored at `~/.pi/agent/editor-history.json` (most-recent-first, capped at 100 entries).

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

## License

MIT
