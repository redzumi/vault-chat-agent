import { McpToolDefinition, ObsidianAIAssistantSettings } from "../core/types";

export interface ProviderToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ProviderAssistantMessage {
  content: string;
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: unknown;
  toolCalls: ProviderToolCall[];
  raw: unknown;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: unknown;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderRequest {
  url: string;
  body: unknown;
}

export interface ChatProviderAdapter {
  name: string;
  createRequest(settings: ObsidianAIAssistantSettings, messages: ProviderMessage[], tools: McpToolDefinition[], maxTokens: number, stream?: boolean): ProviderRequest;
  parseResponse(data: unknown): ProviderAssistantMessage | null;
}
