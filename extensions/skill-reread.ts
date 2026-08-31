/**
 * skill-reread — re-anchor skill knowledge after compaction.
 *
 * Problem: pi loads skill bodies (SKILL.md and its reference files) as ordinary
 * `read` tool results or `/skill:` expansions, so compaction summarizes them
 * away. Long agentic sessions then operate on summarized memory of API names /
 * CLI flags and regress into guess-loops (observed: 6 consecutive invented
 * pcbnew attributes in the qwen3p8-max inverter run, all post-compaction,
 * ~45 min lost).
 *
 * Fix: on each compaction, scan the active session branch for skill files that
 * entered context — successful `read` tool calls on paths under a skills
 * directory, and `/skill:name` expansions (whose `<skill ... location="...">`
 * header carries the exact path wherever the skill lives) — and inject a
 * context-visible reminder to re-read them before relying on any interface
 * they document. For non-retry compactions the message is appended without
 * continuing the agent run; overflow-retry compactions deliver it with the
 * retried turn.
 *
 * Known limitation: skill files read via bash (`cat`/`grep`/`sed`) are not
 * tracked.
 *
 * NOTE for benchmarking: this actively helps the model. Record its presence as
 * part of the harness condition.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SKILL_LOCATION_RE = /<skill name="[^"]*" location="([^"]+)"/g;

function isSkillPath(path: unknown): path is string {
	if (typeof path !== "string") return false;
	const normalized = path.replace(/\\/g, "/");
	return normalized.includes("skills/");
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
			out += `${(block as { text: unknown }).text}\n`;
		}
	}
	return out;
}

/** Collect skill files that entered context on the active branch. */
export function collectSkillFiles(ctx: ExtensionContext): string[] {
	const files = new Set<string>();
	let entries: unknown[];
	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		return [];
	}
	// read tool calls awaiting a successful result: toolCallId -> path
	const pending = new Map<string, string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as { type?: string; message?: Record<string, unknown> };
		if (e.type !== "message" || !e.message) continue;
		const msg = e.message;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { type?: string }).type === "toolCall" &&
					(block as { name?: string }).name === "read"
				) {
					const b = block as { id?: string; arguments?: { path?: unknown } };
					if (b.arguments && isSkillPath(b.arguments.path)) {
						pending.set(b.id ?? "", b.arguments.path);
					}
				}
			}
		} else if (msg.role === "toolResult") {
			const r = msg as { toolCallId?: string; isError?: boolean };
			const path = r.toolCallId === undefined ? undefined : pending.get(r.toolCallId);
			if (path !== undefined && r.isError !== true) files.add(path);
		} else if (msg.role === "user" || msg.role === "custom") {
			// /skill:name expansions embed <skill name="..." location="/abs/path">.
			const text = textOfContent(msg.content);
			for (const match of text.matchAll(SKILL_LOCATION_RE)) {
				files.add(match[1]);
			}
		}
	}
	return [...files].sort();
}

export default function skillReread(pi: ExtensionAPI) {
	pi.on("session_compact", async (event, ctx) => {
		const files = collectSkillFiles(ctx);
		if (files.length === 0) return;
		pi.sendMessage(
			{
				customType: "skill-reread-reminder",
				content:
					"Context was just compacted. Skill/reference files loaded earlier may no longer be " +
					"in context, and summarized memory of API names, CLI flags, and procedural rules from " +
					"them is unreliable — that is exactly how invented-interface guess-loops start. Before " +
					"the next use of any tool or API they cover, re-read the relevant file(s):\n" +
					files.map((f) => `- ${f}`).join("\n"),
				display: true,
			},
			// A steer during a non-retry (threshold/manual) compaction would make pi
			// continue the finished run just to deliver it — an unsolicited model call.
			// Append it turn-neutrally instead; overflow retries already continue, so
			// steering there rides the existing retry.
			event.willRetry ? { deliverAs: "steer" } : { deliverAs: "steer", triggerTurn: false },
		);
	});
}
