# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent by Earendil Works.

## Extensions

### block-web-search

Removes `web_search` (the Gemini-synthesis provider) from the active tool set at `session_start`, forcing the agent to use `google_search` (raw Google blue links via Server) + `ctx_fetch_and_index` / `fetch_content` for primary sources instead.

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

## License

MIT
