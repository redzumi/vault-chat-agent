import { AgentToolExecution, AgentToolExecutor, McpToolCallContext, McpToolDefinition, McpToolServer, PendingEdit } from "../core/types";
import { RemoteMcpManager } from "./remoteMcpClient";

type ApplyPendingEdit = (id: string) => Promise<AgentToolExecution>;
type ApplyAllPendingEdits = () => Promise<AgentToolExecution>;

export class ObsidianMcpServer implements McpToolServer {
  constructor(
    private readonly agentTools: AgentToolExecutor,
    private readonly applyPendingEdit: ApplyPendingEdit,
    private readonly applyAllPendingEdits: ApplyAllPendingEdits,
    private readonly remoteMcpManager?: RemoteMcpManager,
  ) {}

  listTools(context: McpToolCallContext): McpToolDefinition[] {
    const isPlanMode = context.intent === "edit" && context.runMode === "plan";
    return [
      ...READ_ONLY_TOOLS,
      ...(context.externalToolNames ? this.remoteMcpManager?.listTools().filter((tool) => context.externalToolNames?.includes(tool.name)) ?? [] : []),
      ...(!isPlanMode && context.pendingEdits.length > 0 ? APPLY_TOOLS : []),
      ...(!isPlanMode && context.intent === "edit" ? EDIT_TOOLS : []),
    ].filter((tool) => context.allowedCapabilities.includes(tool.capability));
  }

  async callTool(name: string, args: Record<string, unknown>, context: McpToolCallContext): Promise<AgentToolExecution> {
    const tool = this.listTools(context).find((candidate) => candidate.name === name);
    if (!tool) {
      return { content: `Tool ${name} is not available in ${context.intent === "ask" ? "Ask" : "Edit"} mode.` };
    }

    const validationError = validateToolArgs(args, tool.inputSchema);
    if (validationError) {
      return { content: `Invalid arguments for ${name}: ${validationError}` };
    }

    if (READ_ONLY_TOOL_NAMES.has(name)) {
      return this.agentTools.execute(name, args, context);
    }

    if (this.remoteMcpManager?.canCallTool(name)) {
      if (!context.externalToolNames?.includes(name)) {
        return { content: `External MCP tool ${name} is not enabled for this turn.` };
      }
      return this.remoteMcpManager.callTool(name, args);
    }

    if (name === "applyPendingEdit") {
      const id = typeof args.id === "string" ? args.id : "";
      if (!context.pendingEdits.some((edit) => edit.id === id)) {
        return { content: `Pending edit not found: ${id || "(missing id)"}.` };
      }
      return this.applyPendingEdit(id);
    }

    if (name === "applyAllPendingEdits") {
      if (context.pendingEdits.length === 0) {
        return { content: "There are no pending edits to apply." };
      }
      return this.applyAllPendingEdits();
    }

    if (EDIT_TOOL_NAMES.has(name)) {
      return this.agentTools.execute(name, args, context);
    }

    return { content: `Unknown tool: ${name}.` };
  }
}

export function summarizePendingEdit(edit: PendingEdit): Pick<PendingEdit, "id" | "path" | "kind" | "summary"> {
  return {
    id: edit.id,
    path: edit.path,
    kind: edit.kind,
    summary: edit.summary,
  };
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const READ_ONLY_TOOLS: McpToolDefinition[] = [
  {
    name: "searchNotes",
    description: "Search indexed vault note chunks for relevant content.",
    capability: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", description: "Search query." },
        topK: { type: "number", description: "Maximum number of chunks to return." },
        folder: { type: "string", description: "Optional vault-relative folder path to search within." },
      },
      ["query"],
    ),
  },
  {
    name: "getCurrentNote",
    description: "Get the current active note path and metadata.",
    capability: "read",
    inputSchema: objectSchema({}),
  },
  {
    name: "openCurrentNote",
    description: "Read the current active note.",
    capability: "read",
    inputSchema: objectSchema({
      maxChars: { type: "number", description: "Maximum characters to return." },
    }),
  },
  {
    name: "openNote",
    description: "Read a specific text note or file from the vault.",
    capability: "read",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        maxChars: { type: "number", description: "Maximum characters to return." },
      },
      ["path"],
    ),
  },
  {
    name: "listFolder",
    description: "List files in a vault folder. Use an empty path for the vault root.",
    capability: "read",
    inputSchema: objectSchema({
      path: { type: "string", description: "Vault-relative folder path." },
    }),
  },
  {
    name: "getLinks",
    description: "Show outgoing links and backlinks for a file.",
    capability: "read",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
      },
      ["path"],
    ),
  },
  {
    name: "readUrl",
    description: "Fetch a public HTTP/HTTPS URL and extract readable text from HTML, text, JSON, or XML responses.",
    capability: "read",
    inputSchema: objectSchema(
      {
        url: { type: "string", description: "Public HTTP or HTTPS URL to read." },
        maxChars: { type: "number", description: "Maximum characters to return." },
      },
      ["url"],
    ),
  },
  {
    name: "readYouTubeTranscript",
    description: "Extract available captions or transcript text from a YouTube video URL.",
    capability: "read",
    inputSchema: objectSchema(
      {
        url: { type: "string", description: "YouTube video URL." },
        language: { type: "string", description: "Preferred caption language code, such as en or ru." },
        maxChars: { type: "number", description: "Maximum characters to return." },
      },
      ["url"],
    ),
  },
  {
    name: "getVaultOverview",
    description: "Show the current vault index overview.",
    capability: "read",
    inputSchema: objectSchema({}),
  },
];

const APPLY_TOOLS: McpToolDefinition[] = [
  {
    name: "applyPendingEdit",
    description: "Apply one already prepared pending edit. Use only when the user explicitly asks to apply that edit.",
    capability: "apply_edit",
    inputSchema: objectSchema(
      {
        id: { type: "string", description: "Pending edit id." },
      },
      ["id"],
    ),
  },
  {
    name: "applyAllPendingEdits",
    description: "Apply all already prepared pending edits. Use only when the user explicitly asks to apply all pending edits.",
    capability: "apply_edit",
    inputSchema: objectSchema({}),
  },
];

const EDIT_TOOLS: McpToolDefinition[] = [
  {
    name: "beginNewNote",
    description: "Start a pending new note draft for long content.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative path for the new markdown note." },
        summary: { type: "string", description: "Short summary of the new note." },
      },
      ["path"],
    ),
  },
  {
    name: "appendNewNote",
    description: "Append one content chunk to a pending new note draft.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        draftId: { type: "string", description: "Draft id returned by beginNewNote." },
        content: { type: "string", description: "Markdown content chunk." },
      },
      ["draftId", "content"],
    ),
  },
  {
    name: "finishNewNote",
    description: "Convert a completed draft into a pending new note for user review.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        draftId: { type: "string", description: "Draft id returned by beginNewNote." },
      },
      ["draftId"],
    ),
  },
  {
    name: "proposeNewNote",
    description: "Prepare a short pending new note for user review.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative path for the new markdown note." },
        summary: { type: "string", description: "Short summary of the new note." },
        content: { type: "string", description: "Full markdown note content." },
      },
      ["path", "content"],
    ),
  },
  {
    name: "proposePatch",
    description: "Prepare a small pending patch for user review.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        summary: { type: "string", description: "Short summary of the patch." },
        find: { type: "string", description: "Exact existing text to replace." },
        replace: { type: "string", description: "Replacement text." },
      },
      ["path", "find", "replace"],
    ),
  },
  {
    name: "proposePatchBatch",
    description: "Prepare multiple pending patches for user review.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        summary: { type: "string", description: "Short summary of the batch." },
        patches: {
          type: "array",
          items: objectSchema(
            {
              path: { type: "string", description: "Vault-relative file path." },
              summary: { type: "string", description: "Short summary of the patch." },
              find: { type: "string", description: "Exact existing text to replace." },
              replace: { type: "string", description: "Replacement text." },
            },
            ["path", "find", "replace"],
          ),
        },
      },
      ["patches"],
    ),
  },
  {
    name: "proposeEdit",
    description: "Prepare a complete file replacement for user review.",
    capability: "propose_edit",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Vault-relative file path." },
        summary: { type: "string", description: "Short summary of the edit." },
        newContent: { type: "string", description: "Complete replacement file content." },
      },
      ["path", "newContent"],
    ),
  },
];

const READ_ONLY_TOOL_NAMES = new Set(READ_ONLY_TOOLS.map((tool) => tool.name));
const EDIT_TOOL_NAMES = new Set(EDIT_TOOLS.map((tool) => tool.name));

function validateToolArgs(value: Record<string, unknown>, schema: Record<string, unknown>, path = "args"): string | null {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "object") {
    if (!isRecord(value)) {
      return `${path} must be an object.`;
    }

    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in value)) {
        return `${path}.${key} is required.`;
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, argValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (!isRecord(propertySchema)) {
        if (schema.additionalProperties === false) {
          return `${path}.${key} is not allowed.`;
        }
        continue;
      }
      const error = validateValue(argValue, propertySchema, `${path}.${key}`);
      if (error) {
        return error;
      }
    }
  }

  return null;
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (!type) {
    return null;
  }

  if (type === "string") {
    return typeof value === "string" ? null : `${path} must be a string.`;
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a finite number.`;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return `${path} must be an array.`;
    }
    const itemSchema = isRecord(schema.items) ? schema.items : null;
    if (!itemSchema) {
      return null;
    }
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(value[index], itemSchema, `${path}[${index}]`);
      if (error) {
        return error;
      }
    }
    return null;
  }
  if (type === "object") {
    return isRecord(value) ? validateToolArgs(value, schema, path) : `${path} must be an object.`;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
