import { ApiError, validateToolSchema } from "./validate.ts";
import { upstreamChat } from "./upstream.ts";
import type { Registry, CatalogEntry } from "./registry.ts";
import type { ApprovalService } from "./approvals.ts";
import type { ActivityStore, ActivityRecord, ToolCallRecord } from "./activity.ts";
import type { BridgeSettings } from "./types.ts";

export interface BridgeRunResult {
  response: Record<string, unknown>;
  activity: ActivityRecord;
  content: string;
}

interface RunParams {
  body: any;
  registry: Registry;
  settings: BridgeSettings;
  approvals: ApprovalService;
  activity: ActivityStore;
}

function parseArguments(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mentions(messages: any[], server: CatalogEntry): boolean {
  const haystack = messages
    .filter((message) => message?.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n")
    .toLowerCase();
  return haystack.includes(`@${server.serverName.toLowerCase()}`) || haystack.includes(`@${server.serverId}`);
}

/**
 * Runs an OpenAI chat request against llama-server, injecting the MCP tool catalog and
 * executing any tool calls the model makes before returning a single assistant message.
 */
export async function runChat(params: RunParams): Promise<BridgeRunResult> {
  const { body, registry, settings, approvals, activity } = params;
  if (!body || typeof body !== "object") throw new ApiError("MCP_INVALID_CONFIG", "Request body must be a JSON object");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError("MCP_INVALID_CONFIG", "messages array is required");
  }

  const messages: any[] = body.messages.map((message: any) => ({ ...message }));
  const stream = body.stream === true;
  const model = typeof body.model === "string" && body.model ? body.model : settings.model;

  const usable = registry.injectable().filter((entry) => entry.visibility !== "hidden_until_mentioned" || mentions(messages, entry));
  const clientTools: any[] = Array.isArray(body.tools) ? body.tools.slice() : [];
  const usedNames = new Set<string>(
    clientTools.map((tool) => String(tool?.function?.name ?? "")).filter((name) => name.length > 0),
  );

  const mapping = new Map<string, CatalogEntry>();
  const injected: any[] = [];
  for (const entry of usable) {
    let name = entry.exposedName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${entry.exposedName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mapping.set(name, { ...entry, exposedName: name });
    injected.push({
      type: "function",
      function: {
        name,
        description: entry.description || `${entry.toolName} (from ${entry.serverName})`,
        parameters: validateToolSchema(entry.inputSchema),
      },
    });
  }

  const record = activity.create({ model: model || "(server default)", stream, injectedTools: injected.length });
  const tools = [...clientTools, ...injected];
  const seenResults = new Map<string, string>();
  let content = "";
  let lastContent = "";
  let foreignToolCalls: any[] | null = null;
  let exhausted = false;

  try {
    for (let round = 0; round < settings.maxRounds; round += 1) {
      const payload: Record<string, unknown> = { ...body, messages, stream: false };
      delete payload.stream_options;
      if (model) payload.model = model;
      if (tools.length) {
        payload.tools = tools;
        payload.tool_choice = body.tool_choice ?? "auto";
      } else {
        delete payload.tools;
        delete payload.tool_choice;
      }

      const data = await upstreamChat(settings.baseUrl, payload, settings.requestTimeoutMs);
      const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
      if (!choice) throw new Error("UPSTREAM_ERROR: llama-server response contained no choices");
      const message = choice.message ?? {};
      const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      lastContent = typeof message.content === "string" ? message.content : "";

      const usage = data.usage ?? {};
      record.usage.prompt_tokens += Number(usage.prompt_tokens ?? 0);
      record.usage.completion_tokens += Number(usage.completion_tokens ?? 0);
      record.usage.total_tokens += Number(usage.total_tokens ?? 0);

      const roundRecord = {
        index: round,
        finishReason: String(choice.finish_reason ?? ""),
        toolCalls: [] as ToolCallRecord[],
        assistantChars: lastContent.length,
      };
      record.rounds.push(roundRecord);

      if (!toolCalls.length) {
        content = lastContent;
        break;
      }

      const foreign = toolCalls.filter((call) => !mapping.has(String(call?.function?.name ?? "")));
      if (foreign.length) {
        // These belong to tools the caller declared; hand them back so the client can run them.
        content = lastContent;
        foreignToolCalls = toolCalls;
        break;
      }

      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

      for (const call of toolCalls) {
        const name = String(call?.function?.name ?? "");
        const entry = mapping.get(name) as CatalogEntry;
        const args = parseArguments(call?.function?.arguments);
        const key = `${entry.serverId}::${entry.toolName}::${JSON.stringify(args)}`;
        const startedAt = Date.now();

        if (seenResults.has(key)) {
          roundRecord.toolCalls.push({
            name,
            serverId: entry.serverId,
            toolName: entry.toolName,
            args: JSON.stringify(args).slice(0, 400),
            permission: entry.permission,
            status: "skipped",
            durationMs: 0,
            result: "duplicate call suppressed",
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: `Duplicate of an earlier call in this request. Previous result:\n${seenResults.get(key)}`,
          });
          continue;
        }

        let approved = true;
        if (entry.permission === "ask") {
          approved = await approvals.request({
            serverId: entry.serverId,
            serverName: entry.serverName,
            tool: entry.toolName,
            exposedName: name,
            args: JSON.stringify(args).slice(0, 600),
          });
        }

        let text: string;
        let status: ToolCallRecord["status"];
        if (!approved) {
          text = "Permission denied: the user declined this tool call. Do not retry it without asking.";
          status = "denied";
        } else {
          try {
            const result = await registry.callTool(entry.serverId, entry.toolName, args, settings.toolTimeoutMs);
            text = result.isError ? `Tool reported an error:\n${result.text}` : result.text;
            status = result.isError ? "error" : "ok";
          } catch (error) {
            text = `Tool execution failed: ${(error as Error).message}`;
            status = "error";
          }
        }

        seenResults.set(key, text);
        roundRecord.toolCalls.push({
          name,
          serverId: entry.serverId,
          toolName: entry.toolName,
          args: JSON.stringify(args).slice(0, 400),
          permission: entry.permission,
          status,
          durationMs: Date.now() - startedAt,
          result: text.slice(0, 800),
        });
        messages.push({ role: "tool", tool_call_id: call.id, name, content: text });
      }

      if (round === settings.maxRounds - 1) exhausted = true;
    }
  } catch (error) {
    activity.finish(record, (error as Error).message);
    throw error;
  }

  if (!content && !foreignToolCalls) {
    content = lastContent || (exhausted ? "Stopped: reached the maximum number of tool-call rounds." : "");
  }

  const message: Record<string, unknown> = foreignToolCalls
    ? { role: "assistant", content: content || null, tool_calls: foreignToolCalls }
    : { role: "assistant", content };
  const usage = record.usage;
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  const response: Record<string, unknown> = {
    id: `chatcmpl-bridge-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "mcp-bridge",
    choices: [{ index: 0, message, finish_reason: foreignToolCalls ? "tool_calls" : "stop" }],
    usage,
    x_mcp_bridge: {
      activity_id: record.id,
      rounds: record.rounds.length,
      injected_tools: injected.length,
      tool_calls: record.rounds.reduce((total, round) => total + round.toolCalls.length, 0),
    },
  };

  record.finalChars = content.length;
  activity.finish(record);
  return { response, activity: record, content };
}
