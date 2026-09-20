/**
 * Temporary probe: what can an extension actually reach in Pi's render tree?
 *
 * Written to a file rather than stdout so it survives the -p session, and
 * deleted once the answer is known. The question it answers is whether the
 * header can be lifted out of the scroll region: that needs a reference to the
 * layout root's children, and guessing at Pi's internals without checking is
 * how an extension ends up breaking on the next release.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const tui = (ctx as unknown as { tui?: any }).tui;
		const lines: string[] = [];
		const describe = (value: unknown, depth = 0, label = "root"): void => {
			if (depth > 4) return;
			const node = value as any;
			if (!node) {
				lines.push(`${"  ".repeat(depth)}${label}: ${String(node)}`);
				return;
			}
			const name = node.constructor?.name ?? typeof node;
			const kids = Array.isArray(node.children) ? node.children.length : 0;
			const keys = Object.keys(node).filter((k) => k !== "children").slice(0, 14);
			lines.push(`${"  ".repeat(depth)}${label}: ${name} children=${kids} keys=[${keys.join(",")}]`);
			if (Array.isArray(node.children)) {
				for (let i = 0; i < Math.min(4, node.children.length); i++) {
					describe(node.children[i], depth + 1, `child[${i}]`);
				}
			}
		};

		lines.push(`ctx keys: ${Object.keys(ctx as object).join(", ")}`);
		lines.push(`ctx.mode: ${ctx.mode}`);
		lines.push(`tui present: ${Boolean(tui)}`);
		describe(tui, 0, "tui");
		lines.push(`has setLayoutRoot: ${typeof tui?.setLayoutRoot === "function"}`);
		lines.push(`has getMountedRoots: ${typeof tui?.getMountedRoots === "function"}`);
		lines.push(`own props: ${Object.getOwnPropertyNames(tui ?? {}).join(", ")}`);

		// The layout root is private; this asks whether it is reachable at all.
		const proto = Object.getPrototypeOf(tui ?? {});
		lines.push(`proto props: ${Object.getOwnPropertyNames(proto ?? {}).join(", ")}`);

		writeFileSync("probe-tui-structure.txt", lines.join("\n"), "utf8");
	});

	// The header factory is the other place a TUI is handed over.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((tui, _theme) => {
			const lines = [
				`header-factory tui: ${tui.constructor?.name}`,
				`children: ${tui.children?.length}`,
				`child names: ${(tui.children ?? []).map((c: any) => c.constructor?.name).join(", ")}`,
				`has setLayoutRoot: ${typeof (tui as any).setLayoutRoot === "function"}`,
				`own props: ${Object.getOwnPropertyNames(tui).join(", ")}`,
				`proto props: ${Object.getOwnPropertyNames(Object.getPrototypeOf(tui)).join(", ")}`,
			];
			writeFileSync("probe-header-factory.txt", lines.join("\n"), "utf8");
			return { render: () => [], invalidate: () => {} };
		});
	});
}
