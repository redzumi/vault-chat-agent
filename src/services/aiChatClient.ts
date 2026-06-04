import { AgentCompletion, ChatIntent, ChatSearchScope, DebugLogEntry, McpToolCallContext, McpToolDefinition, McpToolServer, ObsidianAIAssistantSettings, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { OpenAiCompatibleAdapter } from "../providers/openAiCompatibleAdapter";
import { ChatProviderAdapter, ProviderAssistantMessage, ProviderMessage } from "../providers/types";

type DebugLogger = (entry: DebugLogEntry) => void;

export interface AgentRuntimeMetadata {
  currentDateIso: string;
  currentDate: string;
  currentTime: string;
  isoTimestamp: string;
  timeZone: string;
  utcOffset: string;
  locale: string;
  languages: string[];
  platform: string;
  location: string;
}

export class AIChatClient {
  private readonly providerAdapter: ChatProviderAdapter = new OpenAiCompatibleAdapter();

  constructor(
    private readonly getSettings: () => ObsidianAIAssistantSettings,
    private readonly getVaultOverview: () => string,
    private readonly getRuntimeMetadata: () => AgentRuntimeMetadata = createRuntimeMetadata,
  ) {}

  async completeWithAgent(
    userMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    mcpServer: McpToolServer,
    intent: ChatIntent,
    logDebug?: DebugLogger,
    context: McpToolCallContext = { intent, pendingEdits: [], allowedCapabilities: ["read"] },
    signal?: AbortSignal,
  ): Promise<AgentCompletion> {
    const messages: ProviderMessage[] = [
      { role: "system", content: this.buildAgentSystemPrompt(intent, context) },
      ...history.slice(-8).map((message) => ({ role: message.role, content: message.content }) satisfies ProviderMessage),
      { role: "user", content: userMessage },
    ];
    const toolDefinitions = mcpServer.listTools(context);
    const sources = new Map<string, SearchResult>();
    const pendingEdits: PendingEdit[] = [];
    const workingSet = new Map<string, WorkingSetItem>();

    emitDebug(logDebug, "agent-start", `Started ${intent} request`, {
      intent,
      runMode: context.runMode ?? "direct",
      userMessage,
      historyLength: history.length,
      context,
      tools: toolDefinitions.map((tool) => tool.name),
      messages,
    });

    for (let step = 0; step < 30; step += 1) {
      throwIfAborted(signal);
      const assistantMessage = await this.requestCompletion(messages, toolDefinitions, 8000, logDebug, step + 1, signal);
      const toolCalls = assistantMessage.toolCalls;
      const content = assistantMessage.content.trim();

      if (toolCalls.length === 0) {
        const answer = this.cleanAssistantContent(content);
        emitDebug(logDebug, "agent-final", "Model returned final answer", {
          step: step + 1,
          answer,
          sources: Array.from(sources.values()),
          pendingEdits,
          workingSet: Array.from(workingSet.values()),
        });
        return { answer, sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
      }

      messages.push({
        role: "assistant",
        content: assistantMessage.content || null,
        reasoning: assistantMessage.reasoning,
        reasoningContent: assistantMessage.reasoningContent,
        reasoningDetails: assistantMessage.reasoningDetails,
        toolCalls,
      });

      for (const toolCall of toolCalls) {
        throwIfAborted(signal);
        const args = parseToolArguments(toolCall.argumentsJson);
        emitDebug(logDebug, "tool-call", `Calling ${toolCall.name}`, {
          step: step + 1,
          toolCall,
          args,
        });

        const result = limitToolResult(await mcpServer.callTool(toolCall.name, args, context));
        emitDebug(logDebug, "tool-result", `Tool result from ${toolCall.name}`, {
          step: step + 1,
          tool: toolCall.name,
          result,
        });

        for (const source of result.sources ?? []) {
          sources.set(source.chunk.id, source);
          mergeWorkingSetItem(workingSet, {
            path: source.chunk.filePath,
            role: "searched",
            detail: `Used by ${toolCall.name}`,
          });
        }
        if (result.pendingEdit) {
          pendingEdits.push(result.pendingEdit);
        }
        for (const pendingEdit of result.pendingEdits ?? []) {
          pendingEdits.push(pendingEdit);
        }
        for (const item of result.workingSetItems ?? []) {
          mergeWorkingSetItem(workingSet, item);
        }

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify(summarizeToolResult(result)),
        });
      }
    }

    messages.push({
      role: "user",
      content:
        pendingEdits.length > 0
          ? "Stop using tools and summarize the pending edits now."
          : "Stop using tools and provide the best final answer now. If you were creating a long note and have not finished it, say it was not completed.",
    });
    const finalMessage = await this.requestCompletion(messages, toolDefinitions, 1800, logDebug, 31, signal);
    const answer = this.cleanAssistantContent(finalMessage.content.trim());
    emitDebug(logDebug, "agent-final", "Agent stopped after step limit", {
      answer,
      sources: Array.from(sources.values()),
      pendingEdits,
      workingSet: Array.from(workingSet.values()),
    });
    return { answer, sources: Array.from(sources.values()), pendingEdits, workingSet: Array.from(workingSet.values()) };
  }

  private async requestCompletion(messages: ProviderMessage[], toolDefinitions: McpToolDefinition[], maxTokens: number, logDebug?: DebugLogger, step?: number, signal?: AbortSignal): Promise<ProviderAssistantMessage> {
    const settings = this.getSettings();
    if (this.requiresApiKey(settings) && !settings.apiKey.trim()) {
      emitDebug(logDebug, "model-error", "Request blocked because the API key is not configured", {
        step,
        apiBaseUrl: settings.apiBaseUrl,
        model: settings.model,
      });
      throw new Error("AI provider API key is not configured.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.apiKey.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const startedAt = Date.now();
    const request = this.providerAdapter.createRequest(settings, messages, toolDefinitions, maxTokens);
    emitDebug(logDebug, "model-request", `Request ${step ?? "?"} to ${settings.model}`, {
      step,
      provider: this.providerAdapter.name,
      url: request.url,
      body: request.body,
    });

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal,
      });
    } catch (error) {
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} failed before a response`, {
        step,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} failed with ${response.status}`, {
        step,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorText,
      });
      throw new Error(`AI provider request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const message = this.providerAdapter.parseResponse(data);
    if (!message) {
      emitDebug(logDebug, "model-error", `Request ${step ?? "?"} returned an unexpected response`, {
        step,
        durationMs: Date.now() - startedAt,
        response: data,
      });
      throw new Error("AI provider returned an unexpected response.");
    }

    emitDebug(logDebug, "model-response", `Response ${step ?? "?"} from ${settings.model}`, {
      step,
      status: response.status,
      durationMs: Date.now() - startedAt,
      message: message.raw,
      response: data,
    });

    return message;
  }

  private requiresApiKey(settings: ObsidianAIAssistantSettings): boolean {
    try {
      const url = new URL(settings.apiBaseUrl);
      return !["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
    } catch {
      return true;
    }
  }

  private buildAgentSystemPrompt(intent: ChatIntent, context: McpToolCallContext): string {
    const customSystemPrompt = this.getSettings().systemPrompt.trim();
    const runtimeMetadata = this.getRuntimeMetadata();
    const pendingEdits = context.pendingEdits;
    const pendingEditsCanBeApplied = context.allowedCapabilities.includes("apply_edit");
    const searchScope = describeSearchScope(context.searchScope);
    const isPlanMode = intent === "edit" && context.runMode === "plan";
    const externalTools = context.externalToolNames ?? [];
    const editPolicy =
      isPlanMode
        ? [
            "You are in Plan mode. You may inspect the vault with read-only tools, but you must not propose edits or create pending edits.",
            "Before answering, gather the context needed to make a realistic plan.",
            "Return a concrete plan only. Include files to inspect or change, proposed edits at a high level, risks, and any open questions.",
            "Do not use wording that implies edits have already been prepared.",
            "Tell the user to run the next message outside Plan mode when they want pending edits prepared.",
          ]
        : intent === "edit"
        ? [
            "You may propose file creation or edits with available edit tools.",
            "You cannot directly apply newly proposed edits. Proposed edits stay pending until the user reviews or explicitly asks to apply them.",
            "For long new notes, use beginNewNote, then appendNewNote with chunks under 2000 characters each, then finishNewNote.",
            "Use proposeNewNote only for short new notes.",
            "Prefer proposePatch for one normal edit and proposePatchBatch for multiple normal edits. Use proposeEdit only when the user asks to rewrite a full file or the patch would be larger than the original file.",
            "Before proposePatch, proposePatchBatch, or proposeEdit, open each target file unless the exact current content is already available in the conversation.",
            "For proposePatch and proposePatchBatch, every find must be an exact substring from the current file and specific enough to match once.",
            "For proposeEdit, newContent must be the complete replacement content for the file, not a partial patch.",
          ]
        : [
            "You are in Ask mode. Do not propose new pending edits.",
            "If the user asks for file changes, explain what you would change and ask them to switch to Edit mode.",
          ];

    return [
      "You are an AI agent inside Obsidian.",
      "Runtime metadata is authoritative for the user's current date, time, locale, language, platform, and location context. Do not rely on model training-time dates when answering current-date or time-sensitive requests.",
      "Runtime metadata:",
      JSON.stringify(runtimeMetadata, null, 2),
      isPlanMode
        ? "You can inspect the user's vault with read-only tools before returning a plan."
        : intent === "edit"
          ? "You can inspect the user's vault and propose reviewed file edits with tools before answering."
          : "You can inspect the user's vault with read-only tools before answering.",
      "Use tools when the answer needs more context than the current conversation.",
      "When the user asks about an HTTP/HTTPS URL, use readUrl before answering unless the page content is already present in the conversation.",
      "When the user asks about a YouTube URL or video transcript, use readYouTubeTranscript before answering. If transcript extraction fails, say that captions were unavailable or could not be fetched.",
      externalTools.length > 0 ? `External MCP tools are available for this turn: ${externalTools.join(", ")}. Use them when they fit the user's request.` : "",
      searchScope ? `Current search scope: ${searchScope}. Keep searchNotes results within this scope unless the user explicitly asks to broaden it.` : "",
      "Cite file paths when using vault content.",
      "If the vault does not contain enough information, say so clearly.",
      "Do not say you will inspect, search, open, create, patch, or edit something later. If that action is needed, call a tool in the same response.",
      "Apply existing pending edits only when the user explicitly asks to apply them.",
      pendingEdits.length > 0 && !pendingEditsCanBeApplied
        ? "Current pending edits cannot be applied by tools in this turn because the user has not enabled apply permission. If the user asks to apply them, tell them to use the visible Apply buttons or enable Allow apply for the next message."
        : "",
      ...editPolicy,
      ...(pendingEdits.length > 0
        ? [
            "",
            "Current pending edits:",
            ...pendingEdits.map((edit, index) => `${index + 1}. id=${edit.id}; kind=${edit.kind}; path=${edit.path}; summary=${edit.summary}`),
          ]
        : []),
      ...(customSystemPrompt ? ["", "Additional user instructions:", customSystemPrompt] : []),
      "",
      "VAULT INDEX OVERVIEW:",
      this.getVaultOverview(),
    ].join("\n");
  }

  private cleanAssistantContent(content: string): string {
    if (!this.getSettings().stripReasoningBlocks) {
      return content;
    }
    return stripReasoningBlocks(content).trim();
  }
}

export function createRuntimeMetadata(now = new Date()): AgentRuntimeMetadata {
  const locale = getPrimaryLocale();
  const timeZone = getTimeZone();
  const languages = getLanguages(locale);
  return {
    currentDateIso: formatDateIso(now, timeZone),
    currentDate: formatDate(now, locale, timeZone),
    currentTime: formatTime(now, locale, timeZone),
    isoTimestamp: now.toISOString(),
    timeZone,
    utcOffset: formatUtcOffset(now, timeZone),
    locale,
    languages,
    platform: getPlatform(),
    location: timeZone,
  };
}

function getPrimaryLocale(): string {
  const navigatorLike = getNavigatorLike();
  return navigatorLike?.language || Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

function getLanguages(locale: string): string[] {
  const languages = getNavigatorLike()?.languages?.filter(Boolean);
  return languages && languages.length > 0 ? Array.from(new Set(languages)) : [locale];
}

function getTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getPlatform(): string {
  return getNavigatorLike()?.platform || "unknown";
}

function getNavigatorLike(): { language?: string; languages?: readonly string[]; platform?: string } | undefined {
  return typeof globalThis.navigator === "object" ? globalThis.navigator : undefined;
}

function formatDate(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeZone,
  }).format(date);
}

function formatTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeStyle: "long",
    timeZone,
  }).format(date);
}

function formatDateIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function formatUtcOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value.replace("GMT", "UTC");
  return offset || "UTC";
}

function stripReasoningBlocks(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, "");
}

function describeSearchScope(searchScope: ChatSearchScope | undefined): string {
  if (!searchScope || searchScope.mode === "vault") {
    return "whole vault";
  }
  if (searchScope.mode === "current-note" && searchScope.path) {
    return `current note (${searchScope.path})`;
  }
  if (searchScope.mode === "current-folder" && searchScope.path) {
    return `current folder (${searchScope.path})`;
  }
  return "";
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  if (!rawArguments.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeToolResult(result: {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
  workingSetItems?: WorkingSetItem[];
}): Record<string, unknown> {
  return {
    content: result.content,
    sources: result.sources?.map((source) => ({
      path: source.chunk.filePath,
      score: source.score,
      snippet: source.chunk.content.slice(0, 1200),
    })),
    pendingEdit: result.pendingEdit ? summarizePendingEdit(result.pendingEdit) : undefined,
    pendingEdits: result.pendingEdits?.map(summarizePendingEdit),
    workingSetItems: result.workingSetItems,
  };
}

function limitToolResult(result: {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
  workingSetItems?: WorkingSetItem[];
}): {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
  workingSetItems?: WorkingSetItem[];
} {
  return {
    ...result,
    content: truncateText(result.content, 6000),
    sources: result.sources?.slice(0, 10).map((source) => ({
      ...source,
      chunk: {
        ...source.chunk,
        content: truncateText(source.chunk.content, 1800),
      },
    })),
    pendingEdits: result.pendingEdits?.slice(0, 20),
    workingSetItems: result.workingSetItems?.slice(0, 40),
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Request cancelled.", "AbortError");
  }
}

function summarizePendingEdit(edit: PendingEdit): Pick<PendingEdit, "id" | "path" | "kind" | "summary"> {
  return {
    id: edit.id,
    path: edit.path,
    kind: edit.kind,
    summary: edit.summary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDebug(logDebug: DebugLogger | undefined, type: DebugLogEntry["type"], summary: string, data: unknown): void {
  if (!logDebug) {
    return;
  }

  logDebug({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    type,
    summary,
    data,
  });
}

function mergeWorkingSetItem(workingSet: Map<string, WorkingSetItem>, item: WorkingSetItem): void {
  const key = `${item.path}:${item.role}`;
  const existing = workingSet.get(key);
  if (!existing) {
    workingSet.set(key, item);
    return;
  }

  if (!existing.detail.includes(item.detail)) {
    workingSet.set(key, { ...existing, detail: `${existing.detail}; ${item.detail}` });
  }
}
