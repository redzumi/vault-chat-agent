import { deepEqual, equal, rejects } from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectProviderPreset, fetchProviderModels, parseModelIds } from "./providerSettings";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("parseModelIds extracts trimmed model ids and ignores malformed entries", () => {
  deepEqual(
    parseModelIds({
      data: [
        { id: " gpt-4o-mini " },
        { id: "" },
        { id: "deepseek-chat" },
        { name: "missing-id" },
        null,
      ],
    }),
    ["gpt-4o-mini", "deepseek-chat"],
  );
  deepEqual(parseModelIds({ data: "not-an-array" }), []);
  deepEqual(parseModelIds(null), []);
});

test("fetchProviderModels calls /v1/models with auth and returns sorted unique ids", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(
      JSON.stringify({
        data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const models = await fetchProviderModels({ apiBaseUrl: "https://api.example.com/", apiKey: " test-key " });

  deepEqual(models, ["alpha", "zeta"]);
  equal(String(requests[0].input), "https://api.example.com/v1/models");
  deepEqual(requests[0].init?.headers, {
    Accept: "application/json",
    Authorization: "Bearer test-key",
  });
});

test("fetchProviderModels uses DeepSeek models endpoint without /v1", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const models = await fetchProviderModels({ apiBaseUrl: "https://api.deepseek.com/", apiKey: " test-key " });

  deepEqual(models, ["deepseek-v4-flash"]);
  equal(String(requests[0].input), "https://api.deepseek.com/models");
});

test("fetchProviderModels surfaces provider errors", async () => {
  globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;

  await rejects(
    () => fetchProviderModels({ apiBaseUrl: "https://api.example.com", apiKey: "" }),
    /Request failed \(400\): bad request/,
  );
});

test("detectProviderPreset handles trailing slashes and custom URLs", () => {
  equal(detectProviderPreset("https://api.openai.com/"), "openai");
  equal(detectProviderPreset("http://localhost:11434"), "ollama");
  equal(detectProviderPreset("https://models.example.com"), "custom");
});
