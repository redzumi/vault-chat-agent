import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { AgentToolExecution, AgentToolExecutor, McpToolCallContext, PendingEdit } from "../core/types";
import { ObsidianMcpServer } from "./obsidianMcpServer";

test("ObsidianMcpServer keeps plan mode read-only even if broader capabilities are present", () => {
  const server = createServer();
  const tools = server.listTools({
    intent: "edit",
    runMode: "plan",
    pendingEdits: [pendingEdit()],
    allowedCapabilities: ["read", "propose_edit", "apply_edit"],
  });

  deepEqual(
    tools.map((tool) => tool.name),
    [
      "searchNotes",
      "getCurrentNote",
      "openCurrentNote",
      "openNote",
      "listFolder",
      "getLinks",
      "readUrl",
      "readYouTubeTranscript",
      "getVaultOverview",
    ],
  );
});

test("ObsidianMcpServer accepts folder-scoped searchNotes arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown>; context?: McpToolCallContext }> = [];
  const server = createServer(calls);
  const context: McpToolCallContext = {
    intent: "ask",
    pendingEdits: [],
    allowedCapabilities: ["read"],
  };

  const result = await server.callTool("searchNotes", { query: "roadmap", topK: 3, folder: "Projects" }, context);

  equal(result.content, "ok");
  deepEqual(calls, [{ name: "searchNotes", args: { query: "roadmap", topK: 3, folder: "Projects" }, context }]);
});

test("ObsidianMcpServer still rejects unknown searchNotes arguments", async () => {
  const server = createServer();
  const result = await server.callTool(
    "searchNotes",
    { query: "roadmap", folder: "Projects", outsideScope: true },
    { intent: "ask", pendingEdits: [], allowedCapabilities: ["read"] },
  );

  equal(result.content, "Invalid arguments for searchNotes: args.outsideScope is not allowed.");
});

test("ObsidianMcpServer accepts readUrl arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown>; context?: McpToolCallContext }> = [];
  const server = createServer(calls);
  const context: McpToolCallContext = {
    intent: "ask",
    pendingEdits: [],
    allowedCapabilities: ["read"],
  };

  const result = await server.callTool("readUrl", { url: "https://example.com", maxChars: 5000 }, context);

  equal(result.content, "ok");
  deepEqual(calls, [{ name: "readUrl", args: { url: "https://example.com", maxChars: 5000 }, context }]);
});

test("ObsidianMcpServer accepts readYouTubeTranscript arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown>; context?: McpToolCallContext }> = [];
  const server = createServer(calls);
  const context: McpToolCallContext = {
    intent: "ask",
    pendingEdits: [],
    allowedCapabilities: ["read"],
  };

  const result = await server.callTool("readYouTubeTranscript", { url: "https://youtu.be/video", language: "en" }, context);

  equal(result.content, "ok");
  deepEqual(calls, [{ name: "readYouTubeTranscript", args: { url: "https://youtu.be/video", language: "en" }, context }]);
});

function createServer(calls: Array<{ name: string; args: Record<string, unknown>; context?: McpToolCallContext }> = []): ObsidianMcpServer {
  const agentTools: AgentToolExecutor = {
    async execute(name, args, context): Promise<AgentToolExecution> {
      calls.push({ name, args, context });
      return { content: "ok" };
    },
    async applyEdit(): Promise<void> {},
  };

  return new ObsidianMcpServer(
    agentTools,
    async () => ({ content: "applied" }),
    async () => ({ content: "applied all" }),
  );
}

function pendingEdit(): Pick<PendingEdit, "id" | "path" | "kind" | "summary"> {
  return {
    id: "edit-1",
    path: "Notes/A.md",
    kind: "patch",
    summary: "Update note",
  };
}
