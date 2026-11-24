/**
 * Cursor models are trained on Cursor-native tool argument names
 * (`contents`, `old_string`, …). Pi's MCP tools use different names
 * (`content`, `oldText`, …). CallDynamicTool validates against the
 * advertised schema *before* the call reaches this provider, so the
 * schema must accept the aliases and the decoded args must be rewritten
 * back to Pi's names before dispatch.
 */

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCompatKey(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function withAliasProperty(
  properties: Record<string, unknown>,
  canonical: string,
  alias: string,
  description: string,
): void {
  if (!Object.hasOwn(properties, canonical) || Object.hasOwn(properties, alias)) return;
  const canonicalSchema = properties[canonical];
  if (!isObjectRecord(canonicalSchema)) {
    properties[alias] = { type: "string", description };
    return;
  }
  properties[alias] = {
    ...canonicalSchema,
    description,
  };
}

function requireOneOf(schema: Record<string, unknown>, groups: string[][]): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  const aliased = new Set(groups.flat());
  const nextRequired = required.filter((name) => !aliased.has(name));
  if (nextRequired.length > 0) schema.required = nextRequired;
  else delete schema.required;
  const existingAnyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  schema.anyOf = [...existingAnyOf, ...groups.map((group) => ({ required: group }))];
}

function parseToolSchemaJson(schemaJson: string | undefined): Record<string, unknown> | undefined {
  if (!schemaJson) return undefined;
  try {
    const parsed = JSON.parse(schemaJson) as unknown;
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function schemaHasEditsProperty(schema: unknown): boolean {
  return isObjectRecord(schema) && isObjectRecord(schema.properties) && "edits" in schema.properties;
}

/** Expand a Pi tool JSON Schema so Cursor-native argument aliases validate. */
export function expandToolSchemaForCursorAliases(
  toolName: string,
  schema: unknown,
): unknown {
  if (!isObjectRecord(schema)) return schema;
  const key = toolCompatKey(toolName);
  const properties = isObjectRecord(schema.properties) ? { ...schema.properties } : undefined;
  if (!properties) return schema;

  if (key === "write") {
    const next: Record<string, unknown> = { ...schema, properties };
    withAliasProperty(
      properties,
      "content",
      "contents",
      "Alias for content. Cursor's Write tool uses this name; prefer content.",
    );
    if (Object.hasOwn(properties, "content")) {
      requireOneOf(next, [["content"], ["contents"]]);
    }
    return next;
  }

  if (key === "edit") {
    const next: Record<string, unknown> = { ...schema, properties: { ...properties } };
    const topProps = next.properties as Record<string, unknown>;

    // Pi's edit tool: `{ path, edits: [{ oldText, newText }] }`.
    if (schemaHasEditsProperty(schema)) {
      const edits = isObjectRecord(properties.edits) ? { ...properties.edits } : undefined;
      if (edits) {
        const items = isObjectRecord(edits.items) ? { ...edits.items } : undefined;
        if (items) {
          const itemProps = isObjectRecord(items.properties) ? { ...items.properties } : {};
          withAliasProperty(
            itemProps,
            "oldText",
            "old_string",
            "Alias for oldText. Cursor's StrReplace tool uses this name; prefer oldText.",
          );
          withAliasProperty(
            itemProps,
            "newText",
            "new_string",
            "Alias for newText. Cursor's StrReplace tool uses this name; prefer newText.",
          );
          items.properties = itemProps;
          if (Object.hasOwn(itemProps, "oldText") && Object.hasOwn(itemProps, "newText")) {
            requireOneOf(items, [
              ["oldText", "newText"],
              ["old_string", "new_string"],
            ]);
          }
          edits.items = items;
        }
        topProps.edits = edits;
      }

      // Also accept a flat Cursor StrReplace call and rewrite it to `edits` at dispatch.
      topProps.old_string = {
        type: "string",
        description:
          "Cursor StrReplace alias: treated as edits[0].oldText when `edits` is omitted.",
      };
      topProps.new_string = {
        type: "string",
        description:
          "Cursor StrReplace alias: treated as edits[0].newText when `edits` is omitted.",
      };
      requireOneOf(next, [
        ["edits"],
        ["old_string", "new_string"],
      ]);
      return next;
    }

    // Flat edit schemas (`path` + `oldText`/`newText`): only add Cursor aliases.
    withAliasProperty(
      topProps,
      "oldText",
      "old_string",
      "Alias for oldText. Cursor's StrReplace tool uses this name; prefer oldText.",
    );
    withAliasProperty(
      topProps,
      "newText",
      "new_string",
      "Alias for newText. Cursor's StrReplace tool uses this name; prefer newText.",
    );
    if (Object.hasOwn(topProps, "oldText") && Object.hasOwn(topProps, "newText")) {
      requireOneOf(next, [
        ["oldText", "newText"],
        ["old_string", "new_string"],
      ]);
    }
    return next;
  }

  return schema;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeEditEntry(entry: unknown): unknown {
  if (!isObjectRecord(entry)) return entry;
  const oldText = pickString(entry, "oldText", "old_string");
  const newText = pickString(entry, "newText", "new_string");
  if (oldText === undefined && newText === undefined) return entry;
  const next: Record<string, unknown> = { ...entry };
  if (oldText !== undefined) next.oldText = oldText;
  if (newText !== undefined) next.newText = newText;
  delete next.old_string;
  delete next.new_string;
  return next;
}

export interface NormalizeMcpToolArgsOptions {
  /** Original/expanded JSON Schema for the tool, when available. */
  schema?: unknown;
  /** `inputSchemaJson` from the MCP tool definition, when schema object is unavailable. */
  schemaJson?: string;
}

/**
 * Rewrite Cursor-native argument aliases to the Pi tool's canonical names.
 * Safe to call for every MCP exec; unknown tools are returned unchanged.
 */
export function normalizeMcpToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  options: NormalizeMcpToolArgsOptions = {},
): Record<string, unknown> {
  const key = toolCompatKey(toolName);
  if (key === "write") {
    if (typeof args.content === "string") {
      if ("contents" in args) {
        const { contents: _ignored, ...rest } = args;
        return rest;
      }
      return args;
    }
    if (typeof args.contents === "string") {
      const { contents, ...rest } = args;
      return { ...rest, content: contents };
    }
    return args;
  }

  if (key === "edit") {
    const schema = options.schema ?? parseToolSchemaJson(options.schemaJson);
    const usesEdits = schemaHasEditsProperty(schema);
    const next: Record<string, unknown> = { ...args };

    if (Array.isArray(next.edits)) {
      next.edits = next.edits.map(normalizeEditEntry);
      delete next.old_string;
      delete next.new_string;
      return next;
    }

    const oldText = pickString(next, "oldText", "old_string");
    const newText = pickString(next, "newText", "new_string");
    if (oldText === undefined || newText === undefined) return next;

    delete next.old_string;
    delete next.new_string;

    // Pi's edit contract is `edits[]`. Flat Cursor StrReplace calls become one entry.
    // Flat custom edit tools keep top-level oldText/newText.
    if (usesEdits || schema === undefined) {
      delete next.oldText;
      delete next.newText;
      next.edits = [{ oldText, newText }];
      return next;
    }

    next.oldText = oldText;
    next.newText = newText;
    return next;
  }

  return args;
}
