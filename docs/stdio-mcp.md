# Stdio MCP support

Local command MCP support was removed from the runtime plugin to avoid shipping shell execution and direct filesystem access warnings.

The `@modelcontextprotocol/sdk` package is still required for remote HTTPS MCP support:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

Do not remove that package unless all external MCP support is removed.

If local command MCP needs to return, restore it deliberately.

## Types

In `src/core/types.ts`:

```ts
export interface ExternalMcpServerSettings {
  id: string;
  name: string;
  provider: "custom" | "firecrawl";
  transport: "http" | "stdio";
  url: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  apiKey?: string;
  enabled: boolean;
}
```

## Runtime Transport

In `src/mcp/remoteMcpClient.ts`, restore the stdio import and union:

```ts
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpClientTransport = StreamableHTTPClientTransport | StdioClientTransport;
```

Restore command target detection:

```ts
function hasConnectionTarget(server: ExternalMcpServerSettings): boolean {
  if (server.provider === "firecrawl" || server.transport === "http") {
    return Boolean(getServerUrl(server));
  }
  return Boolean(server.command?.trim());
}
```

Restore the stdio branch in `createTransport`:

```ts
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
```

Include command settings in connection signatures/clones:

```ts
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
```

## Settings UI

In `src/ui/settingsTab.ts`, restore the command server buttons:

```ts
new Setting(containerEl)
  .setName("Add command MCP")
  .setDesc("Adds a local stdio MCP server launched with npx -y.")
  .addButton((button) =>
    button.setButtonText("Add npx server").onClick(async () => {
      this.plugin.settings.externalMcpServers = [
        ...this.plugin.settings.externalMcpServers,
        createCommandMcpServer("npx-mcp-server", "npx", ["-y", "package-name"]),
      ];
      await this.plugin.savePluginData();
      this.display();
    }),
  );

new Setting(containerEl)
  .setName("Add local Firecrawl MCP")
  .setDesc("Adds firecrawl-mcp launched with npx -y. Add FIRECRAWL_API_KEY in env.")
  .addButton((button) =>
    button.setButtonText("Add local Firecrawl").onClick(async () => {
      this.plugin.settings.externalMcpServers = [
        ...this.plugin.settings.externalMcpServers,
        createCommandMcpServer("firecrawl-local", "npx", ["-y", "firecrawl-mcp"], { FIRECRAWL_API_KEY: "" }),
      ];
      await this.plugin.savePluginData();
      this.display();
    }),
  );
```

Restore the transport dropdown:

```ts
.addDropdown((dropdown) => {
  dropdown
    .addOption("http", "Remote URL")
    .addOption("stdio", "Command")
    .setValue(server.transport)
    .onChange(async (value) => {
      server.transport = value === "stdio" ? "stdio" : "http";
      await this.plugin.savePluginData();
      this.display();
    });
  if (isFirecrawl) {
    dropdown.setDisabled(true);
  }
})
```

Restore command-specific fields:

```ts
} else if (server.transport === "stdio") {
  new Setting(containerEl)
    .setName("Command")
    .setDesc("Executable used to launch the MCP server.")
    .addText((text) =>
      text
        .setPlaceholder("npx")
        .setValue(server.command ?? "")
        .onChange(async (value) => {
          server.command = value.trim();
          await this.plugin.savePluginData();
        }),
    );

  new Setting(containerEl)
    .setName("Arguments")
    .setDesc("One argument per line. Example: -y then firecrawl-mcp.")
    .addTextArea((text) => {
      text.inputEl.rows = 4;
      text
        .setPlaceholder("-y\npackage-name")
        .setValue((server.args ?? []).join("\n"))
        .onChange(async (value) => {
          server.args = parseLines(value);
          await this.plugin.savePluginData();
        });
    });

  new Setting(containerEl)
    .setName("Environment")
    .setDesc("One KEY=value pair per line. Values are stored in Obsidian plugin data on this device.")
    .addTextArea((text) => {
      text.inputEl.rows = 4;
      text
        .setPlaceholder("API_KEY=...")
        .setValue(formatKeyValueLines(server.env))
        .onChange(async (value) => {
          server.env = parseKeyValueLines(value);
          await this.plugin.savePluginData();
        });
    });
}
```

Restore the helpers:

```ts
function createCommandMcpServer(name: string, command: string, args: string[], env: Record<string, string> = {}): ExternalMcpServerSettings {
  return {
    id: `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    name,
    provider: "custom",
    transport: "stdio",
    url: "",
    command,
    args,
    env,
    enabled: true,
  };
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
```

## Settings Migration

In `src/main.ts`, restore stdio normalization:

```ts
const transport = provider === "firecrawl" ? "http" : item.transport === "stdio" ? "stdio" : "http";
const command = typeof item.command === "string" ? item.command.trim() : "";
if (provider === "custom" && transport === "http" && !url) {
  return [];
}
if (provider === "custom" && transport === "stdio" && !command) {
  return [];
}
```

Restore command fields in the normalized server:

```ts
{
  id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  name: provider === "firecrawl" ? "firecrawl" : name,
  provider,
  transport,
  url: provider === "firecrawl" ? "" : url,
  headers: normalizeStringRecord(item.headers),
  command,
  args: normalizeStringArray(item.args),
  env: normalizeStringRecord(item.env),
  apiKey,
  enabled: typeof item.enabled === "boolean" ? item.enabled : true,
}
```

Restore the array normalizer:

```ts
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}
```

Security note: this gives the plugin shell execution capability through configured MCP commands and will likely trigger Obsidian review warnings for shell execution and filesystem access.
