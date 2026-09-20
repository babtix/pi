import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
		assert.equal(fake.tools.length, 1);
		const statusTool = fake.tools[0];
		assert.equal(statusTool.name, "kaioken_status");
		assert.equal(statusTool.label, "Kaioken Status");

		// Execute tool
		const result = await statusTool.execute();
		assert.deepEqual(result.content, [
			{ type: "text", text: "bridge alive (core lands in Phase 2)" },
		]);

		// Verify session_start hook
		assert.ok(fake.hooks.session_start);
		assert.equal(fake.hooks.session_start.length, 1);

		let setStatusArgs: [string, string] | null = null;
		const fakeCtx = {
			ui: {
				setStatus: (id: string, text: string) => {
					setStatusArgs = [id, text];
				},
			},
		};

		await fake.hooks.session_start[0]({}, fakeCtx);
		assert.deepEqual(setStatusArgs, ["kaioken", "bridge v0.1"]);
	});
});
