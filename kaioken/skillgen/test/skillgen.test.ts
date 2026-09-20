import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexResult } from "@kaioken/index";
import type { ModelClient, ModelRequest } from "@kaioken/modelport";
import type { ScanResult } from "@kaioken/scan";
import { proposeSkills, slug } from "../src/propose.ts";
import { skillExists, writeSkill } from "../src/write.ts";

function scriptedClient(replies: string[]): ModelClient & { requests: ModelRequest[] } {
	const requests: ModelRequest[] = [];
	let index = 0;
	return {
		requests,
		async complete(request: ModelRequest): Promise<string> {
			requests.push(request);
			const reply = replies[Math.min(index, replies.length - 1)] ?? "";
			index++;
			return reply;
		},
	};
}

function scanOf(files: Array<{ path: string; hash?: string }>): ScanResult {
	return {
		root: "/repo",
		scannedAt: "",
		fileCount: files.length,
		totalBytes: files.length * 100,
		files: files.map((f) => ({
			path: f.path,
			language: "typescript",
			bytes: 100,
			lineCount: 20,
			risk: [],
			binary: false,
			hash: f.hash ?? `hash-${f.path}`,
		})),
	} as unknown as ScanResult;
}

const index: IndexResult = {
	root: "/repo",
	builtAt: "",
	fileCount: 1,
	symbolCount: 1,
	unparsedLanguages: {},
	files: [
		{
			path: "src/commands/add.ts",
			language: "typescript",
			lineCount: 20,
			hash: "h1",
			unparsed: false,
			symbols: [
				{
					name: "addCommand",
					kind: "function",
					signature: "addCommand(): void",
					startLine: 1,
					endLine: 5,
					exported: true,
					doc: "",
				},
			],
		},
	],
} as unknown as IndexResult;

const scan = scanOf([{ path: "src/commands/add.ts", hash: "h1" }, { path: "src/commands/run.ts" }]);

describe("skillgen: proposal", () => {
	it("parses skills from a reply", async () => {
		const client = scriptedClient([
			JSON.stringify({
				skills: [
					{
						name: "Add A Command",
						description: "How to add a CLI command. Load when adding one.",
						task: "Add a command.",
						files: ["src/commands"],
					},
				],
			}),
		]);
		const skills = await proposeSkills({ scan, index, client });
		expect(skills[0]?.name).toBe("add-a-command");
		expect(skills[0]?.files).toEqual(["src/commands"]);
	});

	it("drops a duplicate name so one generation cannot overwrite another", async () => {
		const client = scriptedClient([
			JSON.stringify({
				skills: [
					{ name: "add-command", description: "First.", task: "t", files: [] },
					{ name: "Add Command", description: "Second.", task: "t", files: [] },
				],
			}),
		]);
		const skills = await proposeSkills({ scan, index, client });
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("First.");
	});

	it("drops an entry with no usable name", async () => {
		const client = scriptedClient([JSON.stringify({ skills: [{ description: "No name." }] })]);
		expect(await proposeSkills({ scan, index, client })).toHaveLength(0);
	});

	it("falls back to the task when no description is given", async () => {
		const client = scriptedClient([
			JSON.stringify({ skills: [{ name: "add-thing", task: "Add a thing.", files: [] }] }),
		]);
		const skills = await proposeSkills({ scan, index, client });
		expect(skills[0]?.description).toBe("Add a thing.");
	});

	it("honours the limit", async () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}`, description: "d", task: "t", files: [] }));
		const client = scriptedClient([JSON.stringify({ skills: many })]);
		expect(await proposeSkills({ scan, index, client, limit: 5 })).toHaveLength(5);
	});

	it("throws when the reply carries no JSON at all", async () => {
		const client = scriptedClient(["I could not decide."]);
		await expect(proposeSkills({ scan, index, client })).rejects.toThrow(/no parseable JSON/);
	});

	it("tells the model the wiki already describes", async () => {
		const client = scriptedClient([JSON.stringify({ skills: [] })]);
		await proposeSkills({ scan, index, client, chapters: ["Architecture"], notes: ["Prefer tests first."] });
		expect(client.requests[0]?.prompt).toContain("Architecture");
		expect(client.requests[0]?.prompt).toContain("Prefer tests first.");
	});
});

describe("skillgen: slugs", () => {
	it("makes a model-supplied name file-safe", () => {
		expect(slug("Add A Command")).toBe("add-a-command");
		expect(slug("../../etc/passwd")).toBe("etc-passwd");
		expect(slug("  ...  ")).toBe("");
	});

	it("bounds the length", () => {
		expect(slug("a".repeat(200)).length).toBeLessThanOrEqual(60);
	});
});

describe("skillgen: writing", () => {
	async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
		const root = await mkdtemp(join(tmpdir(), "kaioken-skill-"));
		try {
			return await fn(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const proposal = {
		name: "add-a-command",
		description: "How to add a command.",
		task: "Add a command.",
		files: ["src/commands"],
	};

	it("writes a skill with frontmatter and resolves directory sources", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["# Add a command\n\nEdit `src/commands/add.ts`."]);
			const written = await writeSkill({ root, proposal, scan, index, client });

			expect(written.name).toBe("add-a-command");
			// A directory in the proposal expands to the files beneath it.
			expect(written.sources).toEqual(["src/commands/add.ts", "src/commands/run.ts"]);
			expect(written.ungrounded).toEqual([]);

			const text = await readFile(join(root, ".kaioken", "skills", "add-a-command.md"), "utf8");
			expect(text).toContain("name: add-a-command");
			expect(text).toContain("origin: generated");
			expect(text).toContain("# Add a command");
		});
	});

	it("reports a path the body cites that the repository lacks", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["# T\n\nEdit `src/ghost/file.ts` to begin."]);
			const written = await writeSkill({ root, proposal, scan, index, client });
			expect(written.ungrounded).toEqual(["src/ghost/file.ts"]);
		});
	});

	it("does not flag a command in backticks as a missing path", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["# T\n\nRun `npm test` and then `git status`."]);
			const written = await writeSkill({ root, proposal, scan, index, client });
			expect(written.ungrounded).toEqual([]);
		});
	});

	it("does not flag a URL as a missing path", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["# T\n\nSee `https://example.com/a.md`."]);
			const written = await writeSkill({ root, proposal, scan, index, client });
			expect(written.ungrounded).toEqual([]);
		});
	});

	it("strips a wrapping fence", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["```markdown\n# T\n\nBody.\n```"]);
			const written = await writeSkill({ root, proposal, scan, index, client });
			const text = await readFile(join(root, ".kaioken", "skills", "add-a-command.md"), "utf8");
			expect(text).toContain("# T\n\nBody.");
			expect(written.lines).toBeGreaterThan(0);
		});
	});

	it("refuses to write an empty body", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["   "]);
			await expect(writeSkill({ root, proposal, scan, index, client })).rejects.toThrow(/empty body/);
		});
	});

	it("drops a proposed path that does not exist, so it never reaches the prompt", async () => {
		await withRoot(async (root) => {
			const client = scriptedClient(["# T\n\nBody."]);
			const written = await writeSkill({
				root,
				proposal: { ...proposal, files: ["src/commands", "src/invented"] },
				scan,
				index,
				client,
			});
			// The invented path is filtered out of the evidence entirely, which is
			// stronger than warning the model about it: it cannot cite what it
			// was never shown.
			expect(written.sources).not.toContain("src/invented");
			expect(client.requests[0]?.prompt).not.toContain("src/invented");
		});
	});

	it("caps how many sources a skill is written from", async () => {
		await withRoot(async (root) => {
			const many = scanOf(Array.from({ length: 100 }, (_, i) => ({ path: `src/commands/c${i}.ts` })));
			const client = scriptedClient(["# T\n\nBody."]);
			const written = await writeSkill({
				root,
				proposal: { ...proposal, files: ["src/commands"] },
				scan: many,
				index: null,
				client,
			});
			expect(written.sources.length).toBeLessThanOrEqual(40);
		});
	});

	it("reports whether a skill already exists", async () => {
		await withRoot(async (root) => {
			expect(await skillExists(root, "add-a-command")).toBe(false);
			const client = scriptedClient(["# T\n\nBody."]);
			await writeSkill({ root, proposal, scan, index, client });
			expect(await skillExists(root, "add-a-command")).toBe(true);
		});
	});
});
