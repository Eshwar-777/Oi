import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { isPlainObject } from "../utils.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { jsonResult } from "./tools/common.js";

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  unknown,
  unknown,
];
type ToolExecuteArgsLegacy = [string, unknown, unknown, unknown, AbortSignal | undefined];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  params: unknown;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [, params] = args;
    return { params };
  }
  const [, params] = args;
  return { params };
}

export function toBrowserClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { params } = splitToolExecuteArgs(args);
        const paramsRecord = isPlainObject(params) ? params : {};
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
