import { EventRef, MetadataCache, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { SemanticChunker } from "../core/chunker";
import { IndexStore } from "../core/indexStore";
import { indexVaultFile, isIndexableVaultFile } from "./indexAll";
import { scheduledPathMatchesTarget } from "./realtimeIndexerUtils";

type PersistCallback = () => Promise<void>;
type UpdateCallback = () => void;
type EventRegistrar = (eventRef: EventRef) => void;

const PERSIST_DELAY_MS = 2500;

export class RealtimeIndexer {
  private timers = new Map<string, number>();
  private persistTimer: number | null = null;
  private stopped = false;

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    private readonly chunker: SemanticChunker,
    private readonly indexStore: IndexStore,
    private readonly persist: PersistCallback,
    private readonly onUpdate: UpdateCallback,
    private readonly registerEvent: EventRegistrar,
  ) {}

  start(): void {
    this.stopped = false;
    this.registerEvent(
      this.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.scheduleIndex(file);
        }
      }),
    );

    this.registerEvent(
      this.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.scheduleIndex(file);
        }
      }),
    );

    this.registerEvent(
      this.vault.on("delete", (file) => {
        this.handleDelete(file);
      }),
    );

    this.registerEvent(
      this.vault.on("rename", (file, oldPath) => {
        this.clearScheduledIndexes(oldPath);
        if (file instanceof TFolder) {
          this.indexStore.deleteFolder(oldPath);
          for (const child of collectFolderFiles(file)) {
            this.scheduleIndex(child);
          }
          this.schedulePersistAndNotify();
          return;
        }

        this.indexStore.deleteFile(oldPath);
        if (file instanceof TFile) {
          this.scheduleIndex(file);
        }
        this.schedulePersistAndNotify();
      }),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const timerId of this.timers.values()) {
      window.clearTimeout(timerId);
    }
    this.timers.clear();
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private scheduleIndex(file: TFile): void {
    if (this.stopped) {
      return;
    }

    if (!isIndexableVaultFile(file)) {
      this.clearScheduledIndexes(file.path);
      this.indexStore.deleteFile(file.path);
      this.schedulePersistAndNotify();
      return;
    }

    const existing = this.timers.get(file.path);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timerId = window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.indexFile(file);
    }, 1200);
    this.timers.set(file.path, timerId);
  }

  private async indexFile(file: TFile): Promise<void> {
    if (this.stopped) {
      return;
    }

    await indexVaultFile(this.vault, this.metadataCache, this.chunker, this.indexStore, file);
    this.schedulePersistAndNotify();
  }

  private handleDelete(file: TAbstractFile): void {
    this.clearScheduledIndexes(file.path);
    if (file instanceof TFolder) {
      this.indexStore.deleteFolder(file.path);
      this.schedulePersistAndNotify();
      return;
    }

    if (file instanceof TFile) {
      this.indexStore.deleteFile(file.path);
      this.schedulePersistAndNotify();
    }
  }

  private async persistAndNotify(): Promise<void> {
    await this.persist();
    this.onUpdate();
  }

  private schedulePersistAndNotify(): void {
    if (this.stopped) {
      return;
    }

    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
    }

    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.persistAndNotify();
    }, PERSIST_DELAY_MS);
  }

  private clearScheduledIndexes(path: string): void {
    for (const [filePath, timerId] of this.timers.entries()) {
      if (scheduledPathMatchesTarget(filePath, path)) {
        window.clearTimeout(timerId);
        this.timers.delete(filePath);
      }
    }
  }
}

function collectFolderFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile) {
      files.push(child);
    } else if (child instanceof TFolder) {
      files.push(...collectFolderFiles(child));
    }
  }
  return files;
}
