import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentToolExecution, ExternalMcpServerSettings, McpToolDefinition } from "../core/types";

type McpClientTransport = StreamableHTTPClientTransport | StdioClientTransport;

interface RemoteMcpConnection {
  server: ExternalMcpServerSettings;
  client: Client;
  transport: McpClientTransport;
  signature: string;
}

interface RemoteToolMapping {
  connection: RemoteMcpConnection;
  originalName: string;
}

export class RemoteMcpManager {
  private readonly connections = new Map<string, RemoteMcpConnection>();
  private readonly tools = new Map<string, McpToolDefinition>();
  private readonly mappings = new Map<string, RemoteToolMapping>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly getServers: () => ExternalMcpServerSettings[]) {}

  listTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getErrors(): string[] {
    return Array.from(this.errors.entries()).map(([serverName, error]) => `${serverName}: ${error}`);
  }

  async refreshEnabledServers(): Promise<void> {
    this.tools.clear();
    this.mappings.clear();
    this.errors.clear();

    const enabledServers = this.getServers().filter((server) => server.enabled && hasConnectionTarget(server));
    const enabledIds = new Set(enabledServers.map((server) => server.id));
    for (const [serverId, connection] of this.connections.entries()) {
      if (!enabledIds.has(serverId)) {
        await closeConnection(connection);
        this.connections.delete(serverId);
      }
    }

    for (const server of enabledServers) {
      try {
        const connection = await this.getConnection(server);
        const result = await connection.client.listTools();
        for (const tool of result.tools) {
          const exposedName = createExposedToolName(server.name, tool.name);
          this.tools.set(exposedName, {
            name: exposedName,
            description: [`External MCP server: ${server.name}.`, tool.description ?? ""].filter(Boolean).join(" "),
            capability: "read",
            inputSchema: tool.inputSchema,
          });
          this.mappings.set(exposedName, {
            connection,
            originalName: tool.name,
          });
        }
      } catch (error) {
        this.errors.set(server.name || server.url, error instanceof Error ? error.message : String(error));
      }
    }
  }

  canCallTool(name: string): boolean {
    return this.mappings.has(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<AgentToolExecution> {
    const mapping = this.mappings.get(name);
    if (!mapping) {
      return { content: `External MCP tool not found: ${name}` };
    }

    try {
      const result = await mapping.connection.client.callTool({
        name: mapping.originalName,
        arguments: args,
      });
      return {
        workingSetItems: [{ path: mapping.connection.server.name, role: "web", detail: `MCP tool ${mapping.originalName}` }],
        content: formatMcpToolResult(result),
      };
    } catch (error) {
      return { content: `External MCP tool ${name} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async close(): Promise<void> {
    const connections = Array.from(this.connections.values());
    this.connections.clear();
    this.tools.clear();
    this.mappings.clear();
    await Promise.all(connections.map(closeConnection));
  }

  private async getConnection(server: ExternalMcpServerSettings): Promise<RemoteMcpConnection> {
    const existing = this.connections.get(server.id);
    const signature = getConnectionSignature(server);
    if (existing && existing.signature === signature) {
      return existing;
    }
    if (existing) {
      await closeConnection(existing);
      this.connections.delete(server.id);
    }

    const client = new Client({ name: "vault-chat-agent", version: "0.1.0" });
    const transport = createTransport(server);
    await client.connect(transport);
    const connection = { server: cloneServerSettings(server), client, transport, signature };
    this.connections.set(server.id, connection);
    return connection;
  }
}

async function closeConnection(connection: RemoteMcpConnection): Promise<void> {
  try {
    await connection.transport.close();
  } catch {
    // Closing is best-effort; stale MCP sessions should not block chat.
  }
}

function createExposedToolName(serverName: string, toolName: string): string {
  const serverPart = sanitizeToolName(serverName || "mcp").slice(0, 24) || "mcp";
  const toolPart = sanitizeToolName(toolName).slice(0, 36) || "tool";
  return `mcp_${serverPart}_${toolPart}`;
}

function getServerUrl(server: ExternalMcpServerSettings): string {
  if (server.provider === "firecrawl") {
    const apiKey = server.apiKey?.trim();
    return apiKey ? `https://mcp.firecrawl.dev/${encodeURIComponent(apiKey)}/v2/mcp` : "";
  }
  return server.url.trim();
}

function hasConnectionTarget(server: ExternalMcpServerSettings): boolean {
  if (server.provider === "firecrawl" || server.transport === "http") {
    return Boolean(getServerUrl(server));
  }
  return Boolean(server.command?.trim());
}

function createTransport(server: ExternalMcpServerSettings): McpClientTransport {
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) {
      throw new Error("MCP command is not configured.");
    }
    return new StdioClientTransport({
      command,
      args: server.args?.filter((arg) => arg.trim()).map((arg) => arg.trim()) ?? [],
      env: {
        ...getDefaultEnvironment(),
        ...sanitizeStringRecord(server.env),
      },
      stderr: "pipe",
    });
  }

  const serverUrl = getServerUrl(server);
  if (!serverUrl) {
    throw new Error("MCP server URL is not configured.");
  }
  return new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: sanitizeStringRecord(server.headers),
    },
  });
}

function getConnectionSignature(server: ExternalMcpServerSettings): string {
  return JSON.stringify({
    id: server.id,
    name: server.name,
    provider: server.provider,
    transport: server.transport,
    url: getServerUrl(server),
    headers: sanitizeStringRecord(server.headers),
    command: server.command?.trim() ?? "",
    args: server.args ?? [],
    env: sanitizeStringRecord(server.env),
  });
}

function cloneServerSettings(server: ExternalMcpServerSettings): ExternalMcpServerSettings {
  return {
    ...server,
    headers: sanitizeStringRecord(server.headers),
    args: server.args?.slice(),
    env: sanitizeStringRecord(server.env),
  };
}

function sanitizeStringRecord(value: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, itemValue] of Object.entries(value ?? {})) {
    const normalizedKey = key.trim();
    if (normalizedKey && typeof itemValue === "string") {
      result[normalizedKey] = itemValue;
    }
  }
  return result;
}

function sanitizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function formatMcpToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const parts = result.content.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text];
      }
      if (item.type === "resource" && isRecord(item.resource) && typeof item.resource.text === "string") {
        return [item.resource.text];
      }
      return [JSON.stringify(item)];
    });
    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  }
  return JSON.stringify(result, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
