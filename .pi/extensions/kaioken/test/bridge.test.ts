import { describe, it, expect } from "vitest";
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

describe("Phase 1: Kaioken Bridge Skeleton", () => {
	it("registers kaioken_status tool and session_start hook", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		// Verify tool registration
		expect(fake.tools.length).toBe(1);
		const statusTool = fake.tools[0];
		expect(statusTool.name).toBe("kaioken_status");
		expect(statusTool.label).toBe("Kaioken Status");

		// Execute tool
		const result = await statusTool.execute();
		expect(result.content).toEqual([
			{ type: "text", text: "bridge alive (core lands in Phase 2)" },
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
			},
		};

		await fake.hooks.session_start[0]({}, fakeCtx);
		expect(setStatusArgs).toEqual(["kaioken", "bridge v0.1"]);
	});
});
