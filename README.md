# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent by Earendil Works.

## Extensions

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
