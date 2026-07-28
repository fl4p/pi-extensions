import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export default function (pi: ExtensionAPI) {
	let start = 0;

	pi.on("agent_start", async (_event, ctx) => {
		start = Date.now();
		ctx.ui.setStatus("turn-timer", undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (start === 0) return;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("turn-timer", theme.fg("dim", `⏱ ${formatDuration(Date.now() - start)}`));
	});
}
