export type OpenAiCompatibleEndpoint = "chat/completions" | "models";

export function buildOpenAiCompatibleEndpointUrl(apiBaseUrl: string, endpoint: OpenAiCompatibleEndpoint): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return `/v1/${endpoint}`;
  }

  if (usesUnversionedEndpoints(normalized) || hasVersionedPath(normalized)) {
    return `${normalized}/${endpoint}`;
  }

  return `${normalized}/v1/${endpoint}`;
}

export function isDeepSeekApiBaseUrl(apiBaseUrl: string): boolean {
  try {
    const url = new URL(apiBaseUrl);
    return url.hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

function usesUnversionedEndpoints(apiBaseUrl: string): boolean {
  return isDeepSeekApiBaseUrl(apiBaseUrl);
}

function hasVersionedPath(apiBaseUrl: string): boolean {
  try {
    const url = new URL(apiBaseUrl);
    return /\/v\d+$/i.test(url.pathname);
  } catch {
    return /\/v\d+$/i.test(apiBaseUrl);
  }
}
