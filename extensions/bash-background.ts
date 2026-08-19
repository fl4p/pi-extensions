/**
 * pi-bash-background — run shell commands detached and get woken when they
 * produce output or finish. Brings Claude Code's `Bash(run_in_background)`
 * semantic (and a batched `monitor`) to the Pi coding agent, which otherwise
 * has no background-bash support (Pi's stance is "use tmux").
 *
 * Tools registered:
 *   bash_background({ command, timeout, description? }) — detached; wake ONCE on exit or timeout.
 *   monitor({ command, description? })         — detached; wake on NEW output
 *                                                (coalesced into batches).
 *   background_stop({ id })                    — tree-kill a job; no wake.
 *   background_list()                          — list live jobs.
 *
 * The wake is `pi.sendUserMessage(...)`, which "always triggers a turn". We use
 * the session-bound `pi` handle (NOT a captured execute-ctx) so the wake follows
 * the active session instead of throwing on a stale ctx after fork/reload.
 *
 * Install:  pi -e /path/to/pi-bash-background/src/index.ts
 *   or symlink src/index.ts into ~/.pi/agent/extensions/ (see README).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Kind = "background" | "monitor";

interface Job {
	id: string;
	kind: Kind;
	description: string;
	command: string;
	logpath: string;
	child: ChildProcess;
	stopped: boolean; // user stopped it intentionally -> suppress wakes
	done: boolean; // dedup: error+exit can both fire -> finish at most once
	timeout?: string;
	timedOut?: boolean;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	killHandle?: ReturnType<typeof setTimeout>;
	// monitor-only state:
	logfd?: number;
	pending?: string[]; // complete lines not yet delivered
	pendingBytes?: number;
	carry?: string; // partial trailing line across chunks
	droppingLine?: boolean;
	truncated?: boolean; // pending was capped since last flush
	flushTimer?: ReturnType<typeof setInterval>;
}

// monitor: how often to deliver accumulated new output, and how much to keep
// per batch (so a chatty process can't flood a single turn). 200ms coalesces a
// burst into one wake while still feeling near-real-time.
const MONITOR_FLUSH_MS = 200;
const MONITOR_MAX_PENDING_BYTES = 8_000;
const MAX_BACKGROUND_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = "pi-bg-";
const DURATION_PATTERN = "^[0-9]+(?:\\.[0-9]+)?(?:ms|s|m|h)$";
const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/;
const MILLISECONDS_PER_UNIT = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

function parseDurationMs(duration: string): number {
	const match = DURATION_RE.exec(duration);
	if (!match) {
		throw new Error('Invalid timeout: use an explicit duration such as "30m", "2h", or "500ms"');
	}
	const timeoutMs = Number(match[1]) * MILLISECONDS_PER_UNIT[match[2] as keyof typeof MILLISECONDS_PER_UNIT];
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
		throw new Error("Invalid timeout: duration must be at least 1ms");
	}
	if (timeoutMs > MAX_BACKGROUND_TIMEOUT_MS) {
		throw new Error("Invalid timeout: bash_background is limited to 24h");
	}
	return timeoutMs;
}

// Watch-shaped commands never exit, so bash_background's wake-on-exit never fires.
// Match only at a real shell-command boundary; ordinary arguments such as
// `echo watch` must remain valid finite commands.
const WATCH_SHAPED =
	/(?:^|[|;&]\s*|\n\s*)(?:tail\s+(?:-[a-zA-Z]*[fF]\b|--follow)|watch\b|journalctl\b[^|;&]*\s-f\b|while\s+(?:true\b|:)|until\s+false\b|for\s*\(\(\s*;\s*;\s*\)\))/;

const SUPERVISOR_SOURCE = [
	'const { spawn, spawnSync } = require("node:child_process");',
	"const [shell, command] = process.argv.slice(1);",
	'process.on("SIGTERM", () => {});',
	'process.on("SIGINT", () => {});',
	'const child = spawn(shell, ["-c", command], { stdio: "inherit" });',
	'child.on("error", () => process.exit(1));',
	'child.on("exit", (code) => {',
	'  const check = () => {',
	'    const result = spawnSync("ps", ["-o", "pid=", "-g", String(process.pid)], { encoding: "utf8", detached: true });',
	'    if (result.status !== 0) return setTimeout(check, 50);',
	'    const others = result.stdout.split(/\\s+/).filter(Boolean).some((pid) => Number(pid) !== process.pid);',
	'    if (others) return setTimeout(check, 50);',
	'    process.exit(code ?? 1);',
	'  };',
	'  check();',
	'});',
].join("\n");

function createLogFile(id: string): { logpath: string; logfd: number } {
	const logpath = join(tmpdir(), `${LOG_PREFIX}${id}-${randomUUID()}.log`);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
	return { logpath, logfd: openSync(logpath, flags, 0o600) };
}

function cleanupOldLogs(now = Date.now()): void {
	try {
		for (const name of readdirSync(tmpdir())) {
			if (!name.startsWith(LOG_PREFIX) || !name.endsWith(".log")) continue;
			const path = join(tmpdir(), name);
			try {
				if (now - statSync(path).mtimeMs > LOG_RETENTION_MS) unlinkSync(path);
			} catch {
				/* raced with another cleanup */
			}
		}
	} catch {
		/* temp directory unavailable */
	}
}

function scheduleLogCleanup(logpath: string): void {
	setTimeout(() => {
		try {
			unlinkSync(logpath);
		} catch {
			/* already removed */
		}
	}, LOG_RETENTION_MS).unref();
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let seq = 0;
	cleanupOldLogs();

	// Track streaming state ourselves: ExtensionAPI has no isIdle(), and the
	// wake must pick the right delivery mode at fire time.
	let streaming = false;
	pi.on("agent_start", () => {
		streaming = true;
	});
	pi.on("agent_end", () => {
		streaming = false;
	});

	function wake(text: string) {
		// Always triggers a turn when idle; while streaming, queue as a follow-up
		// so a wake never truncates the in-flight turn. Stay non-fatal — a failed
		// wake (e.g. session mid-teardown) must not crash the watcher.
		try {
			if (streaming) pi.sendUserMessage(text, { deliverAs: "followUp" });
			else pi.sendUserMessage(text);
		} catch {
			/* drop */
		}
	}

	function killTree(job: Job, immediate = false) {
		const { child } = job;
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		if (job.killHandle) {
			if (!immediate) return;
			clearTimeout(job.killHandle);
			job.killHandle = undefined;
		}
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			return;
		}
		if (immediate) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
			return;
		}
		job.killHandle = setTimeout(() => {
			job.killHandle = undefined;
			// A live leader proves this is still the original process group; once
			// it exits, its numeric PGID must never be signalled again.
			if (child.exitCode !== null || child.signalCode !== null) return;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, 2000);
		job.killHandle.unref();
	}

	function newId() {
		return `bg-${seq++}`;
	}

	// ---- monitor line handling --------------------------------------------

	function queueLine(job: Job, line: string) {
		const bytes = Buffer.byteLength(line, "utf8") + 1;
		if (bytes > MONITOR_MAX_PENDING_BYTES || (job.pendingBytes ?? 0) + bytes > MONITOR_MAX_PENDING_BYTES) {
			job.truncated = true;
			return;
		}
		job.pending!.push(line);
		job.pendingBytes = (job.pendingBytes ?? 0) + bytes;
	}

	function ingest(job: Job, chunk: Buffer) {
		if (job.logfd !== undefined) {
			try {
				writeSync(job.logfd, chunk);
			} catch {
				/* logfile gone; keep streaming to the model anyway */
			}
		}

		let incoming = chunk.toString("utf8");
		if (job.droppingLine) {
			const newline = incoming.indexOf("\n");
			if (newline === -1) return;
			incoming = incoming.slice(newline + 1);
			job.droppingLine = false;
		}

		const parts = `${job.carry ?? ""}${incoming}`.split("\n");
		const carry = parts.pop() ?? "";
		if (Buffer.byteLength(carry, "utf8") > MONITOR_MAX_PENDING_BYTES) {
			job.carry = "";
			job.droppingLine = true;
			job.truncated = true;
		} else {
			job.carry = carry;
		}
		for (const line of parts) queueLine(job, line);
	}

	function flush(job: Job) {
		const pending = job.pending!;
		if (pending.length === 0 && !job.truncated) return;
		const body = pending.join("\n");
		pending.length = 0;
		job.pendingBytes = 0;
		const note = job.truncated ? "\n(some lines dropped this batch — Read the logfile for full output)" : "";
		job.truncated = false;
		wake(`[monitor:${job.description}] (${job.id}) new output:\n${body}${note}`);
	}

	function finish(job: Job, text: string) {
		if (job.done) return;
		job.done = true;
		if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
		if (job.killHandle) clearTimeout(job.killHandle);
		if (job.flushTimer) clearInterval(job.flushTimer);
		if (job.logfd !== undefined) {
			try {
				closeSync(job.logfd);
			} catch {
				/* ignore */
			}
		}
		jobs.delete(job.id);
		scheduleLogCleanup(job.logpath);
		if (!job.stopped) wake(text);
	}

	function exitClause(code: number | null, signal: NodeJS.Signals | null) {
		return code !== null ? `exited with code ${code}` : `terminated by signal ${signal ?? "unknown"}`;
	}

	// ---- bash_background ----------------------------------------------------

	const bashBackground = defineTool({
		name: "bash_background",
		label: "Bash (background)",
		description:
			"Run a shell command detached and return immediately; combined stdout+stderr go to a " +
			"logfile you can Read anytime. Requires a unit-bearing timeout and notifies once when the job exits or times out. " +
			"For FINITE long jobs (builds, tests, servers). To watch a file/stream (tail -F, log tails, poll loops) " +
			"use `monitor` — those intentionally run without a timeout.",
		promptSnippet:
			"bash_background({command, timeout, description}): run a finite command detached; get notified on exit or timeout.",
		promptGuidelines: [
			"Finite jobs only (wakes once on exit or timeout). For file/stream watching use `monitor` (wakes on new output).",
			'Always give bash_background a unit-bearing timeout such as "30m" or "2h"; bare numbers are invalid.',
			"Don't sleep-and-poll the logfile to await completion — the exit wake is automatic; Read it anytime for progress.",
			"Stop with background_stop({id}); list with background_list().",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background." }),
			timeout: Type.String({
				pattern: DURATION_PATTERN,
				description: 'Required unit-bearing timeout such as "30m", "2h", or "500ms" (maximum 24h).',
			}),
			description: Type.Optional(
				Type.String({ description: "Short human-readable label (shown in the exit notification)." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			// Code-level routing guard: a watch never exits, so the wake-on-exit never
			// fires. Refuse (don't even arm) and point at monitor — works even for
			// models that ignore the prose guideline.
			if (WATCH_SHAPED.test(params.command)) {
				return errorResult(
					"bg-rejected",
					`Refused: "${params.command}" looks like a watch (it never exits), so bash_background ` +
						`would never wake you. Use monitor({command}) instead — it's built for streaming output.`,
				);
			}

			const timeoutMs = parseDurationMs(params.timeout);
			const id = newId();
			const description = params.description?.trim() || params.command.slice(0, 60);
			let log: ReturnType<typeof createLogFile>;
			try {
				log = createLogFile(id);
			} catch (err) {
				return errorResult(id, `Failed to create logfile: ${String(err)}`);
			}
			const { logpath, logfd } = log;

			let child: ChildProcess;
			try {
				child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE, process.env.SHELL || "/bin/sh", params.command], {
					cwd: ctx.cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", logfd, logfd], // stdout+stderr -> logfile
				});
			} catch (err) {
				closeSync(logfd);
				return errorResult(id, `Failed to spawn: ${String(err)}`);
			}
			closeSync(logfd); // child has its own dup'd descriptor now

			const job: Job = {
				id,
				kind: "background",
				description,
				command: params.command,
				logpath,
				child,
				stopped: false,
				done: false,
				timeout: params.timeout,
			};
			jobs.set(id, job);
			job.timeoutHandle = setTimeout(() => {
				if (job.done) return;
				job.timedOut = true;
				killTree(job);
			}, timeoutMs);
			job.timeoutHandle.unref();

			child.on("error", (err) => finish(job, `[bash_background:${description}] (${id}) failed to run: ${String(err)}.`));
			child.on("exit", (code, signal) => {
				const outcome = job.timedOut ? `timed out after ${job.timeout}` : exitClause(code, signal);
				finish(
					job,
					`[bash_background:${description}] (${id}) ${outcome}. ` +
						`Combined output is in ${logpath} — Read it to see the results.`,
				);
			});

			return armedResult(id, child.pid, logpath, description, `exits or reaches its ${params.timeout} timeout`);
		},
	});

	// ---- monitor ------------------------------------------------------------

	const monitor = defineTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Run a shell command detached and get woken on NEW output (batched, not one turn per line); " +
			"stdout+stderr also go to a logfile you can Read for the full stream. For watching a streaming " +
			"source (dev server, tail -F, a growing log). For a one-shot 'tell me when it's done', use " +
			"bash_background instead.",
		promptSnippet: "monitor({command, description}): run a command detached; get woken on new output (batched).",
		promptGuidelines: [
			"For streaming output (dev server, tail -F, logs). Use bash_background for finite jobs (wakes once on exit).",
			"Delivered in batches and capped per batch — Read the logpath for the complete stream.",
			"Stop with background_stop({id}); list with background_list().",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run and monitor." }),
			description: Type.Optional(Type.String({ description: "Short human-readable label (shown in notifications)." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const id = newId();
			const description = params.description?.trim() || params.command.slice(0, 60);
			let log: ReturnType<typeof createLogFile>;
			try {
				log = createLogFile(id);
			} catch (err) {
				return errorResult(id, `Failed to create logfile: ${String(err)}`);
			}
			const { logpath, logfd } = log;

			let child: ChildProcess;
			try {
				child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE, process.env.SHELL || "/bin/sh", params.command], {
					cwd: ctx.cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"], // capture lines ourselves
				});
			} catch (err) {
				closeSync(logfd);
				return errorResult(id, `Failed to spawn: ${String(err)}`);
			}

			const job: Job = {
				id,
				kind: "monitor",
				description,
				command: params.command,
				logpath,
				child,
				stopped: false,
				done: false,
				logfd,
				pending: [],
				pendingBytes: 0,
				carry: "",
				droppingLine: false,
				truncated: false,
			};
			jobs.set(id, job);

			child.stdout?.on("data", (c: Buffer) => ingest(job, c));
			child.stderr?.on("data", (c: Buffer) => ingest(job, c));
			job.flushTimer = setInterval(() => flush(job), MONITOR_FLUSH_MS);

			child.on("error", (err) => finish(job, `[monitor:${description}] (${id}) failed to run: ${String(err)}.`));
			// `close` (not `exit`) fires after stdout/stderr are fully drained, so the
			// trailing partial line and last buffered lines are captured before the
			// final wake (exit can fire while pipe data is still pending).
			child.on("close", (code, signal) => {
				if (job.carry) queueLine(job, job.carry);
				job.carry = "";
				const body = job.pending!.join("\n");
				const note = job.truncated ? "\n(some output dropped — Read the logfile for the full stream)" : "";
				const tail = body || note ? `\nFinal output:\n${body}${note}` : "";
				job.pending!.length = 0;
				job.pendingBytes = 0;
				finish(
					job,
					`[monitor:${description}] (${id}) ${exitClause(code, signal)}. Full output in ${logpath}.${tail}`,
				);
			});

			return armedResult(id, child.pid, logpath, description, "produces output or exits");
		},
	});

	// ---- background_stop ----------------------------------------------------

	const backgroundStop = defineTool({
		name: "background_stop",
		label: "Stop background job",
		description: "Tree-kill a running bash_background or monitor job by id. No notification is sent (the stop is intentional).",
		parameters: Type.Object({
			id: Type.String({ description: "The job id returned by bash_background/monitor (e.g. bg-0)." }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const job = jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `No live job with id ${params.id}.` }],
					details: { id: params.id, stopped: false },
				};
			}
			job.stopped = true;
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.flushTimer) clearInterval(job.flushTimer);
			if (job.logfd !== undefined) {
				try {
					closeSync(job.logfd);
				} catch {
					/* ignore */
				}
			}
			killTree(job);
			jobs.delete(params.id);
			return {
				content: [
					{ type: "text", text: `Stopped ${params.id} ("${job.description}"). Output remains in ${job.logpath}.` },
				],
				details: { id: params.id, stopped: true, logpath: job.logpath },
			};
		},
	});

	// ---- background_list ----------------------------------------------------

	const backgroundList = defineTool({
		name: "background_list",
		label: "List background jobs",
		description: "List the currently running bash_background and monitor jobs (id, kind, pid, logfile).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const live = [...jobs.values()];
			if (live.length === 0) {
				return { content: [{ type: "text", text: "No background jobs running." }], details: { jobs: [] } };
			}
			const lines = live.map((j) => `${j.id}  [${j.kind}]  pid ${j.child.pid}  "${j.description}"  -> ${j.logpath}`);
			return {
				content: [{ type: "text", text: `Running jobs:\n${lines.join("\n")}` }],
				details: {
					jobs: live.map((j) => ({
						id: j.id,
						kind: j.kind,
						pid: j.child.pid,
						description: j.description,
						logpath: j.logpath,
					})),
				},
			};
		},
	});

	// ---- shared result builders --------------------------------------------

	function errorResult(id: string, message: string) {
		return { content: [{ type: "text" as const, text: message }], details: { id, error: true } };
	}

	function armedResult(id: string, pid: number | undefined, logpath: string, description: string, wakeWhen: string) {
		return {
			content: [
				{
					type: "text" as const,
					text:
						`Job armed: ${id} ("${description}"). PID ${pid}. Output streaming to ${logpath}. ` +
						`You'll be notified when it ${wakeWhen}; Read the logfile anytime to check progress.`,
				},
			],
			details: { id, pid, logpath },
		};
	}

	pi.registerTool(bashBackground);
	pi.registerTool(monitor);
	pi.registerTool(backgroundStop);
	pi.registerTool(backgroundList);

	// Best-effort cleanup so we never leak detached process groups.
	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			job.stopped = true;
			if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
			if (job.flushTimer) clearInterval(job.flushTimer);
			killTree(job, true);
		}
		jobs.clear();
	});
}
