/**
 * kb-push — push knowledge-base notes when a bash command touches a domain's tooling.
 *
 * Problem: ~/dev/kb is pull. Every harness loads a stanza saying "read
 * ~/dev/kb/INDEX.md before deriving a claim", and nothing checks that anyone
 * does. On 2026-09-10 a session spent four wrong hypotheses on a silent
 * ESP32-S3 while a kb note described the exact symptom: the rule was loaded,
 * the trigger was not recognised. Claude Code closes that gap with a PreToolUse
 * hook (~/.claude/hooks/kb-push.sh) that pushes a domain's index lines the
 * moment a command touches that domain's tooling. pi reads no Claude Code
 * hooks, so it got nothing.
 *
 * Fix: on every bash `tool_call`, hand the command to that same script and
 * inject whatever it returns as a custom message. The trigger table and the
 * once-per-session stamps stay in the script — one copy of the rule, not a
 * TypeScript port that drifts from it. Stamps are keyed `pi-<session id>` so a
 * pi session can never collide with a Claude Code session's stamps in the
 * shared stamp directory.
 *
 * Delivery: plain `deliverAs: "steer"`. `tool_call` only fires inside an active
 * run, so the steer queue is drained after this batch's tool results and the
 * notes land before the model reads the command's output — no extra model
 * call. Deliberately NOT skill-reread's `triggerTurn: false`: while a run is
 * active pi 0.84 treats that as "append to state now", which puts the message
 * between the assistant's tool call and its result, outside the running loop's
 * context snapshot, so the model would not see it until the next prompt.
 *
 * Never slows or breaks a command: the script gets a 2 s budget (it measures
 * ~20 ms), and a missing script, timeout, non-zero exit, empty or unparseable
 * output all mean "no message". The handler never blocks or mutates the call,
 * and nothing throws out of it — a throwing `tool_call` handler blocks the tool.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "kb-push";
export const DEFAULT_SCRIPT = join(homedir(), ".claude", "hooks", "kb-push.sh");
export const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface KbPushOptions {
	/** Hook script speaking Claude Code's PreToolUse JSON contract. */
	script?: string;
	timeoutMs?: number;
}

// Used only if the session manager cannot produce an id. Scoped to this
// extension load, so dedupe degrades to once per pi process rather than
// colliding across every id-less pi session in the stamp directory.
const FALLBACK_ID = `proc-${randomUUID()}`;

/** Stamp key for the current session: `pi-<session id>`, safe as a filename. */
export function stampSessionId(ctx: ExtensionContext): string {
	let id: unknown;
	try {
		id = ctx.sessionManager.getSessionId();
	} catch {
		id = undefined;
	}
	const raw = typeof id === "string" && id.length > 0 ? id : FALLBACK_ID;
	return `pi-${raw.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Extract `hookSpecificOutput.additionalContext`; anything else is "no message". */
export function parseHookOutput(stdout: string): string | undefined {
	if (stdout.trim() === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const context = (parsed as { hookSpecificOutput?: { additionalContext?: unknown } } | null)?.hookSpecificOutput
		?.additionalContext;
	if (typeof context !== "string" || context.trim() === "") return undefined;
	return context.trimEnd();
}

/** Run the hook script for one command. Resolves the context text, or undefined on any failure. */
export function runKbPush(
	command: string,
	sessionId: string,
	options: KbPushOptions = {},
	signal?: AbortSignal,
): Promise<string | undefined> {
	const script = options.script ?? DEFAULT_SCRIPT;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise((resolve) => {
		let child: ChildProcess | undefined;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const chunks: Buffer[] = [];
		let bytes = 0;

		const kill = () => {
			if (!child || child.exitCode !== null || child.signalCode !== null) return;
			try {
				// The script is bash with jq/grep children: take the whole group.
				if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => {
			kill();
			finish(undefined);
		};

		if (signal?.aborted) return finish(undefined);
		try {
			child = spawn(script, [], {
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			return finish(undefined);
		}
		// A missing or non-executable script arrives here as ENOENT/EACCES.
		child.once("error", () => finish(undefined));
		child.stdin?.on("error", () => {});
		child.stdout?.on("error", () => {});
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				kill();
				finish(undefined);
				return;
			}
			chunks.push(chunk);
		});
		child.once("close", (code) => {
			finish(code === 0 ? parseHookOutput(Buffer.concat(chunks).toString("utf8")) : undefined);
		});
		timer = setTimeout(() => {
			kill();
			finish(undefined);
		}, timeoutMs);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin?.end(JSON.stringify({ tool_input: { command }, session_id: sessionId }));
	});
}

export function registerKbPush(pi: ExtensionAPI, options: KbPushOptions = {}) {
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isToolCallEventType("bash", event)) return undefined;
			const command = event.input.command;
			if (typeof command !== "string" || command.trim() === "") return undefined;
			const content = await runKbPush(command, stampSessionId(ctx), options, ctx.signal);
			if (content === undefined) return undefined;
			pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true }, { deliverAs: "steer" });
		} catch {
			// Never let this handler block the command it is annotating.
		}
		return undefined;
	});
}

export default function kbPush(pi: ExtensionAPI) {
	registerKbPush(pi);
}
