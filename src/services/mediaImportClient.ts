import { requestUrl } from "obsidian";
import { ObsidianAIAssistantSettings } from "../core/types";

export interface MarkitdownConvertResult {
  markdown: string;
  source: string;
}

export class MediaImportClient {
  constructor(private readonly getSettings: () => ObsidianAIAssistantSettings) {}

  async convertFile(file: File, onBodyReady?: () => void): Promise<MarkitdownConvertResult> {
    const settings = this.getSettings();
    const boundary = `----VaultChatAgentFormBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const body = await buildMultipartBody(boundary, file);
    onBodyReady?.();

    const response = await requestUrl({
      url: buildConvertUrl(settings.markitdownApiBaseUrl),
      method: "POST",
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers: buildHeaders(settings),
      body,
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(formatHttpError(response.status, response.text));
    }

    const payload = parseJsonResponse(response.text);
    if (!isRecord(payload) || typeof payload.markdown !== "string") {
      throw new Error("MarkItDown response did not include markdown.");
    }

    return {
      markdown: payload.markdown,
      source: typeof payload.source === "string" ? payload.source : file.name,
    };
  }
}

async function buildMultipartBody(boundary: string, file: File): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const contentType = file.type || "application/octet-stream";
  const header = encoder.encode(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(file.name)}"`,
      `Content-Type: ${contentType}`,
      "",
      "",
    ].join("\r\n"),
  );
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(header.byteLength + fileBytes.byteLength + footer.byteLength);
  body.set(header, 0);
  body.set(fileBytes, header.byteLength);
  body.set(footer, header.byteLength + fileBytes.byteLength);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function buildConvertUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim() || "https://markitdown.redz.sbs";
  return `${normalizedBaseUrl.replace(/\/+$/, "")}/convert`;
}

function buildHeaders(settings: ObsidianAIAssistantSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const username = settings.markitdownUsername.trim();
  if (username) {
    headers.Authorization = `Basic ${encodeBase64(`${username}:${settings.markitdownPassword}`)}`;
  }
  return headers;
}

function encodeBase64(value: string): string {
  if (typeof btoa === "function") {
    return btoa(unescape(encodeURIComponent(value)));
  }
  return Buffer.from(value, "utf8").toString("base64");
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("MarkItDown returned invalid JSON.");
  }
}

function formatHttpError(status: number, text: string): string {
  const detail = text.trim().slice(0, 220);
  return detail ? `MarkItDown HTTP ${status}: ${detail}` : `MarkItDown HTTP ${status}`;
}

function escapeMultipartValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
