import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

interface LmStudioNativeEntry {
	id?: unknown;
	type?: unknown;
	state?: unknown;
	capabilities?: unknown;
	loaded_context_length?: unknown;
	max_context_length?: unknown;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nativeBaseUrl(v1BaseUrl: string): string {
	const trimmed = v1BaseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function supportsImage(entry: LmStudioNativeEntry): boolean {
	const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	if (type === "vlm") return true;
	if (!Array.isArray(entry.capabilities)) return false;
	return entry.capabilities.some(
		c => typeof c === "string" && (c.toLowerCase() === "vision" || c.toLowerCase() === "image"),
	);
}

interface LmStudioSettings {
	v1BaseUrl: string;
	outputFraction: number;
	maxOutputCap: number | undefined;
}

// Query LM Studio's native REST endpoint (the only one that reports load state
// and the applied context length) and map the currently-loaded chat models to
// provider model configs. Throws on an unreachable/invalid endpoint so callers
// can distinguish "cannot reach LM Studio" from "reachable, nothing loaded"
// (an empty array).
async function fetchLoadedModels(settings: LmStudioSettings): Promise<ProviderModelConfig[]> {
	const res = await fetch(`${nativeBaseUrl(settings.v1BaseUrl)}/api/v0/models`, {
		method: "GET",
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`LM Studio native models endpoint returned HTTP ${res.status}`);
	}
	const payload = (await res.json()) as { data?: unknown };
	if (!Array.isArray(payload.data)) {
		throw new Error("LM Studio native models response had no data array");
	}
	const entries = payload.data as LmStudioNativeEntry[];
	const models: ProviderModelConfig[] = [];
	for (const entry of entries) {
		if (entry.state !== "loaded" || typeof entry.id !== "string" || entry.id.length === 0) continue;
		const contextWindow = positive(entry.loaded_context_length) ?? positive(entry.max_context_length) ?? 4096;
		const proportionalMax = Math.max(1, Math.floor(contextWindow * settings.outputFraction));
		models.push({
			id: entry.id,
			name: `${entry.id} (loaded)`,
			reasoning: false,
			input: supportsImage(entry) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: settings.maxOutputCap ? Math.min(proportionalMax, settings.maxOutputCap) : proportionalMax,
		});
	}
	return models;
}

export default async function lmStudioLoaded(pi: ExtensionAPI): Promise<void> {
	const rawFraction = Number(Bun.env.LM_STUDIO_OUTPUT_FRACTION);
	const settings: LmStudioSettings = {
		v1BaseUrl: Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
		outputFraction: rawFraction > 0 && rawFraction <= 1 ? rawFraction : 0.5,
		maxOutputCap: positive(Number(Bun.env.LM_STUDIO_MAX_TOKENS)),
	};
	const PROVIDER = "lm-studio-loaded";

	// Register the loaded models as a STATIC provider model list rather than via
	// `fetchDynamicModels`. The runtime model registry only persists extension
	// providers registered with `models: [...]` across its `#reloadStaticModels()`
	// rebuild (they land in `#runtimeModelOverlays`); a `fetchDynamicModels`
	// provider's discovered models live only in the transient `#models` snapshot.
	// The model picker rebuilds that snapshot on every tab switch
	// (`onTabChange -> refreshProvider(otherProvider) -> #reloadStaticModels()`),
	// which drops any dynamic-only provider whose manager was not part of that
	// filtered refresh — so the tab vanishes the moment you navigate. Static
	// registration survives the rebuild and keeps the tab put.
	//
	// The tradeoff: a static list is a point-in-time snapshot, so it does not
	// auto-refresh when you load/unload a different model in LM Studio. The
	// `lm-studio-refresh` command below re-snapshots and reloads on demand.
	const buildConfig = (models: ProviderModelConfig[]): ProviderConfig => ({
		baseUrl: settings.v1BaseUrl,
		api: "openai-completions",
		apiKey: "lm-studio",
		models,
	});

	try {
		pi.registerProvider(PROVIDER, buildConfig(await fetchLoadedModels(settings)));
	} catch (cause) {
		// Unreachable at startup: register an empty provider so the extension is
		// still wired and a later `lm-studio-refresh` (once LM Studio is up) can
		// populate it via the live registry.
		pi.logger.warn("lm-studio-loaded: initial model discovery failed", {
			error: cause instanceof Error ? cause.message : String(cause),
		});
		pi.registerProvider(PROVIDER, buildConfig([]));
	}

	// Re-snapshot LM Studio's currently-loaded models and apply them to the LIVE
	// model registry (the same instance the picker and agent read), so a model
	// swap shows up on the next /models open without relaunching omp and the tab
	// still persists. If the active model was an lm-studio-loaded model that is no
	// longer loaded, auto-switch to the first currently-loaded model.
	pi.registerCommand("lm-studio-refresh", {
		description: "Refresh the LM Studio loaded-model list (pick up a model swap)",
		handler: async (_args, ctx) => {
			let models: ProviderModelConfig[];
			try {
				models = await fetchLoadedModels(settings);
			} catch (cause) {
				const error = cause instanceof Error ? cause.message : String(cause);
				pi.logger.warn("lm-studio-loaded: refresh discovery failed", { error });
				ctx.ui.notify(`LM Studio refresh failed: ${error}`, "error");
				return;
			}

			// Apply to the LIVE registry (same instance the picker + agent read).
			// The static-models path replaces this provider's overlay by name, so
			// the new list shows on the next /models open and the tab still persists.
			ctx.modelRegistry.registerProvider(PROVIDER, buildConfig(models));

			// Auto-switch only when the active model IS an lm-studio-loaded model
			// that is no longer loaded, and at least one model is now loaded.
			const current = ctx.model;
			if (current?.provider === PROVIDER && models.length > 0 && !models.some(m => m.id === current.id)) {
				const next = ctx.modelRegistry.find(PROVIDER, models[0].id);
				if (next) {
					const ok = await pi.setModel(next);
					ctx.ui.notify(
						ok
							? `LM Studio model "${current.id}" unloaded — switched to "${next.id}".`
							: `LM Studio model "${current.id}" unloaded, but switching to "${next.id}" failed.`,
						ok ? "info" : "warning",
					);
					return;
				}
			}

			ctx.ui.notify(
				models.length > 0
					? `LM Studio: ${models.length} model(s) loaded.`
					: "LM Studio: no models loaded.",
				"info",
			);
		},
	});
}
