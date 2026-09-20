import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorktree, ffMerge, slug, worktreePath } from "../../../../kaioken/gitops/src/worktree.ts";
import { runVerify } from "../../../../kaioken/verify/src/gate.ts";

function resolveRoot(rootFn?: () => string, ctx?: ExtensionContext): string {
	if (ctx?.cwd) return ctx.cwd;
	if (rootFn) return rootFn();
	return process.cwd();
}

export function registerCommands(pi: ExtensionAPI, root?: () => string) {
	pi.registerCommand("kaioken-delegate", {
		description: "Isolate task in a git worktree",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const taskSlug = slug(args || "task");
			try {
				const wt = await createWorktree(r, taskSlug);
				ctx.ui.notify(
					`worktree: ${wt}\nrun: cd ${wt} && pi --model antigravity/gemini-3.8-flash-high\nmerge: /kaioken-merge ${taskSlug}`,
				);
			} catch (e: any) {
				ctx.ui.notify(`Failed to create worktree: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("kaioken-merge", {
		description: "Verify worktree then ff-merge",
		handler: async (args, ctx) => {
			const r = resolveRoot(root, ctx);
			const taskSlug = slug(args || "task");
			const wt = worktreePath(r, taskSlug);
			const verification = await runVerify(wt);
			if (!verification.pass) {
				return ctx.ui.notify(`VERIFY FAIL in ${wt} — not merging\n${verification.summary}`, "error");
			}
			const res = await ffMerge(r, taskSlug);
			if (!res.success) {
				return ctx.ui.notify(`Merge failed: ${res.message}`, "error");
			}
			ctx.ui.notify(`merged ${taskSlug} ✓`);
		},
	});
}
