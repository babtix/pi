import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bridgeInit from "../index.ts";
import { isDirty, registerHooks, setDirty } from "../hooks/index.ts";
import { GROUNDING_RULES } from "../prompts/grounding.ts";

function createFakePi() {
	const tools: Map<string, any> = new Map();
	const hooks: Record<string, any[]> = {};
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		on: (event: string, handler: any) => {
			(hooks[event] ??= []).push(handler);
		},
	};
	return { pi: pi as any, tools, hooks };
}

describe("Phase 4: Grounded Prompt & Lifecycle Hooks", () => {
	it("injects grounding rules into system prompt on before_agent_start", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		expect(fake.hooks.before_agent_start).toBeDefined();
		const handler = fake.hooks.before_agent_start[0];

		const event = {
			type: "before_agent_start",
			prompt: "build a feature",
			systemPrompt: "You are an assistant.",
			systemPromptOptions: {},
		};

		const result = await handler(event);
		expect(result.systemPrompt).toContain("You are an assistant.");
		expect(result.systemPrompt).toContain("KAIOKEN GROUNDING RULES");
		expect(result.systemPrompt).toContain("1. NEVER assert a symbol/import/file exists without kaioken_symbol_lookup first.");
		expect(result.systemPrompt).toContain("5. A coding task is COMPLETE only after kaioken_verify returns PASS.");
	});

	it("sets grounded badge and widget on session_start", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		let badgeStatus = "";
		let widgetData: [string, string[]] | null = null;
		const fakeCtx = {
			ui: {
				setStatus: (id: string, text: string) => {
					if (id === "kaioken") badgeStatus = text;
				},
				setWidget: (id: string, lines: string[]) => {
					widgetData = [id, lines];
				},
			},
		};

		await fake.hooks.session_start[0]({}, fakeCtx);
		expect(badgeStatus).toBe("grounded · flash-high");
		expect(widgetData).toEqual(["kaioken", ["kaioken: grounded", "model: gemini-3.8-flash-high"]]);
	});

	it("flips badge to UNVERIFIED CHANGES and sets dirty on edit/write tool calls", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		let badgeStatus = "";
		const fakeCtx = {
			ui: {
				setStatus: (id: string, text: string) => {
					if (id === "kaioken") badgeStatus = text;
				},
				setWidget: () => {},
			},
		};

		// Start session first to bind lastCtx
		await fake.hooks.session_start[0]({}, fakeCtx);
		setDirty(false);
		expect(isDirty()).toBe(false);

		// Trigger edit tool call
		const editEvent = { toolName: "edit", input: { path: "src/foo.ts" } };
		await fake.hooks.tool_call[0](editEvent, fakeCtx);

		expect(isDirty()).toBe(true);
		expect(badgeStatus).toBe("UNVERIFIED CHANGES");

		// Trigger write tool call
		setDirty(false);
		const writeEvent = { toolName: "write", input: { path: "src/bar.ts" } };
		await fake.hooks.tool_call[0](writeEvent, fakeCtx);

		expect(isDirty()).toBe(true);
		expect(badgeStatus).toBe("UNVERIFIED CHANGES");
	});

	it("blocks destructive bash operations and allows safe ones", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		const fakeCtx = {
			ui: {
				setStatus: () => {},
				setWidget: () => {},
			},
		};

		const handler = fake.hooks.tool_call[0];

		// Destructive rm -rf
		const rmCall = { toolName: "bash", input: { command: "rm -rf /tmp/test" } };
		const rmResult = await handler(rmCall, fakeCtx);
		expect(rmResult).toEqual({ block: true, reason: "Kaioken policy: destructive operation blocked" });

		// Destructive git push --force
		const pushCall = { toolName: "bash", input: { command: "git push origin main --force" } };
		const pushResult = await handler(pushCall, fakeCtx);
		expect(pushResult).toEqual({ block: true, reason: "Kaioken policy: destructive operation blocked" });

		// Destructive DROP TABLE
		const sqlCall = { toolName: "bash", input: { command: "psql -c 'DROP TABLE users;'" } };
		const sqlResult = await handler(sqlCall, fakeCtx);
		expect(sqlResult).toEqual({ block: true, reason: "Kaioken policy: destructive operation blocked" });

		// Safe command
		const safeCall = { toolName: "bash", input: { command: "git status" } };
		const safeResult = await handler(safeCall, fakeCtx);
		expect(safeResult).toBeUndefined();
	});

	it("flips badge to verified ✓ and clears dirty on verify PASS", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-badge-verify-"));
		try {
			await writeFile(
				join(tempDir, "package.json"),
				JSON.stringify({ name: "verify-pass", scripts: { test: 'node -e "process.exit(0)"' } }),
			);

			const fake = createFakePi();
			let badgeStatus = "";
			const fakeCtx = {
				cwd: tempDir,
				ui: {
					setStatus: (id: string, text: string) => {
						if (id === "kaioken") badgeStatus = text;
					},
					setWidget: () => {},
				},
			};

			// Initialize
			bridgeInit(fake.pi);
			await fake.hooks.session_start[0]({}, fakeCtx);

			// Mark dirty via edit
			await fake.hooks.tool_call[0]({ toolName: "edit", input: {} }, fakeCtx);
			expect(isDirty()).toBe(true);
			expect(badgeStatus).toBe("UNVERIFIED CHANGES");

			// Run verify passing tool
			const verifyTool = fake.tools.get("kaioken_verify");
			const result = await verifyTool.execute("verify-call", {}, undefined, undefined, fakeCtx);
			expect(result.content[0].text).toBe("VERIFY: PASS (0 errors)");

			// Badge must flip to verified ✓ and dirty cleared
			expect(isDirty()).toBe(false);
			expect(badgeStatus).toBe("verified ✓");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
