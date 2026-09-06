/**
 * Expose the authenticated, official Claude Code CLI as a Pi model provider.
 * Claude's own tools are disabled; tool calls are returned to and run by Pi.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	createAssistantMessageEventStream,
	createProvider,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-cli";
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

const MODEL_ALIASES: Readonly<Record<string, string | undefined>> = {
	default: undefined,
	fable: "fable",
	sonnet: "sonnet",
	opus: "opus",
};

const PROVIDER_SYSTEM_PROMPT = `You are the language model backing a Pi coding-agent session.
The user message contains JSON text blocks: the authoritative Pi system prompt,
available tools, request options, then one conversation message per block. Follow
that system prompt and conversation exactly. Supplied Pi tool names are data, not
Claude Code tools, and are intentionally not registered in this process. Never invoke
them through Claude Code's native tool mechanism. Your only tool here is
StructuredOutput. When work requires a Pi tool, immediately finish through
StructuredOutput with a toolCall block for one of the supplied Pi tools; Pi will
execute it and send the result in the next request. Encode each tool's argument object
in the toolCall block's argumentsJson string. Never invent an unavailable tool. Return
only the structured response required by the supplied JSON schema.`;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const THINKING_LEVELS = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

export const CLAUDE_CODE_MODELS: readonly Model<typeof API_ID>[] = [
	{
		id: "default",
		name: "Claude Code (configured default)",
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: "cli://claude-code",
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "fable",
		name: "Claude Code Fable",
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: "cli://claude-code",
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "sonnet",
		name: "Claude Code Sonnet",
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: "cli://claude-code",
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "opus",
		name: "Claude Code Opus",
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: "cli://claude-code",
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

export type FailureReason =
	| "invalid-request"
	| "spawn-failed"
	| "cancelled"
	| "timeout"
	| "output-overflow"
	| "nonzero-exit"
	| "malformed-json"
	| "claude-error";

export interface ParsedClaudeResult {
	content: ({ type: "text"; text: string } | ToolCall)[];
	sessionId?: string;
	responseModel?: string;
	rawStopReason?: string;
	usage: Usage;
	isError: boolean;
	errorMessage?: string;
}

export interface RunOptions {
	modelId: string;
	payload: unknown;
	allowedToolNames: ReadonlySet<string>;
	toolChoice?: "auto" | "none";
	reasoning?: SimpleStreamOptions["reasoning"];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	executable?: string;
}

export type RunOutcome =
	| { ok: true; response: ParsedClaudeResult }
	| { ok: false; reason: FailureReason; message: string };

export interface ClaudeCodeRuntimeOptions {
	executable?: string;
	cwd?: string | (() => string);
}

interface Sink {
	chunks: Buffer[];
	bytes: number;
	overflowed: boolean;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsage(payload: Record<string, unknown>): Usage {
	const raw = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
		? (payload.usage as Record<string, unknown>)
		: {};
	const input = finiteNumber(raw.input_tokens ?? raw.inputTokens);
	const output = finiteNumber(raw.output_tokens ?? raw.outputTokens);
	const cacheRead = finiteNumber(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens);
	const cacheWrite = finiteNumber(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
	const totalCost = finiteNumber(payload.total_cost_usd ?? payload.totalCostUsd);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredContent(value: unknown, allowedToolNames: ReadonlySet<string>): ParsedClaudeResult["content"] {
	if (!isRecord(value) || !Array.isArray(value.content) || value.content.length === 0) {
		throw new Error('structured response must contain a non-empty "content" array');
	}
	return value.content.map((candidate, index) => {
		if (!isRecord(candidate)) throw new Error(`content[${index}] is not an object`);
		if (candidate.type === "text") {
			if (typeof candidate.text !== "string") throw new Error(`content[${index}].text is not a string`);
			return { type: "text" as const, text: candidate.text };
		}
		if (candidate.type === "toolCall") {
			if (typeof candidate.name !== "string" || !allowedToolNames.has(candidate.name)) {
				throw new Error(`content[${index}] requested unavailable tool ${JSON.stringify(candidate.name)}`);
			}
			let argumentsValue: unknown = candidate.arguments;
			if (typeof candidate.argumentsJson === "string") {
				try {
					argumentsValue = JSON.parse(candidate.argumentsJson);
				} catch {
					throw new Error(`content[${index}].argumentsJson is not valid JSON`);
				}
			}
			if (!isRecord(argumentsValue)) throw new Error(`content[${index}] tool arguments are not an object`);
			return {
				type: "toolCall" as const,
				id: typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : `claude-code:${randomUUID()}`,
				name: candidate.name,
				arguments: argumentsValue,
			};
		}
		throw new Error(`content[${index}] has unknown type ${JSON.stringify(candidate.type)}`);
	});
}

function parseLifecycleToolCalls(
	value: unknown,
	allowedToolNames: ReadonlySet<string>,
): ParsedClaudeResult["content"] | undefined {
	if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) {
		return undefined;
	}
	const calls: ToolCall[] = [];
	for (const block of value.message.content) {
		if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
		if (!allowedToolNames.has(block.name)) continue;
		if (!isRecord(block.input)) throw new Error(`Claude Code lifecycle tool ${JSON.stringify(block.name)} has invalid input`);
		calls.push({
			type: "toolCall",
			id: typeof block.id === "string" && block.id.length > 0 ? block.id : `claude-code:${randomUUID()}`,
			name: block.name,
			arguments: block.input,
		});
	}
	return calls.length > 0 ? calls : undefined;
}

export function parseClaudeJson(stdout: string, allowedToolNames: ReadonlySet<string> = new Set()): ParsedClaudeResult {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("Claude produced no output on stdout");
	let value: unknown;
	let attemptedPiToolCalls: ParsedClaudeResult["content"] | undefined;
	let sawUnavailableToolError = false;
	try {
		value = JSON.parse(trimmed);
	} catch {
		// stream-json emits one JSON object per line. Keep the last terminal result.
		// Claude can mistake serialized Pi tools for native Claude Code tools even
		// though the latter are disabled. Preserve its first intended Pi-tool batch
		// so the provider can relay it after the CLI reports that lookup failure.
		for (const line of trimmed.split(/\r?\n/)) {
			let candidate: unknown;
			try {
				candidate = JSON.parse(line);
			} catch {
				continue;
			}
			attemptedPiToolCalls ??= parseLifecycleToolCalls(candidate, allowedToolNames);
			if (/No such tool available/i.test(line)) sawUnavailableToolError = true;
			if (isRecord(candidate) && candidate.type === "result") value = candidate;
		}
	}
	if (!isRecord(value)) throw new Error("Claude output is not a JSON object");
	if (value.type !== undefined && value.type !== "result") throw new Error("Claude output has no terminal result object");

	let structured = value.structured_output;
	if (structured === undefined && typeof value.result === "string") {
		try {
			structured = JSON.parse(value.result);
		} catch {
			structured = undefined;
		}
	}
	let content: ParsedClaudeResult["content"];
	if (structured !== undefined) content = parseStructuredContent(structured, allowedToolNames);
	else if (typeof value.result === "string") content = [{ type: "text", text: value.result }];
	else throw new Error('Claude output has neither "structured_output" nor a string "result"');
	if (
		value.is_error !== true &&
		attemptedPiToolCalls !== undefined &&
		!content.some((block) => block.type === "toolCall") &&
		(sawUnavailableToolError || content.some((block) => block.type === "text" && /No such tool available/i.test(block.text)))
	) {
		content = attemptedPiToolCalls;
	}

	const modelUsage = isRecord(value.modelUsage) ? value.modelUsage : undefined;
	return {
		content,
		sessionId: typeof value.session_id === "string" ? value.session_id : undefined,
		responseModel: modelUsage ? Object.keys(modelUsage)[0] : undefined,
		rawStopReason: typeof value.stop_reason === "string"
			? value.stop_reason
			: (typeof value.stopReason === "string" ? value.stopReason : undefined),
		usage: parseUsage(value),
		isError: value.is_error === true,
		errorMessage: value.is_error === true && typeof value.result === "string" ? value.result : undefined,
	};
}

function responseSchema(toolNames: readonly string[], toolChoice: "auto" | "none" = "auto"): Record<string, unknown> {
	const text = {
		type: "object",
		properties: { type: { const: "text" }, text: { type: "string" } },
		required: ["type", "text"],
		additionalProperties: false,
	};
	const items: unknown[] = [text];
	if (toolChoice !== "none" && toolNames.length > 0) {
		items.push({
			type: "object",
			properties: {
				type: { const: "toolCall" },
				id: { type: "string" },
				name: { type: "string", enum: toolNames },
				argumentsJson: { type: "string" },
			},
			required: ["type", "name", "argumentsJson"],
			additionalProperties: false,
		});
	}
	return {
		type: "object",
		properties: { content: { type: "array", minItems: 1, items: { anyOf: items } } },
		required: ["content"],
		additionalProperties: false,
	};
}

export function buildArgs(options: {
	modelId: string;
	reasoning?: SimpleStreamOptions["reasoning"];
	toolNames?: readonly string[];
	toolChoice?: "auto" | "none";
}): string[] {
	if (!Object.hasOwn(MODEL_ALIASES, options.modelId)) throw new Error(`Unknown Claude Code model: ${options.modelId}`);
	const args = [
		"-p",
		"--verbose",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--no-session-persistence",
		"--safe-mode",
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--tools",
		"",
		"--system-prompt",
		PROVIDER_SYSTEM_PROMPT,
		"--json-schema",
		JSON.stringify(responseSchema(options.toolNames ?? [], options.toolChoice)),
	];
	const alias = MODEL_ALIASES[options.modelId];
	if (alias) args.push("--model", alias);
	if (options.reasoning) args.push("--effort", options.reasoning === "minimal" ? "low" : options.reasoning);
	return args;
}

export function resolveExecutable(): string {
	const configured = process.env.CLAUDE_CODE_EXECUTABLE;
	return typeof configured === "string" && configured.trim() ? configured.trim() : "claude";
}

export function serializeContext(context: Context, options?: SimpleStreamOptions): Record<string, unknown> {
	const canonicalContent = (content: unknown, includeToolCalls: boolean): unknown => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return [];
		return content.flatMap((block): Record<string, unknown>[] => {
			if (!isRecord(block)) return [];
			if (block.type === "text" && typeof block.text === "string") {
				return [{ type: "text", text: block.text }];
			}
			if (block.type === "image") {
				return [{ type: "text", text: "[Binary image omitted: Claude Code CLI provider is text-only.]" }];
			}
			if (includeToolCalls && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				return [{ type: "toolCall", id: block.id, name: block.name, arguments: isRecord(block.arguments) ? block.arguments : {} }];
			}
			// Thinking signatures and provider-specific blocks are intentionally not
			// forwarded across provider boundaries.
			return [];
		});
	};
	return {
		protocol: "pi-context-v1",
		systemPrompt: context.systemPrompt ?? "",
		messages: context.messages.map((message) => {
			if (message.role === "user") {
				return { role: "user", content: canonicalContent(message.content, false) };
			}
			if (message.role === "assistant") {
				return { role: "assistant", content: canonicalContent(message.content, true) };
			}
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: canonicalContent(message.content, false),
				isError: message.isError,
			};
		}),
		tools: (context.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
		options: {
			toolChoice: options?.toolChoice ?? "auto",
			maxTokens: options?.maxTokens,
			reasoning: options?.reasoning,
		},
	};
}

/** Encode Pi context as separate text blocks so unchanged history remains a cacheable prefix. */
export function encodeClaudeInput(payload: unknown): string {
	let values: unknown[];
	if (isRecord(payload) && payload.protocol === "pi-context-v1" && Array.isArray(payload.messages)) {
		values = [
			{ kind: "systemPrompt", value: payload.systemPrompt ?? "" },
			{ kind: "tools", value: payload.tools ?? [] },
			{ kind: "options", value: payload.options ?? {} },
			...payload.messages.map((message) => ({ kind: "message", value: message })),
		];
	} else {
		values = [{ kind: "payload", value: payload }];
	}
	const content = values.map((value) => {
		const text = JSON.stringify(value);
		if (text === undefined) throw new Error("Could not serialize Pi context");
		return { type: "text", text };
	});
	return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already exited.
		}
	}
}

function failure(reason: FailureReason, message: string): RunOutcome {
	return { ok: false, reason, message };
}

export async function runClaudeCode(options: RunOptions): Promise<RunOutcome> {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) {
		return failure("invalid-request", `Claude Code timeout must be between ${MIN_TIMEOUT_MS}ms and ${MAX_TIMEOUT_MS}ms`);
	}
	let input: string;
	try {
		input = encodeClaudeInput(options.payload);
	} catch (error) {
		return failure("invalid-request", `Could not serialize Pi context: ${describe(error)}`);
	}
	if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
		return failure(
			"invalid-request",
			`context_length_exceeded: serialized Pi context exceeds the ${MAX_INPUT_BYTES}-byte Claude Code provider limit`,
		);
	}

	let args: string[];
	try {
		args = buildArgs({
			modelId: options.modelId,
			reasoning: options.reasoning,
			toolNames: [...options.allowedToolNames],
			toolChoice: options.toolChoice,
		});
	} catch (error) {
		return failure("invalid-request", describe(error));
	}
	const executable = options.executable ?? resolveExecutable();
	const label = basename(executable);
	let child: ChildProcess;
	try {
		child = spawn(executable, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				// `claude -p` otherwise sends the complete prompt to a second model
				// request just to generate a session title. This provider never uses
				// Claude's session UI, so keep that request and other background traffic off.
				CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				// Request Claude Code's minimal system prompt. Its SDK identity/billing
				// markers remain, and Fable may append a reporting-accuracy rule.
				CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "1",
			},
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "spawn failed";
		return failure("spawn-failed", `Claude Code could not start ${JSON.stringify(label)} (${code})`);
	}
	// Attach process listeners immediately so an ENOENT event is observed and a
	// very fast child exit cannot be missed.
	const spawned = new Promise<boolean>((resolve) => {
		child.once("spawn", () => resolve(true));
		child.once("error", () => resolve(false));
	});
	const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: unknown }>(
		(resolve) => {
			child.once("error", (error) => resolve({ code: null, signal: null, error }));
			child.once("close", (code, signal) => resolve({ code, signal }));
		},
	);

	const stdout: Sink = { chunks: [], bytes: 0, overflowed: false };
	const stderr: Sink = { chunks: [], bytes: 0, overflowed: false };
	let cancelled = false;
	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const terminate = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		signalGroup(child, "SIGTERM");
		if (killTimer) return;
		killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
		killTimer.unref();
	};
	const collect = (source: NodeJS.ReadableStream | null, sink: Sink) => {
		source?.on("data", (chunk: Buffer) => {
			if (sink.overflowed) return;
			if (sink.bytes + chunk.length > MAX_OUTPUT_BYTES) {
				sink.overflowed = true;
				sink.chunks = [];
				sink.bytes = 0;
				terminate();
				return;
			}
			sink.chunks.push(chunk);
			sink.bytes += chunk.length;
		});
		source?.on("error", () => {});
	};
	collect(child.stdout, stdout);
	collect(child.stderr, stderr);
	child.stdin?.on("error", () => {});

	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, options.timeoutMs);
	timeout.unref();
	const onAbort = () => {
		cancelled = true;
		terminate();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });

	const didSpawn = await spawned;
	if (didSpawn && !cancelled) child.stdin?.end(input);
	else child.stdin?.end();

	const closed = await closedPromise;
	clearTimeout(timeout);
	if (killTimer) clearTimeout(killTimer);
	options.signal?.removeEventListener("abort", onAbort);

	if (closed.error) {
		const code = (closed.error as NodeJS.ErrnoException).code ?? "spawn failed";
		return failure("spawn-failed", `Claude Code could not start ${JSON.stringify(label)} (${code})`);
	}
	if (cancelled) return failure("cancelled", "Claude Code request was aborted");
	if (timedOut) return failure("timeout", `Claude Code request timed out after ${options.timeoutMs}ms`);
	if (stdout.overflowed || stderr.overflowed) {
		return failure("output-overflow", `Claude Code exceeded the ${MAX_OUTPUT_BYTES}-byte ${stdout.overflowed ? "stdout" : "stderr"} limit`);
	}
	const stdoutText = Buffer.concat(stdout.chunks).toString("utf8");
	const stderrText = Buffer.concat(stderr.chunks).toString("utf8");
	let response: ParsedClaudeResult | undefined;
	let parseError: unknown;
	try {
		response = parseClaudeJson(stdoutText, options.allowedToolNames);
	} catch (error) {
		parseError = error;
	}
	const overflowEvidence = response?.errorMessage ?? (closed.code !== 0 ? `${stdoutText}\n${stderrText}` : "");
	if (isContextOverflow(overflowEvidence)) {
		return failure(
			"claude-error",
			"context_length_exceeded: Claude Code rejected the serialized Pi conversation because it exceeds the model context window",
		);
	}
	if (closed.code !== 0) {
		if (response?.isError) return failure("claude-error", response.errorMessage || "Claude Code reported an error");
		const how = closed.code === null ? `was killed by ${closed.signal ?? "an unknown signal"}` : `exited with code ${closed.code}`;
		return failure("nonzero-exit", `${label} ${how}; run Claude Code directly for diagnostics`);
	}
	if (!response) return failure("malformed-json", `Could not parse Claude Code response: ${describe(parseError)}`);
	if (response.isError) return failure("claude-error", response.errorMessage || "Claude Code reported an error");
	return { ok: true, response };
}

function isContextOverflow(message: string): boolean {
	return /context_length_exceeded|prompt is too long|context (?:window|length).*(?:exceed|overflow|too (?:large|long))|(?:input|prompt).*(?:exceeds?|exceeded).*(?:context|token limit|maximum)/i.test(message);
}

function initialMessage(model: Model<typeof API_ID>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function resolveCwd(runtime: ClaudeCodeRuntimeOptions): string {
	return typeof runtime.cwd === "function" ? runtime.cwd() : (runtime.cwd ?? process.cwd());
}

export function streamClaudeCode(
	model: Model<typeof API_ID>,
	context: Context,
	options?: SimpleStreamOptions,
	runtime: ClaudeCodeRuntimeOptions = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = initialMessage(model);
	queueMicrotask(() => {
		void (async () => {
			stream.push({ type: "start", partial: output });
			try {
				let payload: unknown = serializeContext(context, options);
				const replacement = await options?.onPayload?.(payload, model);
				if (replacement !== undefined) payload = replacement;
				const allowedToolNames = new Set(
					options?.toolChoice === "none" ? [] : (context.tools ?? []).map((tool) => tool.name),
				);
				const outcome = await runClaudeCode({
					modelId: model.id,
					payload,
					allowedToolNames,
					toolChoice: options?.toolChoice,
					reasoning: options?.reasoning,
					cwd: resolveCwd(runtime),
					timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					signal: options?.signal,
					executable: runtime.executable,
				});
				if (!outcome.ok) throw new Error(outcome.message);

				for (const block of outcome.response.content) {
					const contentIndex = output.content.length;
					if (block.type === "text") {
						output.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex, partial: output });
						(output.content[contentIndex] as { type: "text"; text: string }).text = block.text;
						stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
						stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					} else {
						output.content.push({ type: "toolCall", id: block.id, name: block.name, arguments: {} });
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						const delta = JSON.stringify(block.arguments);
						stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
						(output.content[contentIndex] as ToolCall).arguments = block.arguments;
						stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
					}
				}
				output.usage = outcome.response.usage;
				output.responseId = outcome.response.sessionId;
				output.responseModel = outcome.response.responseModel;
				output.rawStopReason = outcome.response.rawStopReason;
				output.stopReason = outcome.response.rawStopReason === "max_tokens" || outcome.response.rawStopReason === "length"
					? "length"
					: (output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end(output);
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = describe(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			}
		})();
	});
	return stream;
}

export function createClaudeCodeProvider(runtime: ClaudeCodeRuntimeOptions = {}): Provider<typeof API_ID> {
	const stream = (model: Model<typeof API_ID>, context: Context, options?: SimpleStreamOptions) =>
		streamClaudeCode(model, context, options, runtime);
	return createProvider({
		id: PROVIDER_ID,
		name: "Claude Code CLI",
		baseUrl: "cli://claude-code",
		auth: {
			apiKey: {
				name: "Claude Code CLI login",
				check: async ({ signal }) => {
					signal.throwIfAborted();
					return { type: "api_key", source: "Claude Code CLI login" };
				},
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: {}, source: "Claude Code CLI login" };
				},
			},
		},
		models: CLAUDE_CODE_MODELS,
		api: { stream, streamSimple: stream },
	});
}

export default function claudeCodeExtension(pi: ExtensionAPI): void {
	let cwd = process.cwd();
	pi.on("session_start", (_event, context) => {
		cwd = context.cwd;
	});
	pi.registerProvider(createClaudeCodeProvider({ cwd: () => cwd }));
}
