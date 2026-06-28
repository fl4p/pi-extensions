/**
 * Persistent editor history.
 *
 * pi keeps the <up>/<down> prompt history in memory on the Editor component
 * (`editor.history`, fed by `addToHistory`). It is rebuilt per session from
 * the session file and never survives a restart as a *global* history. This
 * extension seeds the editor from a JSON file on startup and writes new
 * submissions back, so arrow-up recalls prompts across sessions and restarts.
 *
 * Composes with other editor-replacing extensions: it wraps whatever factory
 * is already registered via getEditorComponent(). For the persistence override
 * to take effect, this extension must be the outermost editor wrapper, i.e.
 * load after any other setEditorComponent() extension. With no other such
 * extension present (the default), it wraps pi's built-in CustomEditor.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HISTORY_FILE = path.join(os.homedir(), ".pi", "agent", "editor-history.json");
const MAX = 100;

function loadHistory(): string[] {
	try {
		const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
		if (Array.isArray(arr)) {
			return arr.filter((x): x is string => typeof x === "string").slice(0, MAX);
		}
	} catch {}
	return [];
}

function saveHistory(history: string[]): void {
	try {
		fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, MAX)));
	} catch {}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previousFactory
				? previousFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);

			if (editor.history.length === 0) {
				editor.history = loadHistory();
			}

			// Persist only on real submissions, not on the initial
			// renderSessionContext populateHistory rebuild. Arm on the
			// first keystroke, which always follows that rebuild.
			let persistEnabled = false;
			const origAdd = editor.addToHistory.bind(editor);
			editor.addToHistory = (text: string) => {
				origAdd(text);
				if (persistEnabled) saveHistory(editor.history);
			};
			const origInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				persistEnabled = true;
				origInput(data);
			};

			return editor;
		});
	});
}
