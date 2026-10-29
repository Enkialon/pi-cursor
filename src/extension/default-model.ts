/**
 * Pick and apply a default Cursor model after login / session start.
 *
 * Pi only auto-selects providers listed in its built-in `defaultModelPerProvider`
 * map. Cursor is an extension provider, so `/login cursor` otherwise ends with:
 * "no default model is configured for provider cursor". Selecting a model here
 * (and persisting settings when unset) makes the session usable immediately.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getCursorAgentUrl } from "../stream/config.js";
import { modelConfig, type ProcessedModel } from "../models/processing.js";
import { ProviderConstant } from "../types/enums.js";
import { debugExtensionLog } from "./debug-hooks.js";

/** Prefer Cursor Auto, then common agent models, then catalog order. */
export const PREFERRED_CURSOR_MODEL_IDS = [
  "auto",
  "composer-2",
  "composer-2-fast",
  "composer-1.5",
] as const;

export function pickPreferredCursorModel(
  models: readonly ProcessedModel[],
): ProcessedModel | undefined {
  for (const id of PREFERRED_CURSOR_MODEL_IDS) {
    const hit = models.find((model) => model.id === id);
    if (hit) return hit;
  }
  return models[0];
}

export function toPiCursorModel(model: ProcessedModel): Model<string> {
  const config = modelConfig(model);
  return {
    ...config,
    provider: ProviderConstant.ProviderId,
    baseUrl: getCursorAgentUrl(),
  };
}

/** Persist Pi's default provider/model when the user has not configured one yet. */
export function persistDefaultModelIfUnset(modelId: string, options?: { agentDir?: string }): void {
  try {
    const settingsPath = join(options?.agentDir ?? getAgentDir(), "settings.json");
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Create settings.json on first successful Cursor login.
    }

    const hasProvider = typeof data.defaultProvider === "string" && data.defaultProvider.length > 0;
    const hasModel = typeof data.defaultModel === "string" && data.defaultModel.length > 0;
    if (hasProvider && hasModel) return;

    if (!hasProvider) data.defaultProvider = ProviderConstant.ProviderId;
    if (!hasModel) data.defaultModel = modelId;
    writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort only; session setModel still makes the current turn usable.
  }
}

async function trySetCursorDefaultModel(
  pi: ExtensionAPI,
  models: readonly ProcessedModel[],
  reason: string,
): Promise<boolean> {
  const preferred = pickPreferredCursorModel(models);
  if (!preferred) return false;
  const model = toPiCursorModel(preferred);

  try {
    const ok = await pi.setModel(model);
    debugExtensionLog("default_model.set", { reason, ok, id: preferred.id });
    if (ok) persistDefaultModelIfUnset(preferred.id);
    return ok;
  } catch (err) {
    debugExtensionLog("default_model.set_failed", {
      reason,
      id: preferred.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Select a Cursor model once Pi has had a chance to persist OAuth credentials.
 * Retries briefly because `/login` saves credentials just after `oauth.login` returns.
 */
export function scheduleCursorDefaultModelSelection(
  pi: ExtensionAPI,
  models: readonly ProcessedModel[],
  reason: string,
): void {
  if (models.length === 0) return;

  void (async () => {
    for (const delayMs of [0, 50, 200, 500]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (await trySetCursorDefaultModel(pi, models, `${reason}+${delayMs}ms`)) return;
    }
  })();
}

/** Session-start helper: no-op when a model is already selected or auth is missing. */
export async function ensureCursorDefaultModelOnSessionStart(
  pi: ExtensionAPI,
  models: readonly ProcessedModel[],
): Promise<boolean> {
  return trySetCursorDefaultModel(pi, models, "session_start");
}
