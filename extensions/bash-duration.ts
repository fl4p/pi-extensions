import { Text } from "@earendil-works/pi-tui";
import { createBashToolDefinition, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_TIMEOUT_SECONDS = 60 * 60;
const DURATION_PATTERN = "^[0-9]+(?:\\.[0-9]+)?(?:ms|s|m|h)$";
const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/;
const SECONDS_PER_UNIT = {
	ms: 1 / 1000,
	s: 1,
	m: 60,
	h: 60 * 60,
} as const;

export function parseDurationSeconds(duration: string): number {
	const match = DURATION_RE.exec(duration);
	if (!match) {
		throw new Error('Invalid timeout: use an explicit duration such as "180s", "3m", or "500ms"');
	}

	const seconds = Number(match[1]) * SECONDS_PER_UNIT[match[2] as keyof typeof SECONDS_PER_UNIT];
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error("Invalid timeout: duration must be greater than zero");
	}
	if (seconds > MAX_TIMEOUT_SECONDS) {
		throw new Error('Invalid timeout: foreground bash is limited to 1h; use "bash_background" for longer jobs');
	}
	return seconds;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.String({
			pattern: DURATION_PATTERN,
			description: 'Unit-bearing timeout such as "180s", "3m", or "500ms" (optional, maximum 1h)',
		}),
	),
});

export default function (pi: ExtensionAPI) {
	const bash = defineTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. " +
			"Output is truncated to the last 2000 lines or 50KB. Use an optional unit-bearing timeout " +
			'such as "180s" or "3m"; bare numeric timeouts are invalid.',
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			'For bash timeouts, use a unit-bearing string such as "180s", "3m", or "500ms"; never use a bare number.',
		],
		parameters: bashSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const timeout = params.timeout === undefined ? undefined : parseDurationSeconds(params.timeout);
			const tool = createBashToolDefinition(ctx.cwd);
			return tool.execute(toolCallId, { command: params.command, timeout }, signal, onUpdate, ctx);
		},

		renderCall(args, theme, context) {
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const timeout = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout})`) : "";
			text.setText(theme.fg("toolTitle", theme.bold(`$ ${args.command || "..."}`)) + timeout);
			return text;
		},
	});
	pi.registerTool(bash);
}
