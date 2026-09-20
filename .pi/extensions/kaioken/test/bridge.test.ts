import { describe, expect, it } from "vitest";
import bridgeInit from "../index.ts";

function createFakePi() {
	const tools: any[] = [];
	const commands: any[] = [];
	const hooks: Record<string, any[]> = {};
	const pi = {
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: (name: string, opts: any) => commands.push({ name, ...opts }),
		on: (event: string, handler: any) => {
			(hooks[event] ??= []).push(handler);
		},
	};
	return { pi: pi as any, tools, commands, hooks };
}

describe("Phase 3: Kaioken Bridge & Grounding Tools", () => {
	it("registers all 7 grounding tools and session_start hook", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		// Verify 7 tools registered
		expect(fake.tools.length).toBe(7);
		const toolNames = fake.tools.map((t) => t.name);
		expect(toolNames).toEqual([
			"kaioken_symbol_lookup",
			"kaioken_read_file",
			"kaioken_wiki_search",
			"kaioken_impact",
			"kaioken_skill_load",
			"kaioken_status",
			"kaioken_verify",
		]);

		const labels = fake.tools.map((t) => t.label);
		expect(labels).toEqual([
			"Symbol Oracle",
			"Grounded Read",
			"Wiki/Card Search",
			"Blast Radius",
			"Load Procedure",
			"Drift Check",
			"Hard Test Gate",
		]);

		// Verify session_start hook
		expect(fake.hooks.session_start).toBeDefined();
		expect(fake.hooks.session_start.length).toBe(1);

		let setStatusArgs: [string, string] | null = null;
		const fakeCtx = {
			ui: {
				setStatus: (id: string, text: string) => {
					setStatusArgs = [id, text];
				},
				setWidget: () => {},
			},
		};

		await fake.hooks.session_start[0]({}, fakeCtx);
		expect(setStatusArgs).toEqual(["kaioken", "grounded · flash-high"]);
	});
});
