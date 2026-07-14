/**
 * block-web-search
 *
 * Removes `web_search` (Gemini-synthesis provider) from the active tool set
 * at session start, forcing the agent to use `google_search` (raw Google blue
 * links via Serper) + `ctx_fetch_and_index` / `fetch_content` for primary
 * sources instead.
 *
 * Motivation: web_search returns an AI-synthesized answer that smooths sources
 * of different ages and quality into one confident paragraph — bad for any
 * quantitative work where provenance and freshness matter. google_search
 * gives raw links with snippets; you (or the agent) judge and fetch primaries.
 *
 * This is a hard block at the tool layer: the tool is removed from the active
 * set before the agent sees it, so it cannot be called at all. The CLI alias
 * `pi -xt web_search` does the same thing ad-hoc; this extension makes it
 * permanent for every session that loads it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED = ["web_search"];

export default function blockWebSearch(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !BLOCKED.includes(name));
		if (filtered.length !== active.length) {
			pi.setActiveTools(filtered);
		}
	});
}
