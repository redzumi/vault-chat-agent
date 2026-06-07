import { App, normalizePath, TFile, TFolder } from "obsidian";
import { MediaImportItem, ObsidianAIAssistantSettings } from "../core/types";
import { MediaImportClient } from "./mediaImportClient";

type MediaImportListener = () => void;

export class MediaImportQueue {
  private readonly items: MediaImportItem[] = [];
  private readonly listeners = new Set<MediaImportListener>();
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
      if (item.status === "done" || item.status === "error") {
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
        this.updateItem(item, {
          status: "converting",
          message: "Converting",
        });
      });

      this.updateItem(item, {
        status: "saving",
        message: "Saving",
      });
      const outputPath = await this.saveMarkdown(item, result.markdown);
      this.updateItem(item, {
        status: "done",
        message: "Saved",
        outputPath,
      });
    } catch (error) {
      this.updateItem(item, {
        status: "error",
        message: "Error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveMarkdown(item: MediaImportItem, markdown: string): Promise<string> {
    const folderPath = normalizeVaultPath(this.getSettings().mediaImportFolder);
    await this.ensureFolder(folderPath);
    const outputPath = await this.resolveOutputPath(folderPath, item.originalName);
    const existing = this.app.vault.getAbstractFileByPath(outputPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, markdown);
      return outputPath;
    }
    if (existing) {
      throw new Error(`Cannot save because a folder exists at: ${outputPath}`);
    }
    await this.app.vault.create(outputPath, markdown);
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

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return 2;
  }
  return Math.max(1, Math.min(4, Math.floor(value)));
}
