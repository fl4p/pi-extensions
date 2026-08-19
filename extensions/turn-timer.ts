import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	const roundedSeconds = Math.round(seconds);
	if (roundedSeconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(roundedSeconds / 60)}m${roundedSeconds % 60}s`;
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
