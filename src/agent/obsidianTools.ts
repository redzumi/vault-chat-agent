import { App, requestUrl, TFile, TFolder } from "obsidian";
import { AgentToolExecution, ChatSearchScope, IndexedChunk, McpToolCallContext, PendingEdit } from "../core/types";
import { IndexStore } from "../core/indexStore";
import { GraphSearchEngine } from "../search/graphSearch";
import { countOccurrences, createPatchEdit, createSequentialPatchEdits, validatePatch } from "./pendingEditUtils";

const READABLE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "canvas"]);
const MAX_NEW_NOTE_CHUNK_CHARS = 2500;
const MAX_NEW_NOTE_TOTAL_CHARS = 200000;
const MAX_WEB_RESPONSE_CHARS = 750000;

interface NewNoteDraft {
  path: string;
  summary: string;
  chunks: string[];
  createdAt: number;
}

export class ObsidianAgentTools {
  private readonly newNoteDrafts = new Map<string, NewNoteDraft>();

  constructor(
    private readonly app: App,
    private readonly indexStore: IndexStore,
    private readonly searchEngine: GraphSearchEngine,
    private readonly getTopK: () => number,
  ) {}

  async execute(toolName: string, args: Record<string, unknown>, context?: McpToolCallContext): Promise<AgentToolExecution> {
    switch (toolName) {
      case "searchNotes":
        return this.searchNotes(args, context?.searchScope);
      case "getCurrentNote":
        return this.getCurrentNote();
      case "openCurrentNote":
        return this.openCurrentNote(args);
      case "openNote":
        return this.openNote(args);
      case "listFolder":
        return this.listFolder(args);
      case "getLinks":
        return this.getLinks(args);
      case "readUrl":
        return this.readUrl(args);
      case "readYouTubeTranscript":
        return this.readYouTubeTranscript(args);
      case "getVaultOverview":
        return { content: this.indexStore.getVaultOverview(40) };
      case "beginNewNote":
        return this.beginNewNote(args);
      case "appendNewNote":
        return this.appendNewNote(args);
      case "finishNewNote":
        return this.finishNewNote(args);
      case "proposeNewNote":
        return this.proposeNewNote(args);
      case "proposeEdit":
        return this.proposeEdit(args);
      case "proposePatch":
        return this.proposePatch(args);
      case "proposePatchBatch":
        return this.proposePatchBatch(args);
      default:
        return {
          content: `Unknown tool: ${toolName}. Available tools: searchNotes, getCurrentNote, openCurrentNote, openNote, listFolder, getLinks, readUrl, readYouTubeTranscript, getVaultOverview, beginNewNote, appendNewNote, finishNewNote, proposeNewNote, proposePatch, proposePatchBatch, proposeEdit.`,
        };
    }
  }

  async applyEdit(edit: PendingEdit): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(edit.path);
    if (edit.kind === "create") {
      if (file) {
        throw new Error(`File already exists: ${edit.path}`);
      }
      await this.ensureParentFolder(edit.path);
      await this.app.vault.create(edit.path, edit.newContent);
      return;
    }

    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${edit.path}`);
    }

    const currentContent = await this.app.vault.cachedRead(file);
    if (edit.kind === "patch") {
      if (!edit.find || typeof edit.replace !== "string") {
        throw new Error(`Patch data is incomplete: ${edit.path}`);
      }
      const matchCount = countOccurrences(currentContent, edit.find);
      if (matchCount !== 1) {
        throw new Error(`Patch no longer applies cleanly to ${edit.path}; find text matched ${matchCount} times.`);
      }
      await this.app.vault.modify(file, currentContent.replace(edit.find, edit.replace));
      return;
    }

    if (currentContent !== edit.originalContent) {
      throw new Error(`File changed since the edit was proposed: ${edit.path}`);
    }

    await this.app.vault.modify(file, edit.newContent);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`Cannot create folder because a file already exists at: ${current}`);
      }
      await this.app.vault.createFolder(current);
    }
  }

  private beginNewNote(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path");
    const summary = getStringArg(args, "summary") ?? "Create note";
    if (!path) {
      return { content: "Missing required argument: path." };
    }

    const notePath = normalizeNewNotePath(path);
    const error = validateNewNotePath(this.app, notePath);
    if (error) {
      return { content: error };
    }

    const draftId = `${notePath}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.newNoteDrafts.set(draftId, {
      path: notePath,
      summary,
      chunks: [],
      createdAt: Date.now(),
    });

    return {
      workingSetItems: [{ path: notePath, role: "edited", detail: summary }],
      content: [
        `Started pending new note draft ${draftId}.`,
        `Path: ${notePath}`,
        `Summary: ${summary}`,
        "Append content with appendNewNote using this draftId. Finish with finishNewNote when all content has been appended.",
      ].join("\n"),
    };
  }

  private appendNewNote(args: Record<string, unknown>): AgentToolExecution {
    const draftId = getStringArg(args, "draftId");
    const content = getTextArg(args, "content");
    if (!draftId) {
      return { content: "Missing required argument: draftId." };
    }
    if (typeof content !== "string") {
      return { content: "Missing required argument: content." };
    }

    const draft = this.newNoteDrafts.get(draftId);
    if (!draft) {
      return { content: `New note draft not found: ${draftId}` };
    }
    if (content.length > MAX_NEW_NOTE_CHUNK_CHARS) {
      return { content: `Chunk is too large (${content.length} characters). Split appendNewNote content into chunks under ${MAX_NEW_NOTE_CHUNK_CHARS} characters.` };
    }
    const currentLength = draft.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (currentLength + content.length > MAX_NEW_NOTE_TOTAL_CHARS) {
      return { content: `New note draft is too large; maximum is ${MAX_NEW_NOTE_TOTAL_CHARS} characters.` };
    }

    draft.chunks.push(content);
    return {
      workingSetItems: [{ path: draft.path, role: "edited", detail: `Appended draft chunk ${draft.chunks.length}` }],
      content: [`Appended chunk ${draft.chunks.length} to ${draft.path}.`, `Current draft length: ${currentLength + content.length} characters.`].join("\n"),
    };
  }

  private finishNewNote(args: Record<string, unknown>): AgentToolExecution {
    const draftId = getStringArg(args, "draftId");
    if (!draftId) {
      return { content: "Missing required argument: draftId." };
    }

    const draft = this.newNoteDrafts.get(draftId);
    if (!draft) {
      return { content: `New note draft not found: ${draftId}` };
    }
    if (draft.chunks.length === 0) {
      return { content: `New note draft has no content: ${draftId}` };
    }

    const error = validateNewNotePath(this.app, draft.path);
    if (error) {
      return { content: error };
    }

    this.newNoteDrafts.delete(draftId);
    const pendingEdit = createNewNoteEdit(draft.path, draft.summary, draft.chunks.join(""));
    return {
      pendingEdit,
      workingSetItems: [{ path: draft.path, role: "edited", detail: draft.summary }],
      content: [
        `Prepared a pending new note for ${draft.path}.`,
        `Summary: ${draft.summary}`,
        `Content chunks: ${draft.chunks.length}`,
        "The note has not been created. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private proposeNewNote(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path");
    const content = getTextArg(args, "content");
    const summary = getStringArg(args, "summary") ?? "Create note";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof content !== "string") {
      return { content: "Missing required argument: content." };
    }
    if (content.length > MAX_NEW_NOTE_CHUNK_CHARS) {
      return {
        content: `Content is too large for proposeNewNote (${content.length} characters). Use beginNewNote, appendNewNote chunks, and finishNewNote instead.`,
      };
    }
    const notePath = normalizeNewNotePath(path);
    const error = validateNewNotePath(this.app, notePath);
    if (error) {
      return { content: error };
    }

    const pendingEdit = createNewNoteEdit(notePath, summary, content);
    return {
      pendingEdit,
      workingSetItems: [{ path: notePath, role: "edited", detail: summary }],
      content: [
        `Prepared a pending new note for ${notePath}.`,
        `Summary: ${summary}`,
        "The note has not been created. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private searchNotes(args: Record<string, unknown>, searchScope: ChatSearchScope | undefined): AgentToolExecution {
    const query = getStringArg(args, "query");
    const topK = getNumberArg(args, "topK") ?? this.getTopK();
    const folder = getStringArg(args, "folder");
    if (!query) {
      return { content: "Missing required argument: query." };
    }

    const scopeFilter = folder ? createFolderFilter(folder) : createScopeFilter(searchScope);
    const sources = this.searchEngine.search(query, Math.max(1, Math.min(20, topK)), scopeFilter);
    if (sources.length === 0) {
      const scopeDescription = folder ? `folder ${folder}` : describeSearchScope(searchScope);
      return { content: `No indexed chunks matched query${scopeDescription ? ` in ${scopeDescription}` : ""}: ${query}` };
    }

    const scopeDescription = folder ? `folder ${folder}` : describeSearchScope(searchScope);
    return {
      sources,
      workingSetItems: unique(sources.map((result) => result.chunk.filePath)).map((path) => ({
        path,
        role: "searched",
        detail: `Matched query: ${query}`,
      })),
      content: [
        scopeDescription ? `Scope: ${scopeDescription}` : "",
        sources
        .map((result, index) => {
          const chunk = result.chunk;
          const heading = chunk.headings.length ? `\nSection: ${chunk.headings.join(" > ")}` : "";
          return `[${index + 1}] ${chunk.filePath}${heading}\nScore: ${result.score.toFixed(3)}\n${clip(chunk.content, 1200)}`;
        })
          .join("\n\n---\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  private getCurrentNote(): AgentToolExecution {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return { content: "No active note is available." };
    }

    return {
      workingSetItems: [{ path: file.path, role: "current", detail: "Current active note" }],
      content: [`Current note: ${file.path}`, `Extension: .${file.extension}`, `Size: ${file.stat.size} bytes`].join("\n"),
    };
  }

  private openCurrentNote(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return Promise.resolve({ content: "No active note is available." });
    }

    return this.openNote({ ...args, path: file.path });
  }

  private async openNote(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const maxChars = getNumberArg(args, "maxChars") ?? 6000;
    if (!path) {
      return { content: "Missing required argument: path." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }

    const document = this.indexStore.getAllDocuments().find((item) => item.path === file.path);
    const metadata = document
      ? [
          `Path: ${document.path}`,
          `Extension: .${document.extension}`,
          `Status: ${document.status}`,
          document.tags.length ? `Tags: ${document.tags.join(", ")}` : "",
          document.aliases.length ? `Aliases: ${document.aliases.join(", ")}` : "",
          document.links.length ? `Links: ${document.links.join(", ")}` : "",
          document.headings.length ? `Headings: ${document.headings.join(" > ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `Path: ${file.path}\nExtension: .${file.extension}`;

    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `${metadata}\n\nThis file is tracked as metadata-only and is not readable as text.` };
    }

    const content = await this.app.vault.cachedRead(file);
    return {
      workingSetItems: [{ path: file.path, role: "opened", detail: "Opened file content" }],
      content: `${metadata}\n\nCONTENT:\n${clip(content, Math.max(1000, Math.min(20000, maxChars)))}`,
    };
  }

  private listFolder(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path") ?? "";
    const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) {
      return { content: `Folder not found: ${path}` };
    }

    const children = folder.children
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 120)
      .map((child) => {
        if (child instanceof TFolder) {
          return `- [folder] ${child.path}`;
        }
        if (child instanceof TFile) {
          return `- [file] ${child.path} (${child.stat.size} bytes)`;
        }
        return `- ${child.path}`;
      });

    return {
      workingSetItems: [{ path: folder.path || "/", role: "listed", detail: "Listed folder" }],
      content: children.length ? children.join("\n") : `Folder is empty: ${folder.path || "/"}`,
    };
  }

  private getLinks(args: Record<string, unknown>): AgentToolExecution {
    const path = getStringArg(args, "path");
    if (!path) {
      return { content: "Missing required argument: path." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const outgoing = [
      ...(cache?.links ?? []).map((link) => link.link),
      ...(cache?.embeds ?? []).map((embed) => embed.link),
    ];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const backlinks = Object.entries(resolvedLinks)
      .filter(([, targets]) => Object.prototype.hasOwnProperty.call(targets, file.path))
      .map(([sourcePath]) => sourcePath);

    return {
      workingSetItems: [{ path: file.path, role: "linked", detail: "Inspected links and backlinks" }],
      content: [
        `Links for ${file.path}`,
        "",
        "Outgoing:",
        unique(outgoing).map((link) => `- ${link}`).join("\n") || "None",
        "",
        "Backlinks:",
        unique(backlinks).map((link) => `- ${link}`).join("\n") || "None",
      ].join("\n"),
    };
  }

  private async readUrl(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const requestedUrl = getStringArg(args, "url");
    const maxChars = clampMaxChars(getNumberArg(args, "maxChars") ?? 12000);
    const url = parseHttpUrl(requestedUrl);
    if (!url) {
      return { content: "Missing or invalid URL. Only public http:// and https:// URLs are supported." };
    }

    const result = await fetchText(url.toString());
    if (!result.ok) {
      return { content: `Could not read URL: ${result.error}` };
    }

    const extracted = extractReadableWebText(result.text, result.contentType, result.url);
    return {
      workingSetItems: [{ path: result.url, role: "web", detail: "Read URL content" }],
      content: [
        "URL CONTENT",
        `URL: ${result.url}`,
        extracted.title ? `Title: ${extracted.title}` : "",
        `Content-Type: ${result.contentType || "unknown"}`,
        "",
        clip(extracted.text, maxChars),
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    };
  }

  private async readYouTubeTranscript(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const requestedUrl = getStringArg(args, "url");
    const language = getStringArg(args, "language");
    const maxChars = clampMaxChars(getNumberArg(args, "maxChars") ?? 16000);
    const url = parseHttpUrl(requestedUrl);
    if (!url || !isYouTubeUrl(url)) {
      return { content: "Missing or invalid YouTube URL." };
    }

    const videoPage = await fetchText(url.toString());
    if (!videoPage.ok) {
      return { content: `Could not read YouTube page: ${videoPage.error}` };
    }

    const playerResponse = extractYouTubePlayerResponse(videoPage.text);
    if (!playerResponse) {
      return {
        workingSetItems: [{ path: videoPage.url, role: "web", detail: "Tried to inspect YouTube video" }],
        content: "Could not find YouTube player metadata on the page.",
      };
    }

    const captionTracks = getYouTubeCaptionTracks(playerResponse);
    if (captionTracks.length === 0) {
      const title = getNestedString(playerResponse, ["videoDetails", "title"]);
      return {
        workingSetItems: [{ path: videoPage.url, role: "web", detail: "YouTube video has no available captions" }],
        content: [
          "YOUTUBE TRANSCRIPT",
          `URL: ${videoPage.url}`,
          title ? `Title: ${title}` : "",
          "",
          "No caption tracks were available for this video.",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      };
    }

    const track = chooseCaptionTrack(captionTracks, language);
    const transcriptUrl = withCaptionFormat(track.baseUrl, "json3");
    const transcriptResponse = await fetchText(transcriptUrl);
    if (!transcriptResponse.ok) {
      return {
        workingSetItems: [{ path: videoPage.url, role: "web", detail: "Tried to read YouTube transcript" }],
        content: `Could not fetch YouTube captions: ${transcriptResponse.error}`,
      };
    }

    const transcript = parseYouTubeTranscript(transcriptResponse.text);
    if (!transcript.trim()) {
      return {
        workingSetItems: [{ path: videoPage.url, role: "web", detail: "YouTube transcript was empty" }],
        content: "YouTube captions were found, but the transcript text was empty or could not be parsed.",
      };
    }

    const title = getNestedString(playerResponse, ["videoDetails", "title"]);
    const author = getNestedString(playerResponse, ["videoDetails", "author"]);
    return {
      workingSetItems: [{ path: videoPage.url, role: "web", detail: `Read YouTube transcript (${track.languageCode})` }],
      content: [
        "YOUTUBE TRANSCRIPT",
        `URL: ${videoPage.url}`,
        title ? `Title: ${title}` : "",
        author ? `Author: ${author}` : "",
        `Caption language: ${track.name || track.languageCode}${track.kind === "asr" ? " (auto-generated)" : ""}`,
        "",
        clip(transcript, maxChars),
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    };
  }

  private async proposeEdit(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const newContent = getTextArg(args, "newContent");
    const summary = getStringArg(args, "summary") ?? "Proposed edit";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof newContent !== "string") {
      return { content: "Missing required argument: newContent." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }
    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `Cannot propose text edits for metadata-only file: ${path}` };
    }

    const originalContent = await this.app.vault.cachedRead(file);
    const pendingEdit: PendingEdit = {
      id: `${file.path}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      path: file.path,
      kind: "full",
      summary,
      originalContent,
      newContent,
      createdAt: Date.now(),
    };

    return {
      pendingEdit,
      workingSetItems: [{ path: file.path, role: "edited", detail: summary }],
      content: [
        `Prepared a pending edit for ${file.path}.`,
        `Summary: ${summary}`,
        "The edit has not been applied. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private async proposePatch(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const path = getStringArg(args, "path");
    const find = getTextArg(args, "find");
    const replace = getTextArg(args, "replace");
    const summary = getStringArg(args, "summary") ?? "Proposed patch";
    if (!path) {
      return { content: "Missing required argument: path." };
    }
    if (typeof find !== "string" || find.length === 0) {
      return { content: "Missing required argument: find." };
    }
    if (typeof replace !== "string") {
      return { content: "Missing required argument: replace." };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { content: `File not found: ${path}` };
    }
    if (!READABLE_EXTENSIONS.has(file.extension)) {
      return { content: `Cannot propose text patches for metadata-only file: ${path}` };
    }

    const originalContent = await this.app.vault.cachedRead(file);
    const error = validatePatch(originalContent, find, file.path);
    if (error) {
      return {
        content: error,
      };
    }

    const pendingEdit = createPatchEdit(file.path, summary, originalContent, find, replace);

    return {
      pendingEdit,
      workingSetItems: [{ path: file.path, role: "edited", detail: summary }],
      content: [
        `Prepared a pending patch for ${file.path}.`,
        `Summary: ${summary}`,
        "The patch has not been applied. The user must review and apply it.",
      ].join("\n"),
    };
  }

  private async proposePatchBatch(args: Record<string, unknown>): Promise<AgentToolExecution> {
    const summary = getStringArg(args, "summary") ?? "Proposed patch batch";
    const patches = Array.isArray(args.patches) ? args.patches : [];
    if (patches.length === 0) {
      return { content: "Missing required argument: patches." };
    }
    if (patches.length > 20) {
      return { content: "Patch batch rejected: at most 20 patches are allowed at once." };
    }

    const currentByPath = new Map<string, string>();
    const stagedByPath = new Map<string, string>();
    const pendingInputs: Array<{ path: string; summary: string; originalContent: string; find: string; replace: string }> = [];

    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      if (!isRecord(patch)) {
        return { content: `Patch batch rejected: patch ${index + 1} must be an object.` };
      }

      const path = getStringArg(patch, "path");
      const find = getTextArg(patch, "find");
      const replace = getTextArg(patch, "replace");
      const patchSummary = getStringArg(patch, "summary") ?? summary;
      if (!path || typeof find !== "string" || find.length === 0 || typeof replace !== "string") {
        return { content: `Patch batch rejected: patch ${index + 1} requires path, find, and replace.` };
      }

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        return { content: `Patch batch rejected: file not found: ${path}` };
      }
      if (!READABLE_EXTENSIONS.has(file.extension)) {
        return { content: `Patch batch rejected: cannot patch metadata-only file: ${path}` };
      }

      const originalContent = currentByPath.get(file.path) ?? (await this.app.vault.cachedRead(file));
      currentByPath.set(file.path, originalContent);
      const stagedContent = stagedByPath.get(file.path) ?? originalContent;
      const error = validatePatch(stagedContent, find, file.path, index + 1);
      if (error) {
        return { content: error };
      }

      stagedByPath.set(file.path, stagedContent.replace(find, replace));
      pendingInputs.push({ path: file.path, summary: patchSummary, originalContent, find, replace });
    }

    const pendingEdits = createSequentialPatchEdits(pendingInputs);
    return {
      pendingEdits,
      workingSetItems: unique(pendingEdits.map((edit) => edit.path)).map((path) => ({
        path,
        role: "edited",
        detail: summary,
      })),
      content: [
        `Prepared ${pendingEdits.length} pending patches.`,
        `Summary: ${summary}`,
        "The patches have not been applied. The user must review and apply them.",
      ].join("\n"),
    };
  }
}

function getStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getTextArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface FetchTextResult {
  ok: boolean;
  url: string;
  contentType: string;
  text: string;
  error?: string;
}

interface ReadableWebText {
  title?: string;
  text: string;
}

interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string;
}

function parseHttpUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isYouTubeUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "music.youtube.com" || hostname === "youtu.be";
}

async function fetchText(url: string): Promise<FetchTextResult> {
  try {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        Accept: "text/html,text/plain,application/json,application/xml,text/xml,*/*",
      },
      throw: false,
    });
    const contentType = getHeader(response.headers, "content-type");
    if (response.status >= 400) {
      return {
        ok: false,
        url,
        contentType,
        text: "",
        error: `HTTP ${response.status}`,
      };
    }

    const text = response.text;
    return {
      ok: true,
      url,
      contentType,
      text: text.length > MAX_WEB_RESPONSE_CHARS ? text.slice(0, MAX_WEB_RESPONSE_CHARS) : text,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      contentType: "",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractReadableWebText(content: string, contentType: string, url: string): ReadableWebText {
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes("text/html") || looksLikeHtml(content)) {
    return extractHtmlText(content);
  }
  if (normalizedContentType.includes("json")) {
    return { title: url, text: prettyJson(content) };
  }
  return { title: url, text: normalizeWhitespace(decodeHtmlEntities(content)) };
}

function getHeader(headers: Record<string, string>, name: string): string {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return "";
}

function looksLikeHtml(content: string): boolean {
  return /<!doctype html|<html[\s>]|<body[\s>]/i.test(content.slice(0, 1000));
}

function extractHtmlText(html: string): ReadableWebText {
  const title = decodeHtmlEntities(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? "").trim();
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const node of Array.from(doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, form, iframe"))) {
        node.remove();
      }
      const main = doc.querySelector("article, main, [role='main']") ?? doc.body;
      return {
        title: doc.title.trim() || title,
        text: normalizeWhitespace(main?.textContent ?? ""),
      };
    } catch {
      return { title, text: extractHtmlTextWithRegex(html) };
    }
  }
  return { title, text: extractHtmlTextWithRegex(html) };
}

function extractHtmlTextWithRegex(html: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|main)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content) as unknown, null, 2);
  } catch {
    return normalizeWhitespace(content);
  }
}

function extractYouTubePlayerResponse(html: string): Record<string, unknown> | null {
  const markers = ["ytInitialPlayerResponse =", "ytInitialPlayerResponse="];
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index < 0) {
      continue;
    }
    const objectStart = html.indexOf("{", index + marker.length);
    if (objectStart < 0) {
      continue;
    }
    const json = extractBalancedJsonObject(html, objectStart);
    if (!json) {
      continue;
    }
    try {
      const parsed = JSON.parse(json) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractBalancedJsonObject(value: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
}

function getYouTubeCaptionTracks(playerResponse: Record<string, unknown>): YouTubeCaptionTrack[] {
  const tracks = getNestedValue(playerResponse, ["captions", "playerCaptionsTracklistRenderer", "captionTracks"]);
  if (!Array.isArray(tracks)) {
    return [];
  }
  return tracks.flatMap((track): YouTubeCaptionTrack[] => {
    if (!isRecord(track)) {
      return [];
    }
    const baseUrl = typeof track.baseUrl === "string" ? track.baseUrl : "";
    const languageCode = typeof track.languageCode === "string" ? track.languageCode : "";
    if (!baseUrl || !languageCode) {
      return [];
    }
    return [
      {
        baseUrl,
        languageCode,
        name: extractCaptionTrackName(track) || languageCode,
        kind: typeof track.kind === "string" ? track.kind : undefined,
      },
    ];
  });
}

function extractCaptionTrackName(track: Record<string, unknown>): string {
  const simpleText = getNestedString(track, ["name", "simpleText"]);
  if (simpleText) {
    return simpleText;
  }
  const runs = getNestedValue(track, ["name", "runs"]);
  if (!Array.isArray(runs)) {
    return "";
  }
  return runs
    .map((run) => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
    .join("")
    .trim();
}

function chooseCaptionTrack(tracks: YouTubeCaptionTrack[], preferredLanguage: string | undefined): YouTubeCaptionTrack {
  const preferred = preferredLanguage?.toLowerCase();
  if (preferred) {
    const exact = tracks.find((track) => track.languageCode.toLowerCase() === preferred);
    if (exact) {
      return exact;
    }
    const prefix = tracks.find((track) => track.languageCode.toLowerCase().startsWith(`${preferred}-`));
    if (prefix) {
      return prefix;
    }
  }
  return tracks.find((track) => track.kind !== "asr") ?? tracks[0];
}

function withCaptionFormat(baseUrl: string, format: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", format);
    return url.toString();
  } catch {
    return baseUrl.includes("?") ? `${baseUrl}&fmt=${format}` : `${baseUrl}?fmt=${format}`;
  }
}

function parseYouTubeTranscript(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.events)) {
      return normalizeWhitespace(
        parsed.events
          .flatMap((event) => {
            if (!isRecord(event) || !Array.isArray(event.segs)) {
              return [];
            }
            return event.segs.map((seg) => (isRecord(seg) && typeof seg.utf8 === "string" ? seg.utf8 : ""));
          })
          .join(""),
      );
    }
  } catch {
    return parseXmlTranscript(content);
  }
  return parseXmlTranscript(content);
}

function parseXmlTranscript(content: string): string {
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(content, "text/xml");
      return normalizeWhitespace(Array.from(doc.querySelectorAll("text")).map((node) => node.textContent ?? "").join(" "));
    } catch {
      return parseXmlTranscriptWithRegex(content);
    }
  }
  return parseXmlTranscriptWithRegex(content);
}

function parseXmlTranscriptWithRegex(content: string): string {
  return normalizeWhitespace(
    Array.from(content.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi), (match) => decodeHtmlEntities(match[1])).join(" "),
  );
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function getNestedString(value: unknown, path: string[]): string {
  const nested = getNestedValue(value, path);
  return typeof nested === "string" ? nested.trim() : "";
}

function matchFirst(value: string, pattern: RegExp): string | null {
  const match = value.match(pattern);
  return match?.[1] ?? null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, raw: string) => {
    const key = raw.toLowerCase();
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[key] ?? entity;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff;
}

function clampMaxChars(value: number): number {
  return Math.max(1000, Math.min(30000, Math.floor(value)));
}

function pathExtension(path: string): string {
  const lastPart = path.split("/").pop() ?? "";
  const dotIndex = lastPart.lastIndexOf(".");
  return dotIndex >= 0 ? lastPart.slice(dotIndex + 1).toLowerCase() : "md";
}

function normalizeNewNotePath(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!normalized) {
    return "";
  }
  const lastPart = normalized.split("/").pop() ?? "";
  return lastPart.includes(".") ? normalized : `${normalized}.md`;
}

function validateNewNotePath(app: App, path: string): string | null {
  if (!path) {
    return "Missing required argument: path.";
  }
  if (!READABLE_EXTENSIONS.has(pathExtension(path))) {
    return `Cannot create metadata-only file as a text note: ${path}`;
  }
  if (app.vault.getAbstractFileByPath(path)) {
    return `Cannot create note because a file or folder already exists at: ${path}`;
  }
  return null;
}

function createNewNoteEdit(path: string, summary: string, content: string): PendingEdit {
  return {
    id: `${path}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    path,
    kind: "create",
    summary,
    originalContent: "",
    newContent: content,
    createdAt: Date.now(),
  };
}

function clip(content: string, maxChars: number): string {
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n\n[truncated]`;
}

function createScopeFilter(searchScope: ChatSearchScope | undefined): ((chunk: IndexedChunk) => boolean) | undefined {
  if (!searchScope || searchScope.mode === "vault" || !searchScope.path) {
    return undefined;
  }

  if (searchScope.mode === "current-note") {
    return (chunk) => chunk.filePath === searchScope.path;
  }

  if (searchScope.mode === "current-folder") {
    const folderPath = searchScope.path.replace(/\/$/, "");
    if (!folderPath) {
      return undefined;
    }
    return (chunk) => chunk.filePath === folderPath || chunk.filePath.startsWith(`${folderPath}/`);
  }

  return undefined;
}

function createFolderFilter(path: string): (chunk: IndexedChunk) => boolean {
  const folderPath = path.replace(/^\/+/, "").replace(/\/$/, "");
  if (!folderPath) {
    return () => true;
  }
  return (chunk) => chunk.filePath === folderPath || chunk.filePath.startsWith(`${folderPath}/`);
}

function describeSearchScope(searchScope: ChatSearchScope | undefined): string {
  if (!searchScope || searchScope.mode === "vault") {
    return "whole vault";
  }
  if (searchScope.mode === "current-note" && searchScope.path) {
    return `current note ${searchScope.path}`;
  }
  if (searchScope.mode === "current-folder" && searchScope.path) {
    return `current folder ${searchScope.path}`;
  }
  return "";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
