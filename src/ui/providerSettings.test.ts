import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { ProviderModelRequest, ProviderModelResponse } from "./providerSettings";
import { detectProviderPreset, fetchProviderModels, parseModelIds } from "./providerSettings";

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
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const mockRequester = async (request: ProviderModelRequest): Promise<ProviderModelResponse> => {
    requests.push({ url: request.url, headers: request.headers });
    return createRequestUrlResponse(200, JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }] }));
  };

  const models = await fetchProviderModels({ apiBaseUrl: "https://api.example.com/", apiKey: " test-key " }, mockRequester);

  deepEqual(models, ["alpha", "zeta"]);
  equal(requests[0].url, "https://api.example.com/v1/models");
  deepEqual(requests[0].headers, {
    Accept: "application/json",
    Authorization: "Bearer test-key",
  });
});

test("fetchProviderModels uses DeepSeek models endpoint without /v1", async () => {
  const requests: Array<{ url: string }> = [];
  const mockRequester = async (request: ProviderModelRequest): Promise<ProviderModelResponse> => {
    requests.push({ url: request.url });
    return createRequestUrlResponse(200, JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }));
  };

  const models = await fetchProviderModels({ apiBaseUrl: "https://api.deepseek.com/", apiKey: " test-key " }, mockRequester);

  deepEqual(models, ["deepseek-v4-flash"]);
  equal(requests[0].url, "https://api.deepseek.com/models");
});

test("fetchProviderModels surfaces provider errors", async () => {
  const mockRequester = async (): Promise<ProviderModelResponse> => createRequestUrlResponse(400, "bad request");

  await rejects(
    () => fetchProviderModels({ apiBaseUrl: "https://api.example.com", apiKey: "" }, mockRequester),
    /Request failed \(400\): bad request/,
  );
});

test("detectProviderPreset handles trailing slashes and custom URLs", () => {
  equal(detectProviderPreset("https://api.openai.com/"), "openai");
  equal(detectProviderPreset("http://localhost:11434"), "ollama");
  equal(detectProviderPreset("https://models.example.com"), "custom");
});

function createRequestUrlResponse(status: number, text: string): ProviderModelResponse {
  return {
    status,
    text,
  };
}
