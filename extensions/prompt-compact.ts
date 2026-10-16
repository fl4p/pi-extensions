/**
 * prompt-compact
 *
 * Opt-in (PI_PROMPT_COMPACT=1) rewrite of the parts of pi's base system prompt
 * that repeat what the model already gets elsewhere:
 *
 * - "Available tools:" — one-line summaries of tools whose full definitions are
 *   already in the request. Dropped.
 * - "Guidelines:" — extensions contribute overlapping lines (seven about
 *   memory/scratchpad/harness_feedback, four about edit, six about
 *   bash_background/monitor, some of which never name their tool). Known lines
 *   are merged by exact text; anything unrecognised passes through unchanged.
 * - "Pi documentation" — nine lines of doc routing, shrunk to one with the
 *   same paths.
 *
 * Measured with a local 30B model in mind, where every prompt token is paid on
 * each cold prefill. The rewrite is deterministic, so the prompt prefix stays
 * stable across turns and prompt caches keep working.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROMPT_COMPACT_ENV = "PI_PROMPT_COMPACT";

const TOOLS_START = "\nAvailable tools:\n";
const TOOLS_END = "\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n";

type MergeGroup = { members: readonly string[]; text: string };

// A group is merged only when every member is present, so a merged line never
// mentions a tool that is not loaded. The merged text takes the position of
// the group's first member.
export const MERGE_GROUPS: readonly MergeGroup[] = [
	{
		members: [
			'For bash timeouts, use a unit-bearing string such as "180s", "3m", or "500ms"; never use a bare number.',
			'Always give bash_background a unit-bearing timeout such as "30m" or "2h"; bare numbers are invalid.',
		],
		text: 'bash and bash_background timeouts need units ("180s", "30m"); never a bare number.',
	},
	{
		members: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		text: "edit: each edits[].oldText must match the original file exactly and uniquely, as small as possible; put all changes to one file in one call, with no overlapping edits.",
	},
	{
		members: [
			"After making code changes with edit or write, use lsp_diagnostics to check for compilation errors before moving on.",
			'To review all workspace diagnostics at once, call lsp_diagnostics with path="*" — this returns all cached diagnostics from running LSP servers without needing to check files individually.',
		],
		text: 'After edit or write, check lsp_diagnostics before moving on (path="*" for the whole workspace).',
	},
	{
		members: [
			"Finite jobs only (wakes once on exit or timeout). For file/stream watching use `monitor` (wakes on new output).",
			"Don't sleep-and-poll the logfile to await completion — the exit wake is automatic; Read it anytime for progress.",
			"Stop with background_stop({id}); list with background_list().",
			'A monitor only wakes on output, so a filter that never matches looks exactly like a quiet run. You get one warning after 10m of silence; tune with silenceWarning ("5m", or "off").',
			"For streaming output (dev server, tail -F, logs). Use bash_background for finite jobs (wakes once on exit).",
			"Delivered in batches and capped per batch — Read the logpath for the complete stream.",
		],
		text: 'bash_background runs a finite job and wakes you once on exit, so never sleep-and-poll. monitor streams output and wakes on new lines; a filter that never matches looks like silence (one warning after 10m, tune with silenceWarning). Read the logpath for the full output. Stop or list with background_stop / background_list.',
	},
	{
		members: [
			"For web lookups, prefer google_search (raw Google results via Serper) as the default. Use web_search only when the user explicitly wants a synthesized answer or multi-source narrative.",
		],
		text: "Prefer google_search for web lookups; web_search only when the user wants a synthesized answer.",
	},
	{
		members: [
			"Use scratchpad_update for temporary plans, open questions, and todos within the current session.",
			"Use memory_save instead for durable facts that should be recalled in future sessions.",
			"Use memory_save only for durable facts that should help future conversations.",
			"Use memory_search or memory_list before memory_save to avoid duplicates.",
			"Set review=true with confidence, evidence, and review_reason when a candidate is low-confidence, inferred, correction-like, or potentially duplicate.",
			"Use harness_feedback instead of memory_save for feedback about agent behavior, tool efficiency, skills, or harness configuration.",
			"Use harness_feedback instead of memory_save for observations about the agent, tools, skills, prompts, or harness behavior.",
		],
		text: "Session plans, questions and todos: scratchpad_update. Durable facts: memory_save, after memory_search or memory_list; set review=true (with confidence, evidence, review_reason) for low-confidence, inferred, correction-like or possible-duplicate candidates. Observations about the agent, tools, skills, prompts or harness: harness_feedback, not memory.",
	},
];

export function compactGuidelines(lines: readonly string[]): string[] {
	const present = new Set(lines);
	const owner = new Map<string, MergeGroup>();
	for (const group of MERGE_GROUPS) {
		if (group.members.every((m) => present.has(m))) for (const m of group.members) owner.set(m, group);
	}
	const out: string[] = [];
	const emitted = new Set<MergeGroup>();
	for (const line of lines) {
		const group = owner.get(line);
		if (!group) out.push(line);
		else if (!emitted.has(group)) {
			emitted.add(group);
			out.push(group.text);
		}
	}
	return out;
}

const DOCS_RE =
	/\nPi documentation \(read only when[^\n]*\n- Main documentation: ([^\n]+)\n- Additional docs: ([^\n]+)\n- Examples: (\S+)[^\n]*\n(?:- [^\n]*\n?)*/;

/** Pure. Returns the prompt unchanged when its sections are not in the expected shape. */
export function compactSystemPrompt(prompt: string): string {
	let out = prompt;

	const start = out.indexOf(TOOLS_START);
	const end = start >= 0 ? out.indexOf(TOOLS_END, start) : -1;
	if (start >= 0 && end > start) out = out.slice(0, start) + out.slice(end + TOOLS_END.length);

	const gStart = out.indexOf("\nGuidelines:\n");
	if (gStart >= 0) {
		const bodyStart = gStart + "\nGuidelines:\n".length;
		let bodyEnd = bodyStart;
		const lines: string[] = [];
		while (out.startsWith("- ", bodyEnd)) {
			const nl = out.indexOf("\n", bodyEnd);
			const stop = nl < 0 ? out.length : nl;
			lines.push(out.slice(bodyEnd + 2, stop));
			bodyEnd = nl < 0 ? out.length : nl + 1;
		}
		if (lines.length > 0) {
			const body = compactGuidelines(lines).map((l) => `- ${l}\n`).join("");
			out = out.slice(0, bodyStart) + body + out.slice(bodyEnd);
		}
	}

	out = out.replace(
		DOCS_RE,
		(_m, readme: string, docs: string, examples: string) =>
			`\nPi docs, only for questions about pi itself (SDK, extensions, skills, TUI): README ${readme}, docs ${docs}, examples ${examples}. Read them fully and follow .md links before implementing.\n`,
	);

	return out;
}

export function promptCompactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PROMPT_COMPACT_ENV] === "1";
}

export default function promptCompact(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (!promptCompactEnabled()) return;
		const compacted = compactSystemPrompt(event.systemPrompt);
		if (compacted !== event.systemPrompt) return { systemPrompt: compacted };
	});
}
