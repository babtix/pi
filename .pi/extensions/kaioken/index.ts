import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "kaioken_status",
		label: "Kaioken Status",
		description: "Offline drift check: stale vs current docs. 0 tokens.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "bridge alive (core lands in Phase 2)" }], details: {} };
		},
	});
	pi.on("session_start", async (_e, ctx) => {
		ctx.ui.setStatus("kaioken", "bridge v0.1");
	});
}
