/**
 * The Pi transport behind the Kaioken model port.
 *
 * This is the only file in the offline core that knows a model transport exists,
 * and even it does not know how to authenticate: the caller injects a ready
 * `Models` instance, so credentials, `models.json` and the cost registry stay in
 * Pi's hands (Invariant 2 — the core never reads a key).
 *
 * Because the dependency is injected rather than imported as a singleton, tests
 * drive the whole generative pipeline with a stub, which is what keeps
 * "a stage that needs a key to be tested is designed wrong" true (Invariant 10).
 */

import type { Api, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequest } from "./port.ts";

export interface PiAiClientOptions {
	/** Provider id as registered in Pi, e.g. `antigravity`. */
	provider: string;
	/** Model id as registered in Pi, e.g. `gemini-3.8-flash-high`. */
	model: string;
	/** Reasoning effort. Omitted lets the provider default stand. */
	reasoning?: ThinkingLevel;
	/** Sampling temperature. Omitted lets the provider default stand. */
	temperature?: number;
}

export class ModelUnavailableError extends Error {
	constructor(provider: string, model: string, hint: string) {
		super(`model "${provider}/${model}" is unavailable: ${hint}`);
		this.name = "ModelUnavailableError";
	}
}

export class PiAiClient implements ModelClient {
	private readonly models: Models;
	private readonly options: PiAiClientOptions;

	constructor(models: Models, options: PiAiClientOptions) {
		this.models = models;
		this.options = options;
	}

	/** Resolve the configured model, or explain precisely why it is not usable. */
	resolveModel(): Model<Api> {
		const { provider, model } = this.options;
		let resolved: Model<Api> | undefined;
		try {
			resolved = this.models.getModel(provider, model);
		} catch (error) {
			throw new ModelUnavailableError(provider, model, `lookup threw: ${(error as Error).message}`);
		}
		if (!resolved) {
			const known = this.models
				.getModels(provider)
				.map((m) => m.id)
				.join(", ");
			throw new ModelUnavailableError(
				provider,
				model,
				known
					? `provider "${provider}" offers: ${known}`
					: `provider "${provider}" is unknown or declares no models`,
			);
		}
		return resolved;
	}

	async complete(request: ModelRequest): Promise<string> {
		const model = this.resolveModel();
		const message = await this.models.complete(
			model,
			{
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
			},
			{
				...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
				...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }),
				...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
			},
		);

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const detail =
				message.diagnostics
					?.map((d) => d.error?.message ?? d.type)
					.filter(Boolean)
					.join("; ") || "no diagnostics";
			throw new Error(`model call for stage "${request.purpose}" ended with ${message.stopReason}: ${detail}`);
		}

		return contentText(message.content);
	}
}
