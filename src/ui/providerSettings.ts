import { buildOpenAiCompatibleEndpointUrl } from "../providers/endpoints";

export const PROVIDER_PRESETS = {
  custom: { name: "Custom OpenAI-compatible", apiBaseUrl: "", model: "" },
  openai: { name: "OpenAI", apiBaseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
  deepseek: { name: "DeepSeek", apiBaseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openrouter: { name: "OpenRouter", apiBaseUrl: "https://openrouter.ai/api", model: "openai/gpt-4o-mini" },
  lmstudio: { name: "LM Studio", apiBaseUrl: "http://localhost:1234", model: "local-model" },
  ollama: { name: "Ollama", apiBaseUrl: "http://localhost:11434", model: "llama3.1" },
} as const;

export type ProviderPreset = keyof typeof PROVIDER_PRESETS;

export async function fetchProviderModels(settings: { apiBaseUrl: string; apiKey: string }): Promise<string[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  }

  const response = await fetch(buildOpenAiCompatibleEndpointUrl(settings.apiBaseUrl, "models"), {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as unknown;
  const models = parseModelIds(data);
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

export function parseModelIds(data: unknown): string[] {
  if (!isRecord(data)) {
    return [];
  }
  const rawModels = data.data;
  if (!Array.isArray(rawModels)) {
    return [];
  }
  return rawModels.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    return typeof item.id === "string" && item.id.trim() ? [item.id.trim()] : [];
  });
}

export function detectProviderPreset(apiBaseUrl: string): ProviderPreset {
  const normalized = apiBaseUrl.replace(/\/$/, "");
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.apiBaseUrl && preset.apiBaseUrl === normalized) {
      return key as ProviderPreset;
    }
  }
  return "custom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
