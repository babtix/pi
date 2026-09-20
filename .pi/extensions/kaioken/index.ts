import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools/index.ts";

export default function (pi: ExtensionAPI) {
	registerTools(pi);
	pi.on("session_start", async (_e, ctx) => {
		ctx.ui.setStatus("kaioken", "grounded v0.3");
	});
}
