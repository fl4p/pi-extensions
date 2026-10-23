/**
 * hide-tools — keep named tools out of the model's tool list.
 *
 * Packages register tools the model almost never needs. pi-memory's ten store
 * maintenance tools (memory_status, memory_check, memory_repair, memory_refresh,
 * memory_dream, memory_review, memory_maintain, memory_list, memory_why,
 * memory_recall_feedback) cost 1,322 tokens on every request and were called 74
 * times in all of the Mac's pi history (measured 2026-10-23, see
 * local-inference/pi-memory-cost.md). The same operations exist as /memory-*
 * commands, which do not go through the tools.
 *
 * The tools are deactivated with pi.setActiveTools, not stripped from the
 * payload, so pi also drops their prompt lines and refuses a call to one. The
 * list is re-applied before every agent turn, in case another extension
 * changed the active set; pi applies it only when something actually changes.
 *
 * PI_HIDE_TOOLS=<comma-separated names> sets the list. Unset or empty hides
 * nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HIDE_TOOLS_ENV = "PI_HIDE_TOOLS";

export function hiddenTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
	return new Set(
		(env[HIDE_TOOLS_ENV] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/** Pure. The active set without hidden tools, or undefined when nothing changes. */
export function withoutHidden(active: readonly string[], hidden: ReadonlySet<string>): string[] | undefined {
	const kept = active.filter((name) => !hidden.has(name));
	return kept.length === active.length ? undefined : kept;
}

export default function hideTools(pi: ExtensionAPI) {
	const apply = () => {
		const hidden = hiddenTools();
		if (hidden.size === 0) return;
		const next = withoutHidden(pi.getActiveTools(), hidden);
		if (next) pi.setActiveTools(next);
	};
	pi.on("session_start", apply);
	pi.on("before_agent_start", () => {
		apply();
		return undefined;
	});
}
