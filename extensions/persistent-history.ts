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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const HISTORY_FILE = path.join(os.homedir(), ".pi", "agent", "editor-history.json");
const LOCK_DIR = `${HISTORY_FILE}.lock`;
const MAX = 100;
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function loadHistory(): string[] {
	try {
		const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
		if (Array.isArray(arr)) {
			return arr.filter((x): x is string => typeof x === "string").slice(0, MAX);
		}
	} catch {}
	return [];
}

function acquireLock(): () => void {
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
			return () => fs.rmSync(LOCK_DIR, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
					fs.rmSync(LOCK_DIR, { recursive: true, force: true });
					continue;
				}
			} catch {}
			Atomics.wait(sleeper, 0, 0, LOCK_RETRY_MS);
		}
	}
	throw new Error("Timed out waiting for editor history lock");
}

function atomicWriteHistory(history: string[]): void {
	const temp = `${HISTORY_FILE}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(history.slice(0, MAX)), "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temp, HISTORY_FILE);
		fs.chmodSync(HISTORY_FILE, 0o600);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(temp);
		} catch {}
	}
}

export function saveHistory(history: string[]): void {
	try {
		fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
		const release = acquireLock();
		try {
			const disk = loadHistory();
			const latest = history[0] === undefined ? [] : [history[0]];
			const merged = [...new Set([...latest, ...disk, ...history.slice(1)])].slice(0, MAX);
			atomicWriteHistory(merged);
		} finally {
			release();
		}
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
			const historyEditor = editor as unknown as {
				history?: string[];
				addToHistory?: (text: string) => void;
				handleInput: (data: string) => void;
			};
			if (!Array.isArray(historyEditor.history) || typeof historyEditor.addToHistory !== "function") return editor;

			if (historyEditor.history.length === 0) historyEditor.history = loadHistory();

			// Persist only on real submissions, not on the initial
			// renderSessionContext populateHistory rebuild. Arm on the
			// first keystroke, which always follows that rebuild.
			let persistEnabled = false;
			const origAdd = historyEditor.addToHistory.bind(editor);
			historyEditor.addToHistory = (text: string) => {
				origAdd(text);
				if (persistEnabled) saveHistory(historyEditor.history!);
			};
			const origInput = historyEditor.handleInput.bind(editor);
			historyEditor.handleInput = (data: string) => {
				persistEnabled = true;
				origInput(data);
			};

			return editor;
		});
	});
}
