import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelUnavailableError, PiAiClient } from "../src/piai.ts";

/**
 * A stub `Models` good enough to exercise the adapter without a transport,
 * a credential or a network. This is the seam that keeps the generative
 * pipeline offline-testable (Invariant 10).
 */
function stubModels(options: {
	model?: Model<any> | undefined;
	reply?: Partial<AssistantMessage>;
	throwOnGetModel?: Error;
}) {
	const complete = vi.fn(async () => {
		return {
			role: "assistant",
			content: [{ type: "text", text: "hello from the stub" }],
			api: "openai-completions",
			provider: "antigravity",
			model: "gemini-3.8-flash-high",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
			...options.reply,
		} as AssistantMessage;
	});

	const models = {
		getModel: () => {
			if (options.throwOnGetModel) throw options.throwOnGetModel;
			return options.model;
		},
		getModels: () => (options.model ? [options.model] : []),
		complete,
	} as unknown as Models;

	return { models, complete };
}

const fakeModel = {
	id: "gemini-3.8-flash-high",
	name: "Gemini 3.8 Flash (high)",
	provider: "antigravity",
} as unknown as Model<any>;

describe("modelport: PiAiClient", () => {
	it("returns the assistant text for a successful call", async () => {
		const { models, complete } = stubModels({ model: fakeModel });
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		const text = await client.complete({ purpose: "plan", system: "SYS", prompt: "PROMPT" });

		expect(text).toBe("hello from the stub");
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("forwards system, prompt and output budget to the transport", async () => {
		const { models, complete } = stubModels({ model: fakeModel });
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		await client.complete({ purpose: "plan", system: "SYS", prompt: "PROMPT", maxOutputTokens: 4321 });

		const [, context, options] = complete.mock.calls[0] as any[];
		expect(context.systemPrompt).toBe("SYS");
		expect(context.messages[0].content).toBe("PROMPT");
		expect(options.maxTokens).toBe(4321);
	});

	it("omits reasoning and temperature when the caller leaves them unset", async () => {
		const { models, complete } = stubModels({ model: fakeModel });
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		await client.complete({ purpose: "plan", system: "S", prompt: "P" });

		const [, , options] = complete.mock.calls[0] as any[];
		expect(options).not.toHaveProperty("reasoning");
		expect(options).not.toHaveProperty("temperature");
		expect(options).not.toHaveProperty("maxTokens");
	});

	it("passes reasoning through when configured", async () => {
		const { models, complete } = stubModels({ model: fakeModel });
		const client = new PiAiClient(models, {
			provider: "antigravity",
			model: "gemini-3.8-flash-high",
			reasoning: "high",
		});

		await client.complete({ purpose: "plan", system: "S", prompt: "P" });

		const [, , options] = complete.mock.calls[0] as any[];
		expect(options.reasoning).toBe("high");
	});

	it("joins multiple text blocks from the reply", async () => {
		const { models } = stubModels({
			model: fakeModel,
			reply: {
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		});
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		expect(await client.complete({ purpose: "plan", system: "S", prompt: "P" })).toBe("first\nsecond");
	});

	it("raises a diagnostic error when the transport reports a failure", async () => {
		const { models } = stubModels({
			model: fakeModel,
			reply: {
				stopReason: "error",
				diagnostics: [{ type: "auth", timestamp: Date.now(), error: { message: "bad key" } }],
			},
		});
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		await expect(client.complete({ purpose: "plan", system: "S", prompt: "P" })).rejects.toThrow(
			/ended with error: bad key/,
		);
	});

	it("names the stage in transport failures so the caller can locate them", async () => {
		const { models } = stubModels({ model: fakeModel, reply: { stopReason: "aborted" } });
		const client = new PiAiClient(models, { provider: "antigravity", model: "gemini-3.8-flash-high" });

		await expect(client.complete({ purpose: "wiki", system: "S", prompt: "P" })).rejects.toThrow(/"wiki"/);
	});

	it("explains an unknown model by listing what the provider does offer", () => {
		const { models } = stubModels({ model: undefined });
		const client = new PiAiClient(models, { provider: "antigravity", model: "nope" });

		expect(() => client.resolveModel()).toThrow(ModelUnavailableError);
		expect(() => client.resolveModel()).toThrow(/declares no models/);
	});

	it("explains a throwing lookup instead of masking it", () => {
		const { models } = stubModels({ throwOnGetModel: new Error("registry offline") });
		const client = new PiAiClient(models, { provider: "antigravity", model: "nope" });

		expect(() => client.resolveModel()).toThrow(/lookup threw: registry offline/);
	});
});
