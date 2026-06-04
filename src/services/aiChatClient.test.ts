import { afterEach, test } from "node:test";
import { deepEqual, equal, notEqual } from "node:assert/strict";
import { AgentToolExecution, ChatIntent, DEFAULT_SETTINGS, McpToolCallContext, McpToolDefinition, McpToolServer, ObsidianAIAssistantSettings } from "../core/types";
import { AgentRuntimeMetadata, AIChatClient } from "./aiChatClient";

const originalFetch = globalThis.fetch;

interface CapturedRequestBody {
  messages: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("completeWithAgent handles a read-only user request with a tool call and final answer", async () => {
  const requests = mockProviderResponses([
    assistantToolCall("call_list", "listFolder", '{"path":"/"}', "I should list the vault root."),
    assistantText("You have A.md and Projects/B.md."),
  ]);
  const tools = fakeMcpServer({
    listFolder: {
      content: "A.md\nProjects/B.md",
      workingSetItems: [{ path: "/", role: "listed", detail: "Listed vault root" }],
    },
  });
  const client = createClient();

  const result = await client.completeWithAgent("что у меня из файлов", [], tools, "ask");

  equal(result.answer, "You have A.md and Projects/B.md.");
  deepEqual(result.workingSet, [{ path: "/", role: "listed", detail: "Listed vault root" }]);
  equal(requests.length, 2);
  deepEqual(requests[1].messages.slice(-2), [
    {
      role: "assistant",
      content: "I should list the vault root.",
      reasoning_content: "Need to inspect the available files.",
      tool_calls: [
        {
          id: "call_list",
          type: "function",
          function: { name: "listFolder", arguments: '{"path":"/"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_list",
      content: '{"content":"A.md\\nProjects/B.md","workingSetItems":[{"path":"/","role":"listed","detail":"Listed vault root"}]}',
    },
  ]);
});

test("completeWithAgent preserves five previous chat messages before the current user request", async () => {
  const requests = mockProviderResponses([assistantText("Done.")]);
  const client = createClient();
  const history = [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: "two" },
    { role: "user" as const, content: "three" },
    { role: "assistant" as const, content: "four" },
    { role: "user" as const, content: "five" },
  ];

  await client.completeWithAgent("current", history, fakeMcpServer({}), "ask");

  const nonSystemMessages = requests[0].messages.slice(1);
  deepEqual(nonSystemMessages, [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
    { role: "user", content: "five" },
    { role: "user", content: "current" },
  ]);
});

test("completeWithAgent strips reasoning blocks from final answers when enabled", async () => {
  mockProviderResponses([assistantText("<think>private reasoning</think>\nVisible answer.")]);
  const client = createClient({ stripReasoningBlocks: true });

  const result = await client.completeWithAgent("answer plainly", [], fakeMcpServer({}), "ask");

  equal(result.answer, "Visible answer.");
});

test("completeWithAgent aggregates pending edits returned by edit tools", async () => {
  const pendingEdit = {
    id: "edit_1",
    path: "Notes/A.md",
    kind: "patch" as const,
    summary: "Add a heading",
    originalContent: "Body",
    newContent: "# Title\n\nBody",
    find: "Body",
    replace: "# Title\n\nBody",
    createdAt: 1,
  };
  mockProviderResponses([assistantToolCall("call_patch", "proposePatch", '{"path":"Notes/A.md"}'), assistantText("I prepared the edit.")]);
  const client = createClient();

  const result = await client.completeWithAgent(
    "добавь заголовок",
    [],
    fakeMcpServer({
      proposePatch: {
        content: "Prepared patch.",
        pendingEdit,
        workingSetItems: [{ path: "Notes/A.md", role: "edited", detail: "Add a heading" }],
      },
    }),
    "edit",
    undefined,
    { intent: "edit", pendingEdits: [], allowedCapabilities: ["read", "propose_edit"] },
  );

  equal(result.answer, "I prepared the edit.");
  deepEqual(result.pendingEdits, [pendingEdit]);
  deepEqual(result.workingSet, [{ path: "Notes/A.md", role: "edited", detail: "Add a heading" }]);
});

test("completeWithAgent in plan mode exposes only read tools and asks for a plan", async () => {
  const requests = mockProviderResponses([assistantText("Plan:\n1. Inspect Notes/A.md.\n2. Propose a small patch after approval.")]);
  const client = createClient();

  const result = await client.completeWithAgent(
    "план изменений",
    [],
    fakeMcpServer({}),
    "edit",
    undefined,
    { intent: "edit", runMode: "plan", pendingEdits: [], allowedCapabilities: ["read"] },
  );

  equal(result.answer, "Plan:\n1. Inspect Notes/A.md.\n2. Propose a small patch after approval.");
  const request = requests[0];
  const toolNames = (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  deepEqual(toolNames, ["listFolder", "getCurrentNote", "getLinks"]);
  const systemPrompt = String(request.messages[0].content);
  equal(systemPrompt.includes("You are in Plan mode."), true);
  equal(systemPrompt.includes("must not propose edits or create pending edits"), true);
  equal(systemPrompt.includes("propose reviewed file edits"), false);
});

test("completeWithAgent includes authoritative runtime metadata in the system prompt", async () => {
  const metadata: AgentRuntimeMetadata = {
    currentDateIso: "2026-06-04",
    currentDate: "Thursday, June 4, 2026",
    currentTime: "12:34:56 PM GMT+3",
    isoTimestamp: "2026-06-04T09:34:56.000Z",
    timeZone: "Europe/Moscow",
    utcOffset: "UTC+03:00",
    locale: "ru-RU",
    languages: ["ru-RU", "en-US"],
    platform: "MacIntel",
    location: "Europe/Moscow",
  };
  const requests = mockProviderResponses([assistantText("Today is June 4, 2026.")]);
  const client = createClient({}, metadata);

  await client.completeWithAgent("какой сегодня год", [], fakeMcpServer({}), "ask");

  const systemPrompt = String(requests[0].messages[0].content);
  equal(systemPrompt.includes("Runtime metadata is authoritative"), true);
  equal(systemPrompt.includes('"currentDateIso": "2026-06-04"'), true);
  equal(systemPrompt.includes('"currentDate": "Thursday, June 4, 2026"'), true);
  equal(systemPrompt.includes('"timeZone": "Europe/Moscow"'), true);
  equal(systemPrompt.includes('"locale": "ru-RU"'), true);
});

test("completeWithAgent executes multiple tool calls from one assistant response", async () => {
  mockProviderResponses([
    assistantToolCalls([
      { id: "call_current", name: "getCurrentNote", argumentsJson: "{}" },
      { id: "call_links", name: "getLinks", argumentsJson: '{"path":"Daily.md"}' },
    ]),
    assistantText("Daily.md links to Project.md."),
  ]);
  const calls: string[] = [];
  const client = createClient();
  const server = fakeMcpServer(
    {
      getCurrentNote: {
        content: "Daily.md",
        workingSetItems: [{ path: "Daily.md", role: "current", detail: "Current note" }],
      },
      getLinks: {
        content: "Project.md",
        workingSetItems: [{ path: "Project.md", role: "linked", detail: "Linked from Daily.md" }],
      },
    },
    calls,
  );

  const result = await client.completeWithAgent("что связано с текущей заметкой", [], server, "ask");

  deepEqual(calls, ["getCurrentNote", "getLinks"]);
  equal(result.answer, "Daily.md links to Project.md.");
  deepEqual(result.workingSet, [
    { path: "Daily.md", role: "current", detail: "Current note" },
    { path: "Project.md", role: "linked", detail: "Linked from Daily.md" },
  ]);
});

function createClient(settings: Partial<ObsidianAIAssistantSettings> = {}, metadata?: AgentRuntimeMetadata): AIChatClient {
  return new AIChatClient(
    () => ({
      ...DEFAULT_SETTINGS,
      apiKey: "test-key",
      apiBaseUrl: "https://api.openai.com",
      model: "test-model",
      ...settings,
    }),
    () => "2 markdown files indexed.",
    metadata ? () => metadata : undefined,
  );
}

function fakeMcpServer(results: Record<string, AgentToolExecution>, calls: string[] = []): McpToolServer {
  return {
    listTools(context: McpToolCallContext): McpToolDefinition[] {
      const definitions: McpToolDefinition[] = [
        {
          name: "listFolder",
          description: "List files in a folder.",
          capability: "read",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "getCurrentNote",
          description: "Get the current note.",
          capability: "read",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "getLinks",
          description: "Get note links.",
          capability: "read",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "proposePatch",
          description: "Propose a patch.",
          capability: "propose_edit",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ];
      return definitions.filter((tool) => context.allowedCapabilities.includes(tool.capability));
    },
    async callTool(name: string): Promise<AgentToolExecution> {
      calls.push(name);
      return results[name] ?? { content: `No fake result for ${name}.` };
    },
  };
}

function mockProviderResponses(responses: unknown[]): CapturedRequestBody[] {
  const requests: CapturedRequestBody[] = [];
  let index = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    notEqual(init?.body, undefined);
    requests.push(JSON.parse(String(init?.body)) as CapturedRequestBody);
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      return new Response(JSON.stringify({ error: "No mocked response." }), { status: 500 });
    }
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return requests;
}

function assistantText(content: string): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

function assistantToolCall(id: string, name: string, argumentsJson: string, content: string | null = null): unknown {
  return assistantToolCalls([{ id, name, argumentsJson }], content);
}

function assistantToolCalls(toolCalls: Array<{ id: string; name: string; argumentsJson: string }>, content: string | null = null): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          reasoning_content: "Need to inspect the available files.",
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
            },
          })),
        },
      },
    ],
  };
}
