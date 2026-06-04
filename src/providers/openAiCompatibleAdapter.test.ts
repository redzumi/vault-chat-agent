import { deepEqual, equal, notEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, McpToolDefinition, ObsidianAIAssistantSettings } from "../core/types";
import { OpenAiCompatibleAdapter } from "./openAiCompatibleAdapter";
import { ProviderMessage } from "./types";

const tool: McpToolDefinition = {
  name: "listFolder",
  description: "List files in a vault folder.",
  capability: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  },
};

test("createRequest builds the baseline OpenAI-compatible chat completions payload", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const request = adapter.createRequest(settings({ apiBaseUrl: "https://api.openai.com/" }), [{ role: "user", content: "what files do I have?" }], [tool], 1200);

  equal(request.url, "https://api.openai.com/v1/chat/completions");
  deepEqual(request.body, {
    model: "test-model",
    messages: [{ role: "user", content: "what files do I have?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "listFolder",
          description: "List files in a vault folder.",
          parameters: tool.inputSchema,
        },
      },
    ],
    temperature: 0.2,
    max_tokens: 1200,
    stream: false,
    tool_choice: "auto",
  });
});

test("createRequest uses DeepSeek chat completions endpoint without /v1", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const request = adapter.createRequest(settings({ apiBaseUrl: "https://api.deepseek.com/", model: "deepseek-v4-flash" }), [{ role: "user", content: "hello" }], [tool], 100, true);

  equal(request.url, "https://api.deepseek.com/chat/completions");
  equal((request.body as Record<string, unknown>).stream, true);
  equal(Object.prototype.hasOwnProperty.call(request.body, "thinking"), false);
});

test("createRequest does not duplicate an explicit versioned base URL", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const request = adapter.createRequest(settings({ apiBaseUrl: "https://api.openai.com/v1" }), [{ role: "user", content: "hello" }], [tool], 100);

  equal(request.url, "https://api.openai.com/v1/chat/completions");
});

test("createRequest keeps tool_choice for remote OpenAI-compatible providers", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const providers = ["https://api.deepseek.com", "https://openrouter.ai/api", "http://localhost:1234"];

  for (const apiBaseUrl of providers) {
    const request = adapter.createRequest(settings({ apiBaseUrl }), [{ role: "user", content: "hello" }], [tool], 100);
    equal((request.body as Record<string, unknown>).tool_choice, "auto", apiBaseUrl);
  }
});

test("createRequest omits tool_choice for Ollama OpenAI compatibility", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const providers = ["http://localhost:11434", "http://127.0.0.1:11434", "http://0.0.0.0:11434"];

  for (const apiBaseUrl of providers) {
    const request = adapter.createRequest(settings({ apiBaseUrl }), [{ role: "user", content: "hello" }], [tool], 100);
    equal(Object.prototype.hasOwnProperty.call(request.body, "tool_choice"), false, apiBaseUrl);
  }
});

test("createRequest serializes assistant tool calls and preserves reasoning fields", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const reasoningDetails = [{ type: "reasoning.summary", summary: "Checked whether a folder listing is needed." }];
  const messages: ProviderMessage[] = [
    {
      role: "assistant",
      content: null,
      reasoning: "I need to inspect the vault.",
      reasoningContent: "Need a folder listing.",
      reasoningDetails,
      toolCalls: [{ id: "call_1", name: "listFolder", argumentsJson: '{"path":"/"}' }],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: '{"files":["A.md"]}',
    },
  ];

  const request = adapter.createRequest(settings({ apiBaseUrl: "https://openrouter.ai/api" }), messages, [tool], 100);
  const body = request.body as { messages: Array<Record<string, unknown>> };

  deepEqual(body.messages, [
    {
      role: "assistant",
      content: null,
      reasoning: "I need to inspect the vault.",
      reasoning_content: "Need a folder listing.",
      reasoning_details: reasoningDetails,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "listFolder",
            arguments: '{"path":"/"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"files":["A.md"]}',
    },
  ]);
});

test("parseResponse extracts content, tool calls, and reasoning fields", () => {
  const adapter = new OpenAiCompatibleAdapter();
  const reasoningDetails = [{ type: "reasoning.text", text: "Use listFolder." }];

  const message = adapter.parseResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "I'll inspect the folder.",
          reasoning: "OpenRouter reasoning",
          reasoning_content: "DeepSeek thinking",
          reasoning_details: reasoningDetails,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "listFolder",
                arguments: '{"path":"/"}',
              },
            },
          ],
        },
      },
    ],
  });

  notEqual(message, null);
  if (!message) {
    throw new Error("Expected a parsed assistant message.");
  }
  equal(message.content, "I'll inspect the folder.");
  equal(message.reasoning, "OpenRouter reasoning");
  equal(message.reasoningContent, "DeepSeek thinking");
  equal(message.reasoningDetails, reasoningDetails);
  deepEqual(message.toolCalls, [{ id: "call_1", name: "listFolder", argumentsJson: '{"path":"/"}' }]);
});

test("parseResponse treats null content as empty text", () => {
  const adapter = new OpenAiCompatibleAdapter();

  const message = adapter.parseResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "listFolder",
                arguments: "{}",
              },
            },
          ],
        },
      },
    ],
  });

  notEqual(message, null);
  if (!message) {
    throw new Error("Expected a parsed assistant message.");
  }
  equal(message.content, "");
  deepEqual(message.toolCalls, [{ id: "call_1", name: "listFolder", argumentsJson: "{}" }]);
});

test("parseResponse rejects invalid response envelopes", () => {
  const adapter = new OpenAiCompatibleAdapter();

  equal(adapter.parseResponse(null), null);
  equal(adapter.parseResponse({}), null);
  equal(adapter.parseResponse({ choices: [] }), null);
  equal(adapter.parseResponse({ choices: [{ message: { role: "user", content: "wrong role" } }] }), null);
});

test("parseResponse filters malformed tool calls", () => {
  const adapter = new OpenAiCompatibleAdapter();

  const message = adapter.parseResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "missing_function" },
            { id: "missing_arguments", function: { name: "listFolder" } },
            { id: "valid", function: { name: "listFolder", arguments: "{}" } },
          ],
        },
      },
    ],
  });

  notEqual(message, null);
  if (!message) {
    throw new Error("Expected a parsed assistant message.");
  }
  deepEqual(message.toolCalls, [{ id: "valid", name: "listFolder", argumentsJson: "{}" }]);
});

function settings(overrides: Partial<ObsidianAIAssistantSettings>): ObsidianAIAssistantSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: "test-key",
    apiBaseUrl: "https://api.openai.com",
    model: "test-model",
    ...overrides,
  };
}
