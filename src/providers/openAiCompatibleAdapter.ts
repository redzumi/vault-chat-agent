import { McpToolDefinition, ObsidianAIAssistantSettings } from "../core/types";
import { buildOpenAiCompatibleEndpointUrl } from "./endpoints";
import { ChatProviderAdapter, ProviderAssistantMessage, ProviderMessage, ProviderRequest } from "./types";

export class OpenAiCompatibleAdapter implements ChatProviderAdapter {
  readonly name = "openai-compatible";

  createRequest(settings: ObsidianAIAssistantSettings, messages: ProviderMessage[], tools: McpToolDefinition[], maxTokens: number, stream = false): ProviderRequest {
    const url = buildOpenAiCompatibleEndpointUrl(settings.apiBaseUrl, "chat/completions");
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map(toOpenAiTool),
      temperature: 0.2,
      max_tokens: maxTokens,
      stream,
    };
    if (supportsToolChoice(settings.apiBaseUrl)) {
      body.tool_choice = "auto";
    }

    return {
      url,
      body,
    };
  }

  parseResponse(data: unknown): ProviderAssistantMessage | null {
    if (!isRecord(data)) {
      return null;
    }

    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
      return null;
    }

    const message = choices[0].message;
    if (!isRecord(message) || message.role !== "assistant") {
      return null;
    }

    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning === "string" ? message.reasoning : undefined;
    const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
    const reasoningDetails = message.reasoning_details;
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap((toolCall) => {
          if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !isRecord(toolCall.function)) {
            return [];
          }
          const name = toolCall.function.name;
          const argumentsJson = toolCall.function.arguments;
          if (typeof name !== "string" || typeof argumentsJson !== "string") {
            return [];
          }
          return [{ id: toolCall.id, name, argumentsJson }];
        })
      : [];

    return {
      content,
      reasoning,
      reasoningContent,
      reasoningDetails,
      toolCalls,
      raw: message,
    };
  }
}

function toOpenAiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    const providerMessage: Record<string, unknown> = {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsJson,
        },
      })),
    };
    if (message.reasoningContent !== undefined) {
      providerMessage.reasoning_content = message.reasoningContent;
    }
    if (message.reasoning !== undefined) {
      providerMessage.reasoning = message.reasoning;
    }
    if (message.reasoningDetails !== undefined) {
      providerMessage.reasoning_details = message.reasoningDetails;
    }
    return providerMessage;
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toOpenAiTool(tool: McpToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function supportsToolChoice(apiBaseUrl: string): boolean {
  try {
    const url = new URL(apiBaseUrl);
    return !(["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) && url.port === "11434");
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
