import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";

import {
  McpArgsSchema,
  type ExecServerMessage,
} from "../src/proto/agent_pb.js";
import {
  expandToolSchemaForCursorAliases,
  normalizeMcpToolArgs,
} from "../src/stream/mcp-arg-compat.js";
import { buildMcpToolDefinitions, encodeMcpArgsMap } from "../src/stream/request-build.js";
import { __testInternals as server } from "../src/stream/server-messages.js";

describe("Cursor MCP arg aliases", () => {
  it("accepts Write contents as an alias in the advertised schema", () => {
    const schema = expandToolSchemaForCursorAliases("write", {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    }) as any;

    expect(schema.properties.contents.type).toBe("string");
    expect(schema.required).toEqual(["path"]);
    expect(schema.anyOf).toContainEqual({ required: ["content"] });
    expect(schema.anyOf).toContainEqual({ required: ["contents"] });
  });

  it("normalizes write contents to content", () => {
    expect(
      normalizeMcpToolArgs("write", {
        path: "a.txt",
        contents: "hello",
      }),
    ).toEqual({ path: "a.txt", content: "hello" });
    expect(
      normalizeMcpToolArgs("Write", {
        path: "a.txt",
        content: "hello",
        contents: "ignored-when-content-present",
      }),
    ).toEqual({ path: "a.txt", content: "hello" });
  });

  it("normalizes edit old_string aliases and flat StrReplace shape", () => {
    expect(
      normalizeMcpToolArgs("edit", {
        path: "a.txt",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toEqual({
      path: "a.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(
      normalizeMcpToolArgs(
        "edit",
        {
          path: "a.txt",
          old_string: "a",
          new_string: "b",
        },
        {
          schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              edits: { type: "array" },
            },
          },
        },
      ),
    ).toEqual({
      path: "a.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(
      normalizeMcpToolArgs(
        "edit",
        {
          path: "a.txt",
          old_string: "a",
          new_string: "b",
        },
        {
          schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              oldText: { type: "string" },
              newText: { type: "string" },
            },
          },
        },
      ),
    ).toEqual({
      path: "a.txt",
      oldText: "a",
      newText: "b",
    });
  });

  it("publishes write contents through buildMcpToolDefinitions", () => {
    const [tool] = buildMcpToolDefinitions([
      {
        type: "function",
        function: {
          name: "write",
          description: "Write a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      },
    ]);
    const schema = toJson(ValueSchema, tool!.inputSchema!) as any;
    expect(schema.properties.contents).toBeDefined();
    expect(schema.anyOf).toEqual([{ required: ["content"] }, { required: ["contents"] }]);
  });

  it("rewrites contents on live mcpArgs before Pi dispatch", () => {
    const tools = buildMcpToolDefinitions([
      {
        type: "function",
        function: {
          name: "write",
          description: "Write a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      },
    ]);
    const onMcp = vi.fn();
    const exec = {
      id: 7,
      execId: "exec-7",
      message: {
        case: "mcpArgs",
        value: create(McpArgsSchema, {
          name: "pi-mcp_pi_write",
          toolName: "mcp_pi_write",
          toolCallId: "call-1",
          args: encodeMcpArgsMap({
            path: ".tmp-alias.txt",
            contents: "from-cursor-write",
          }),
        }),
      },
    } as ExecServerMessage;

    expect(server.handleExecMessageInner(exec, tools, () => undefined, onMcp)).toBe(true);
    expect(onMcp).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onMcp.mock.calls[0]![0].decodedArgs)).toEqual({
      path: ".tmp-alias.txt",
      content: "from-cursor-write",
    });
    expect(onMcp.mock.calls[0]![0].toolName).toBe("write");
  });
});
