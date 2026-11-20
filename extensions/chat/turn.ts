/**
 * The line under a finished turn, `✻ Worked for 7s · done 4:19 PM`, with the background jobs that are
 * still running added: `· 2 background jobs · ↓ to manage`. With no turn line yet it stands alone.
 */
export function withBackground(turnLine: string | undefined, running: number): string | undefined {
	if (running <= 0) return turnLine;
	const jobs = `${running} background ${running === 1 ? "job" : "jobs"} · ↓ to manage`;
	return turnLine ? `${turnLine} · ${jobs}` : `✻ ${jobs}`;
}
