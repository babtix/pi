import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bridgeInit from "../index.ts";
import { DefaultSpendGate, parseMult, registerCommands, type SpendGate } from "../commands/index.ts";
import { fakePi as createFakePi } from "./fake-pi.ts";

describe("Phase 6: Command Surface & HUD", () => {
	it("registers all 16 commands", () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		const expected = [
			"kaioken-scan",
			"kaioken-symbols",
			"kaioken-search",
			"kaioken-status",
			"kaioken-verify",
			"kaioken-graph",
			"kaioken-serve",
			"kaioken-export",
			"kaioken-delegate",
			"kaioken-merge",
			"kaioken-plan",
			"kaioken-cards",
			"kaioken-wiki",
			"kaioken-update",
			"kaioken-research",
			"kaioken-skills",
		];

		for (const name of expected) {
			expect(fake.commands.has(name)).toBe(true);
		}
		expect(fake.commands.size).toBe(16);
	});

	it("parses multiplier dial accurately", () => {
		expect(parseMult("")).toBe(3);
		expect(parseMult(undefined)).toBe(3);
		expect(parseMult("×1")).toBe(1);
		expect(parseMult("x5")).toBe(5);
		expect(parseMult("×10")).toBe(10);
		expect(parseMult("×99")).toBe(10); // clamped to 10
		expect(parseMult("0")).toBe(1); // clamped to 1
	});

	it("runs offline commands with zero network access", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-cmd-offline-"));
		try {
			await writeFile(
				join(tempDir, "sample.ts"),
				"export function testFn() { return 42; }\n",
			);

			const notifications: string[] = [];
			const fakeCtx = {
				cwd: tempDir,
				hasUI: true,
				ui: {
					notify: (msg: string) => notifications.push(msg),
					setStatus: () => {},
					setWidget: () => {},
				},
			};

			const fake = createFakePi();
			registerCommands(fake.pi, () => tempDir);

			// 1. /kaioken-scan
			const scanCmd = fake.commands.get("kaioken-scan");
			await scanCmd.handler("", fakeCtx);
			expect(notifications.some((n) => n.includes("Scan complete"))).toBe(true);

			// 2. /kaioken-symbols
			notifications.length = 0;
			const symCmd = fake.commands.get("kaioken-symbols");
			await symCmd.handler("testFn", fakeCtx);
			expect(notifications.some((n) => n.includes("testFn"))).toBe(true);

			// 3. /kaioken-status
			notifications.length = 0;
			const statusCmd = fake.commands.get("kaioken-status");
			await statusCmd.handler("", fakeCtx);
			expect(notifications.some((n) => n.includes("DRIFT REPORT"))).toBe(true);

			// 4. /kaioken-graph
			notifications.length = 0;
			const graphCmd = fake.commands.get("kaioken-graph");
			await graphCmd.handler("", fakeCtx);
			expect(notifications.some((n) => n.includes("Knowledge Graph"))).toBe(true);

			// 5. /kaioken-export
			notifications.length = 0;
			const exportCmd = fake.commands.get("kaioken-export");
			await exportCmd.handler("", fakeCtx);
			expect(notifications.some((n) => n.includes("Exported"))).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("prompts spend confirmation on model commands and respects user cancel", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-cmd-spend-"));
		try {
			const notifications: string[] = [];
			let confirmedPrompt = "";

			const fakeCtx = {
				cwd: tempDir,
				hasUI: true,
				ui: {
					notify: (msg: string) => notifications.push(msg),
					confirm: async (_title: string, message: string) => {
						confirmedPrompt = message;
						return false; // User cancels spend
					},
					setStatus: () => {},
					setWidget: () => {},
				},
			};

			const fake = createFakePi();
			registerCommands(fake.pi, () => tempDir);

			const planCmd = fake.commands.get("kaioken-plan");
			await planCmd.handler("×5", fakeCtx);

			// The gate now quotes the active model's own registry, so with no model
			// bound it must say so plainly rather than print a made-up price.
			expect(confirmedPrompt).toContain("plan ×5");
			expect(confirmedPrompt).toContain("Cost: unknown");
			expect(confirmedPrompt).not.toMatch(/\$\d/);
			expect(confirmedPrompt).toContain("not a quote");
			expect(notifications).toContain("Cancelled spend.");
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("executes /kaioken-plan on confirmation and updates HUD widget with outline", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-cmd-plan-"));
		try {
			await writeFile(join(tempDir, "index.ts"), "export const a = 1;\n");

			let widgetLines: string[] = [];
			const fakeCtx = {
				cwd: tempDir,
				hasUI: true,
				ui: {
					notify: () => {},
					confirm: async () => true, // User confirms spend
					setStatus: () => {},
					setWidget: (_id: string, lines: string[]) => {
						widgetLines = lines;
					},
				},
			};

			const fake = createFakePi();
			registerCommands(fake.pi, () => tempDir);

			const planCmd = fake.commands.get("kaioken-plan");
			await planCmd.handler("×3", fakeCtx);

			// The checkpoint is now a human-editable YAML plan.
			const writtenYaml = await readFile(join(tempDir, ".kaioken", "module-plan.yaml"), "utf8");
			expect(writtenYaml).toContain("Kaioken module plan");
			expect(writtenYaml).toContain("multiplier: 3");

			// Verify HUD widget received outline
			expect(widgetLines.length).toBeGreaterThan(0);
			expect(widgetLines[0]).toContain("module plan");
			// With no model bound the plan is mechanical, and says so.
			expect(widgetLines[0]).toContain("mechanical");
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("quotes real registry pricing when a model is bound, with no hardcoded rates", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kaioken-cmd-cost-"));
		try {
			let confirmedPrompt = "";
			const fakeCtx = {
				cwd: tempDir,
				hasUI: true,
				// Deliberately unusual rates: if the gate were still hardcoding
				// Gemini prices, this figure could not appear.
				model: {
					id: "gemini-3.8-flash-high",
					provider: "antigravity",
					cost: { input: 1.0, output: 2.0, cacheRead: 0.1, cacheWrite: 0.2 },
				},
				ui: {
					notify: () => {},
					confirm: async (_title: string, message: string) => {
						confirmedPrompt = message;
						return false;
					},
					setStatus: () => {},
					setWidget: () => {},
				},
			};

			const fake = createFakePi();
			registerCommands(fake.pi, () => tempDir);
			await fake.commands.get("kaioken-plan").handler("×1", fakeCtx);

			expect(confirmedPrompt).toContain("antigravity/gemini-3.8-flash-high");
			expect(confirmedPrompt).toMatch(/Cost: ~\$\d+\.\d{4} USD/);
			expect(confirmedPrompt).not.toContain("unknown");
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
