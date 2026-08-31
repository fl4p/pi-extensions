/**
 * skill-reread — re-anchor skill knowledge after compaction.
 *
 * Problem: pi loads skill bodies (SKILL.md and its reference files) as ordinary
 * `read` tool results, so compaction summarizes them away. Long agentic sessions
 * then operate on summarized memory of API names / CLI flags and regress into
 * guess-loops (observed: 6 consecutive invented pcbnew attributes in the
 * qwen3p8-max inverter run, all post-compaction, ~45 min lost).
 *
 * Fix: track which skill/reference files were read this session (including
 * before a resume, by scanning session history) and, right after each
 * compaction, inject a context-visible reminder listing them, instructing the
 * agent to re-read before relying on any interface they document.
 *
 * NOTE for benchmarking: this actively helps the model. Record its presence as
 * part of the harness condition.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SKILL_PATH_MARKERS = ["/skills/", "/.claude/skills/", "/.pi/agent/skills/"];

function isSkillFile(path: unknown): path is string {
	return typeof path === "string" && SKILL_PATH_MARKERS.some((m) => path.includes(m));
}

export default function skillReread(pi: ExtensionAPI) {
	const skillReads = new Set<string>();

	function harvestFromSession(ctx: ExtensionContext) {
		// Seed from history so resumed sessions know what was read before restart.
		try {
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
				for (const block of msg.content) {
					if (
						typeof block === "object" &&
						block !== null &&
						"name" in block &&
						block.name === "read" &&
						"arguments" in block
					) {
						const args = block.arguments as { path?: unknown } | undefined;
						if (args && isSkillFile(args.path)) skillReads.add(args.path);
					}
				}
			}
		} catch {
			// Harvesting is best-effort; live tracking still works.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		harvestFromSession(ctx);
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "read") {
			const path = (event.input as { path?: unknown })?.path;
			if (isSkillFile(path)) skillReads.add(path);
		}
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (skillReads.size === 0) return;
		const files = [...skillReads].sort();
		pi.sendMessage(
			{
				customType: "skill-reread-reminder",
				content:
					"Context was just compacted. The skill/reference files you loaded earlier are no longer " +
					"in context, and summarized memory of API names, CLI flags, and procedural rules from them " +
					"is unreliable — that is exactly how invented-interface guess-loops start. Before the next " +
					"use of any tool or API they cover, re-read the relevant file(s):\n" +
					files.map((f) => `- ${f}`).join("\n"),
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});
}
