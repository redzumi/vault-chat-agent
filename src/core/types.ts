export type ChatIntent = "ask" | "edit";
export type ChatRunMode = "direct" | "plan";
export type ChatSearchScopeMode = "vault" | "current-note" | "current-folder";

export interface ChatSearchScope {
  mode: ChatSearchScopeMode;
  path?: string;
}

export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  intent: ChatIntent;
}

export interface ExternalMcpServerSettings {
  id: string;
  name: string;
  provider: "custom" | "firecrawl";
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  apiKey?: string;
  enabled: boolean;
}

export type MediaImportOverwriteMode = "rename" | "overwrite" | "skip";
export type MediaImportStatus = "queued" | "uploading" | "converting" | "saving" | "done" | "error" | "canceled";

export interface ObsidianAIAssistantSettings {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
  chunkSize: number;
  overlapSize: number;
  topK: number;
  realtimeIndexing: boolean;
  defaultIntent: ChatIntent;
  systemPrompt: string;
  stripReasoningBlocks: boolean;
  collapseThinkingByDefault: boolean;
  developerMode: boolean;
  mediaImportFolder: string;
  markitdownApiBaseUrl: string;
  markitdownUsername: string;
  markitdownPassword: string;
  mediaImportConcurrency: number;
  mediaImportOverwriteMode: MediaImportOverwriteMode;
  externalMcpServers: ExternalMcpServerSettings[];
  savedPrompts: SavedPrompt[];
}

export interface MediaImportItem {
  id: string;
  file: File;
  originalName: string;
  size: number;
  status: MediaImportStatus;
  message: string;
  outputPath?: string;
  error?: string;
  warning?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  type: "agent-start" | "model-request" | "model-response" | "model-error" | "tool-call" | "tool-result" | "agent-final";
  summary: string;
  data: unknown;
}

export type IndexedFileStatus = "indexed" | "metadata-only" | "error";

export interface IndexedDocument {
  path: string;
  basename: string;
  extension: string;
  status: IndexedFileStatus;
  chunkCount: number;
  size: number;
  created: number;
  modified: number;
  tags: string[];
  headings: string[];
  links: string[];
  aliases: string[];
  frontmatterKeys: string[];
  error?: string;
}

export interface IndexedChunk {
  id: string;
  filePath: string;
  fileExtension: string;
  content: string;
  startOffset: number;
  endOffset: number;
  headings: string[];
  tags: string[];
  modified: number;
}

export interface SearchResult {
  chunk: IndexedChunk;
  score: number;
}

export interface AgentToolExecution {
  content: string;
  sources?: SearchResult[];
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
  workingSetItems?: WorkingSetItem[];
}

export interface AgentToolExecutor {
  execute(toolName: string, args: Record<string, unknown>, context?: McpToolCallContext): Promise<AgentToolExecution>;
  applyEdit(edit: PendingEdit): Promise<void>;
}

export type McpToolCapability = "read" | "propose_edit" | "apply_edit";

export interface McpToolDefinition {
  name: string;
  description: string;
  capability: McpToolCapability;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallContext {
  intent: ChatIntent;
  runMode?: ChatRunMode;
  searchScope?: ChatSearchScope;
  pendingEdits: Array<Pick<PendingEdit, "id" | "path" | "kind" | "summary">>;
  allowedCapabilities: McpToolCapability[];
  externalToolNames?: string[];
}

export interface McpToolServer {
  listTools(context: McpToolCallContext): McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>, context: McpToolCallContext): Promise<AgentToolExecution>;
}

export interface AgentCompletion {
  answer: string;
  sources: SearchResult[];
  pendingEdits: PendingEdit[];
  workingSet: WorkingSetItem[];
}

export type WorkingSetRole = "current" | "searched" | "opened" | "listed" | "linked" | "edited" | "web";

export interface WorkingSetItem {
  path: string;
  role: WorkingSetRole;
  detail: string;
}

export interface PendingEdit {
  id: string;
  path: string;
  kind: "create" | "full" | "patch";
  summary: string;
  originalContent: string;
  newContent: string;
  find?: string;
  replace?: string;
  createdAt: number;
}

export interface IndexCoverage {
  totalFiles: number;
  indexedFiles: number;
  metadataOnlyFiles: number;
  errorFiles: number;
  chunkCount: number;
}

export interface PersistedIndex {
  version: number;
  documents: IndexedDocument[];
  chunks: IndexedChunk[];
  updatedAt: number;
}

export const DEFAULT_SETTINGS: ObsidianAIAssistantSettings = {
  apiKey: "",
  model: "gpt-4o-mini",
  apiBaseUrl: "https://api.openai.com",
  chunkSize: 900,
  overlapSize: 120,
  topK: 6,
  realtimeIndexing: true,
  defaultIntent: "ask",
  stripReasoningBlocks: true,
  collapseThinkingByDefault: false,
  developerMode: false,
  mediaImportFolder: "Imported Media",
  markitdownApiBaseUrl: "https://markitdown.redz.sbs",
  markitdownUsername: "",
  markitdownPassword: "",
  mediaImportConcurrency: 2,
  mediaImportOverwriteMode: "rename",
  savedPrompts: [],
  systemPrompt: "Assume the user is not a developer. Explain technical details in plain language, avoid unnecessary implementation jargon, and ask before expecting them to make code-level decisions.",
  externalMcpServers: [],
};
