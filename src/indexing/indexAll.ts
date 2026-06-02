import { MetadataCache, Notice, TFile, Vault } from "obsidian";
import { SemanticChunker } from "../core/chunker";
import { IndexStore } from "../core/indexStore";
import { IndexedDocument } from "../core/types";
import { isIndexableVaultFileLike } from "./indexableFiles";

const TEXT_EXTENSIONS = new Set(["md", "txt", "csv", "json"]);
const CANVAS_EXTENSION = "canvas";

export interface VaultIndexResult {
  totalFiles: number;
  indexedFiles: number;
  metadataOnlyFiles: number;
  errorFiles: number;
}

export interface VaultSyncResult extends VaultIndexResult {
  changedFiles: number;
  deletedFiles: number;
}

export async function indexVaultFiles(
  vault: Vault,
  metadataCache: MetadataCache,
  chunker: SemanticChunker,
  indexStore: IndexStore,
): Promise<VaultIndexResult> {
  const files = vault.getFiles().filter(isIndexableVaultFile);
  const notice = new Notice(`Vault Chat Agent: indexing 0/${files.length} files...`, 0);
  indexStore.clear();

  try {
    for (let index = 0; index < files.length; index += 1) {
      await indexVaultFile(vault, metadataCache, chunker, indexStore, files[index]);

      const done = index + 1;
      if (done === files.length || done % 10 === 0) {
        notice.setMessage(`Vault Chat Agent: indexing ${done}/${files.length} files...`);
        await yieldToMainThread();
      }
    }

    const coverage = indexStore.getCoverage();
    notice.setMessage(`Vault Chat Agent: indexed ${coverage.indexedFiles}/${coverage.totalFiles} files.`);
    window.setTimeout(() => notice.hide(), 3000);
    return {
      totalFiles: coverage.totalFiles,
      indexedFiles: coverage.indexedFiles,
      metadataOnlyFiles: coverage.metadataOnlyFiles,
      errorFiles: coverage.errorFiles,
    };
  } catch (error) {
    notice.hide();
    throw error;
  }
}

export async function syncVaultIndex(
  vault: Vault,
  metadataCache: MetadataCache,
  chunker: SemanticChunker,
  indexStore: IndexStore,
): Promise<VaultSyncResult> {
  const files = vault.getFiles().filter(isIndexableVaultFile);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const documentsByPath = new Map(indexStore.getAllDocuments().map((document) => [document.path, document]));
  const changedFiles = files.filter((file) => {
    const document = documentsByPath.get(file.path);
    return !document || document.modified !== file.stat.mtime || document.size !== file.stat.size;
  });
  let deletedFiles = 0;

  for (const document of indexStore.getAllDocuments()) {
    if (!filesByPath.has(document.path)) {
      indexStore.deleteFile(document.path);
      deletedFiles += 1;
    }
  }

  if (changedFiles.length === 0) {
    const coverage = indexStore.getCoverage();
    return {
      totalFiles: coverage.totalFiles,
      indexedFiles: coverage.indexedFiles,
      metadataOnlyFiles: coverage.metadataOnlyFiles,
      errorFiles: coverage.errorFiles,
      changedFiles: 0,
      deletedFiles,
    };
  }

  const notice = new Notice(`Vault Chat Agent: syncing index 0/${changedFiles.length} changed files...`, 0);
  try {
    for (let index = 0; index < changedFiles.length; index += 1) {
      await indexVaultFile(vault, metadataCache, chunker, indexStore, changedFiles[index]);

      const done = index + 1;
      if (done === changedFiles.length || done % 10 === 0) {
        notice.setMessage(`Vault Chat Agent: syncing index ${done}/${changedFiles.length} changed files...`);
        await yieldToMainThread();
      }
    }

    const coverage = indexStore.getCoverage();
    notice.setMessage(`Vault Chat Agent: synced ${changedFiles.length} changed files.`);
    window.setTimeout(() => notice.hide(), 3000);
    return {
      totalFiles: coverage.totalFiles,
      indexedFiles: coverage.indexedFiles,
      metadataOnlyFiles: coverage.metadataOnlyFiles,
      errorFiles: coverage.errorFiles,
      changedFiles: changedFiles.length,
      deletedFiles,
    };
  } catch (error) {
    notice.hide();
    throw error;
  }
}

export async function indexVaultFile(
  vault: Vault,
  metadataCache: MetadataCache,
  chunker: SemanticChunker,
  indexStore: IndexStore,
  file: TFile,
): Promise<void> {
  if (!isIndexableVaultFile(file)) {
    indexStore.deleteFile(file.path);
    return;
  }

  try {
    const metadata = readMarkdownMetadata(metadataCache, file);
    const content = await readIndexableContent(vault, file);
    if (content === null) {
      indexStore.replaceMetadataOnly(
        createDocument(file, "metadata-only", metadata.tags, metadata.headings, metadata.links, metadata.aliases, metadata.frontmatterKeys, 0),
      );
      return;
    }

    const chunks = chunker.chunkDocument(content, file.path, file.stat.mtime, file.extension);
    indexStore.replaceFile(
      createDocument(
        file,
        "indexed",
        [...chunks.flatMap((chunk) => chunk.tags), ...metadata.tags],
        metadata.headings.length ? metadata.headings : extractHeadings(content),
        metadata.links.length ? metadata.links : extractLinks(content),
        metadata.aliases,
        metadata.frontmatterKeys,
        chunks.length,
      ),
      chunks,
    );
  } catch (error) {
    indexStore.replaceMetadataOnly(createDocument(file, "error", [], [], [], [], [], 0, error instanceof Error ? error.message : String(error)));
  }
}

export function isIndexableVaultFile(file: TFile): boolean {
  return isIndexableVaultFileLike(file);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function readIndexableContent(vault: Vault, file: TFile): Promise<string | null> {
  if (TEXT_EXTENSIONS.has(file.extension)) {
    return vault.read(file);
  }

  if (file.extension === CANVAS_EXTENSION) {
    return extractCanvasText(await vault.read(file));
  }

  return null;
}

function createDocument(
  file: TFile,
  status: IndexedDocument["status"],
  tags: string[],
  headings: string[],
  links: string[],
  aliases: string[],
  frontmatterKeys: string[],
  chunkCount: number,
  error?: string,
): IndexedDocument {
  return {
    path: file.path,
    basename: file.basename,
    extension: file.extension,
    status,
    chunkCount,
    size: file.stat.size,
    created: file.stat.ctime,
    modified: file.stat.mtime,
    tags: unique(tags),
    headings: unique(headings),
    links: unique(links),
    aliases: unique(aliases),
    frontmatterKeys: unique(frontmatterKeys),
    error,
  };
}

function readMarkdownMetadata(metadataCache: MetadataCache, file: TFile): {
  tags: string[];
  headings: string[];
  links: string[];
  aliases: string[];
  frontmatterKeys: string[];
} {
  if (file.extension !== "md") {
    return { tags: [], headings: [], links: [], aliases: [], frontmatterKeys: [] };
  }

  const cache = metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter ?? {};
  const frontmatterTags = normalizeFrontmatterList(frontmatter.tags).map((tag) => tag.replace(/^#/, ""));
  const aliases = normalizeFrontmatterList(frontmatter.aliases ?? frontmatter.alias);
  const links = [
    ...(cache?.links ?? []).map((link) => link.link),
    ...(cache?.embeds ?? []).map((embed) => embed.link),
  ];

  return {
    tags: unique([...(cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, "")), ...frontmatterTags]),
    headings: unique((cache?.headings ?? []).map((heading) => heading.heading)),
    links: unique(links),
    aliases,
    frontmatterKeys: Object.keys(frontmatter),
  };
}

function normalizeFrontmatterList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeFrontmatterList(item));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function extractCanvasText(content: string): string {
  const parsed = JSON.parse(content) as {
    nodes?: Array<{ text?: unknown; label?: unknown; file?: unknown; url?: unknown }>;
    edges?: Array<{ label?: unknown; fromNode?: unknown; toNode?: unknown }>;
  };
  const parts: string[] = [];

  for (const node of parsed.nodes ?? []) {
    for (const value of [node.text, node.label, node.file, node.url]) {
      if (typeof value === "string" && value.trim()) {
        parts.push(value.trim());
      }
    }
  }

  for (const edge of parsed.edges ?? []) {
    if (typeof edge.label === "string" && edge.label.trim()) {
      parts.push(edge.label.trim());
    }
  }

  return parts.join("\n\n");
}

function extractHeadings(content: string): string[] {
  return unique(Array.from(content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm), (match) => match[1].trim()));
}

function extractLinks(content: string): string[] {
  const wikiLinks = Array.from(content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g), (match) => match[1].trim());
  const markdownLinks = Array.from(content.matchAll(/\[[^\]]+\]\((?!https?:\/\/|mailto:)([^)]+)\)/gi), (match) => match[1].trim());
  return unique([...wikiLinks, ...markdownLinks]);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
