import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkDrift } from "../../../../kaioken/provenance/src/status.ts";
import { GROUNDING_RULES } from "../prompts/grounding.ts";

/**
 * Commands that destroy work irreversibly.
 *
 * This guard polices both `bash` and `powershell`, so it has to know both
 * vocabularies. It originally listed only Unix spellings (`rm -rf`, `drop
 * table`), which meant the destructive PowerShell idioms it claimed to cover
 * passed straight through — the hook named a shell it could not actually read.
 *
 * The flag groups are written loosely because `rm -rf`, `rm -fr`, `rm -r -f`
 * and `rm --recursive --force` are the same command. Anything that only
 * rewrites a file in place is deliberately absent: over-blocking trains people
 * to route around the guard, which is worse than the gap.
 */
const DESTRUCTIVE = [
	// Unix recursive force delete, in any flag spelling.
	/\brm\s+(?:-[a-z]*r[a-z]*\s+-[a-z]*f|-[a-z]*f[a-z]*\s+-[a-z]*r|--recursive[\s\S]*--force|--force[\s\S]*--recursive|-r[fF]|-f[rR])/i,
	// PowerShell recursive force delete, including the `ri`/`del` aliases.
	// No `\b` before the hyphenated flags: a word boundary needs a word/non-word
	// transition, and the space before `-Recurse` is not one, so `\b-recurse`
	// can never match. That single character is why `Remove-Item -Recurse
	// -Force` slipped through a guard that explicitly named powershell.
	/\b(?:remove-item|ri|del)\b[\s\S]*-recurse\b[\s\S]*-force\b/i,
	/\b(?:remove-item|ri|del)\b[\s\S]*-force\b[\s\S]*-recurse\b/i,
	// cmd.exe recursive quiet delete.
	/\bdel\s+[\s\S]*\/[sq]\b/i,
	// Disk-level destruction.
	/\b(?:format-volume|clear-disk|diskpart)\b/i,
	// History rewrites and discarding uncommitted work.
	/\bgit\s+push\b[\s\S]*--force(?!-with-lease)/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\b[\s\S]*\s-[a-z]*[fdx]/i,
	// Data loss.
	/\bdrop\s+(?:table|database|schema)\b/i,
	/\btruncate\s+table\b/i,
];

export function isDestructive(command: string): boolean {
	return DESTRUCTIVE.some((pattern) => pattern.test(command));
}

let dirty = false;
export const setDirty = (v: boolean) => {
	dirty = v;
};
export const isDirty = () => dirty;

export function registerHooks(
	pi: ExtensionAPI,
	root: () => string,
	badge: (s: string) => void,
	onContext?: (ctx: ExtensionContext) => void,
) {
	pi.on("before_agent_start", async (event) => {
		const drift = await checkDrift(root()).catch(() => null);
		const head = drift?.stale?.length
			? `DRIFT REPORT: ${drift.stale.length} stale doc(s): ${drift.stale
					.map((d) => d.document)
					.slice(0, 5)
					.join(", ")}\n`
			: "";
		return { systemPrompt: `${event.systemPrompt}\n\n${head}${GROUNDING_RULES}` };
	});

	pi.on("session_start", async (_e, ctx) => {
		onContext?.(ctx);
		badge("grounded · flash-high");
		ctx.ui.setWidget?.("kaioken", ["kaioken: grounded", "model: gemini-3.8-flash-high"]);
	});

	pi.on("tool_call", async (event, ctx) => {
		onContext?.(ctx);
		if (event.toolName === "edit" || event.toolName === "write") {
			setDirty(true);
			badge("UNVERIFIED CHANGES");
		}
		if (
			(event.toolName === "bash" || event.toolName === "powershell") &&
			isDestructive(String((event.input as any)?.command ?? ""))
		) {
			return { block: true, reason: "Kaioken policy: destructive operation blocked" };
		}
	});
}
