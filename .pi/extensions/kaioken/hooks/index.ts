import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkDrift } from "../../../../kaioken/provenance/src/status.ts";
import { GROUNDING_RULES } from "../prompts/grounding.ts";

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
			/rm\s+-rf|git\s+push\s+.*--force|drop\s+table/i.test(String((event.input as any)?.command ?? ""))
		) {
			return { block: true, reason: "Kaioken policy: destructive operation blocked" };
		}
	});
}
