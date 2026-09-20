import { describe, expect, it } from "vitest";
import bridgeInit from "../index.ts";
import { fakePi as createFakePi } from "./fake-pi.ts";

describe("Phase 3: Kaioken Bridge & Grounding Tools", () => {
	it("registers all 7 grounding tools and session_start hook", async () => {
		const fake = createFakePi();
		bridgeInit(fake.pi);

		// Verify 7 tools registered
		expect(fake.tools.length).toBe(7);
		const toolNames = fake.tools.map((t) => t.name);
		expect(toolNames).toEqual([
			"kaio_symbol_lookup",
			"kaio_read_file",
			"kaio_wiki_search",
			"kaio_impact",
			"kaio_skill_load",
			"kaio_status",
			"kaio_verify",
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
		// Two handlers, not one: the hooks module sets the badge and widget, and
		// the extension entry point installs the custom header. They are
		// separate concerns and Pi runs both.
		expect(fake.hooks.session_start.length).toBe(2);

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
