import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git } from "./run.ts";

export function slug(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "task"
	);
}

export function worktreePath(root: string, name: string): string {
	const s = slug(name);
	return resolve(join(root, ".kaioken", "worktrees", s));
}

export async function createWorktree(root: string, name: string): Promise<string> {
	const s = slug(name);
	const branch = `kaioken/${s}`;
	const wt = worktreePath(root, s);

	await mkdir(dirname(wt), { recursive: true });

	if (existsSync(wt)) {
		return wt;
	}

	// Check if branch already exists
	const branchCheck = await git(root, "rev-parse", "--verify", branch);
	let res: { ok: boolean; stdout: string; stderr: string };
	if (branchCheck.ok) {
		res = await git(root, "worktree", "add", wt, branch);
	} else {
		res = await git(root, "worktree", "add", "-b", branch, wt);
	}

	if (!res.ok) {
		throw new Error(`Failed to create worktree: ${res.stderr}`);
	}

	return wt;
}

export async function ffMerge(root: string, name: string): Promise<{ success: boolean; message: string }> {
	const s = slug(name);
	const branch = `kaioken/${s}`;
	const wt = worktreePath(root, s);

	const mergeRes = await git(root, "merge", "--ff-only", branch);
	if (!mergeRes.ok) {
		return { success: false, message: `Fast-forward merge failed: ${mergeRes.stderr}` };
	}

	// Remove worktree
	await git(root, "worktree", "remove", wt, "--force").catch(() => {});
	// Clean branch
	await git(root, "branch", "-d", branch).catch(() => {});

	return { success: true, message: `Merged ${branch} cleanly via fast-forward.` };
}

export async function removeWorktree(root: string, name: string): Promise<boolean> {
	const s = slug(name);
	const wt = worktreePath(root, s);
	const res = await git(root, "worktree", "remove", wt, "--force");
	return res.ok;
}
