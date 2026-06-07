import { App, normalizePath, TFile, TFolder } from "obsidian";
import { MediaImportItem, ObsidianAIAssistantSettings } from "../core/types";
import { MediaImportClient } from "./mediaImportClient";

type MediaImportListener = () => void;

const LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;
const KNOWN_IMPORT_EXTENSIONS = new Set(["pdf", "docx", "pptx", "xlsx", "xls", "html", "htm", "txt", "csv", "json", "xml", "jpg", "jpeg", "png", "gif", "webp", "mp3", "wav"]);

export class MediaImportQueue {
  private readonly items: MediaImportItem[] = [];
  private readonly listeners = new Set<MediaImportListener>();
  private readonly canceledIds = new Set<string>();
  private running = 0;

  constructor(
    private readonly app: App,
    private readonly client: MediaImportClient,
    private readonly getSettings: () => ObsidianAIAssistantSettings,
  ) {}

  getItems(): MediaImportItem[] {
    return [...this.items].sort((a, b) => a.createdAt - b.createdAt);
  }

  subscribe(listener: MediaImportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  addFiles(files: File[]): void {
    const now = Date.now();
    for (const file of files) {
      this.items.push({
        id: `import:${now}:${Math.random().toString(36).slice(2)}`,
        file,
        originalName: file.name,
        size: file.size,
        status: "queued",
        message: "Queued",
        warning: getPreflightWarning(file),
        createdAt: now,
        updatedAt: now,
      });
    }
    this.emit();
    this.pump();
  }

  retry(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.status !== "error") {
      return;
    }
    this.updateItem(item, {
      status: "queued",
      message: "Queued",
      error: undefined,
      outputPath: undefined,
    });
    this.pump();
  }

  cancel(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return;
    }
    if (item.status === "queued") {
      this.updateItem(item, {
        status: "canceled",
        message: "Canceled",
        error: undefined,
      });
      return;
    }
    if (item.status === "uploading" || item.status === "converting") {
      this.canceledIds.add(id);
      this.updateItem(item, {
        status: "canceled",
        message: "Canceled",
        error: undefined,
      });
    }
  }

  remove(id: string): void {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      return;
    }
    const item = this.items[index];
    if (item.status === "uploading" || item.status === "converting" || item.status === "saving") {
      return;
    }
    this.items.splice(index, 1);
    this.emit();
  }

  clearCompleted(): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item.status === "done" || item.status === "error" || item.status === "canceled") {
        this.items.splice(index, 1);
      }
    }
    this.emit();
  }

  private pump(): void {
    const concurrency = clampConcurrency(this.getSettings().mediaImportConcurrency);
    while (this.running < concurrency) {
      const item = this.items.find((candidate) => candidate.status === "queued");
      if (!item) {
        return;
      }
      this.running += 1;
      void this.processItem(item).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async processItem(item: MediaImportItem): Promise<void> {
    try {
      this.updateItem(item, {
        status: "uploading",
        message: "Uploading",
        error: undefined,
      });

      const result = await this.client.convertFile(item.file, () => {
        if (this.canceledIds.has(item.id)) {
          return;
        }
        this.updateItem(item, {
          status: "converting",
          message: "Converting",
        });
      });
      if (this.canceledIds.has(item.id)) {
        this.canceledIds.delete(item.id);
        return;
      }

      this.updateItem(item, {
        status: "saving",
        message: "Saving",
      });
      const outputPath = await this.saveMarkdown(item, result.markdown, result.source);
      this.updateItem(item, {
        status: "done",
        message: "Saved",
        outputPath,
      });
    } catch (error) {
      if (this.canceledIds.has(item.id)) {
        this.canceledIds.delete(item.id);
        return;
      }
      this.updateItem(item, {
        status: "error",
        message: "Error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveMarkdown(item: MediaImportItem, markdown: string, source: string): Promise<string> {
    const folderPath = normalizeVaultPath(this.getSettings().mediaImportFolder);
    await this.ensureFolder(folderPath);
    const outputPath = await this.resolveOutputPath(folderPath, item.originalName);
    const content = withImportFrontmatter(markdown, item, source);
    const existing = this.app.vault.getAbstractFileByPath(outputPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return outputPath;
    }
    if (existing) {
      throw new Error(`Cannot save because a folder exists at: ${outputPath}`);
    }
    await this.app.vault.create(outputPath, content);
    return outputPath;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) {
      return;
    }
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`Cannot create import folder because a file exists at: ${current}`);
      }
      await this.app.vault.createFolder(current);
    }
  }

  private async resolveOutputPath(folderPath: string, originalName: string): Promise<string> {
    const settings = this.getSettings();
    const baseName = getMarkdownBaseName(originalName);
    const initialPath = joinVaultPath(folderPath, `${baseName}.md`);
    const existing = this.app.vault.getAbstractFileByPath(initialPath);
    if (!existing) {
      return initialPath;
    }
    if (settings.mediaImportOverwriteMode === "overwrite") {
      return initialPath;
    }
    if (settings.mediaImportOverwriteMode === "skip") {
      throw new Error(`File already exists: ${initialPath}`);
    }

    for (let index = 1; index < 1000; index += 1) {
      const candidate = joinVaultPath(folderPath, `${baseName} ${index}.md`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Could not find an available filename for: ${originalName}`);
  }

  private updateItem(item: MediaImportItem, patch: Partial<MediaImportItem>): void {
    Object.assign(item, patch, { updatedAt: Date.now() });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function normalizeVaultPath(path: string): string {
  return normalizePath(path.trim()).replace(/^\/+|\/+$/g, "");
}

function joinVaultPath(folderPath: string, filename: string): string {
  return folderPath ? `${folderPath}/${filename}` : filename;
}

function getMarkdownBaseName(filename: string): string {
  const cleanName = filename.replace(/[\\/]/g, " ").trim() || "Imported document";
  const withoutExtension = cleanName.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || cleanName;
}

function getPreflightWarning(file: File): string | undefined {
  const warnings: string[] = [];
  const extension = getExtension(file.name);
  if (!extension || !KNOWN_IMPORT_EXTENSIONS.has(extension)) {
    warnings.push("extension is not in the known MarkItDown format list");
  }
  if (file.size >= LARGE_FILE_WARNING_BYTES) {
    warnings.push(`large file (${formatBytes(file.size)}) may take a while or fail at the proxy`);
  }
  return warnings.length ? warnings.join("; ") : undefined;
}

function withImportFrontmatter(markdown: string, item: MediaImportItem, source: string): string {
  const frontmatter = [
    "---",
    `source_file: ${yamlString(item.originalName)}`,
    `source: ${yamlString(source)}`,
    `imported_at: ${yamlString(new Date().toISOString())}`,
    "converter: markitdown",
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${markdown.replace(/^\uFEFF/, "").trimStart()}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function getExtension(filename: string): string {
  const match = filename.toLocaleLowerCase().match(/\.([^.]+)$/);
  return match?.[1] ?? "";
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  return Math.max(1, Math.min(4, Math.floor(value)));
}
