import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  persistDefaultModelIfUnset,
  pickPreferredCursorModel,
  toPiCursorModel,
} from "../src/extension/default-model.js";
import type { ProcessedModel } from "../src/models/processing.js";
import { ProviderConstant } from "../src/types/enums.js";

function model(id: string, name = id): ProcessedModel {
  return {
    id,
    name,
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsEffort: false,
  };
}

describe("pickPreferredCursorModel", () => {
  it("prefers auto, then composer-2 family, then catalog order", () => {
    expect(pickPreferredCursorModel([model("claude-4-sonnet"), model("auto")])?.id).toBe("auto");
    expect(pickPreferredCursorModel([model("gpt-5.5"), model("composer-2")])?.id).toBe(
      "composer-2",
    );
    expect(pickPreferredCursorModel([model("composer-1.5"), model("composer-2-fast")])?.id).toBe(
      "composer-2-fast",
    );
    expect(pickPreferredCursorModel([model("claude-4-sonnet"), model("gpt-5.5")])?.id).toBe(
      "claude-4-sonnet",
    );
  });

  it("returns undefined for an empty catalog", () => {
    expect(pickPreferredCursorModel([])).toBeUndefined();
  });
});

describe("toPiCursorModel", () => {
  it("attaches the cursor provider id and agent base URL", () => {
    const piModel = toPiCursorModel(model("auto", "Auto"));
    expect(piModel.provider).toBe(ProviderConstant.ProviderId);
    expect(piModel.id).toBe("auto");
    expect(piModel.api).toBe(ProviderConstant.NativeApi);
    expect(piModel.baseUrl).toMatch(/^https?:\/\//);
  });
});

describe("persistDefaultModelIfUnset", () => {
  let agentDir: string | undefined;

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    agentDir = undefined;
  });

  it("writes defaultProvider/defaultModel when settings are empty", () => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-cursor-default-model-"));
    persistDefaultModelIfUnset("auto", { agentDir });

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings.defaultProvider).toBe("cursor");
    expect(settings.defaultModel).toBe("auto");
  });

  it("does not overwrite an existing default provider/model pair", () => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-cursor-default-model-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-8",
        packages: [],
      }),
      "utf8",
    );

    persistDefaultModelIfUnset("auto", { agentDir });

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings.defaultProvider).toBe("anthropic");
    expect(settings.defaultModel).toBe("claude-opus-4-8");
    expect(settings.packages).toEqual([]);
  });
});
