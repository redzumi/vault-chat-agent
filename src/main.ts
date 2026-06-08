import { App, Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, requestUrl, SuggestModal, WorkspaceLeaf } from "obsidian";
import { ObsidianAgentTools } from "./agent/obsidianTools";
import { SemanticChunker } from "./core/chunker";
import { IndexStore } from "./core/indexStore";
import { ChatIntent, ChatSearchScopeMode, DEFAULT_SETTINGS, ExternalMcpServerSettings, ObsidianAIAssistantSettings, IndexCoverage, MediaImportOverwriteMode, PersistedIndex, SavedPrompt } from "./core/types";
import { indexVaultFiles, syncVaultIndex } from "./indexing/indexAll";
import { isIndexableVaultFileLike } from "./indexing/indexableFiles";
import { RealtimeIndexer } from "./indexing/realtimeIndexer";
import { GraphSearchEngine } from "./search/graphSearch";
import { HybridSearchEngine } from "./search/hybridSearch";
import { AIChatClient } from "./services/aiChatClient";
import { CHAT_VIEW_TYPE, ChatView } from "./ui/chatView";
import { MediaImportModal } from "./ui/mediaImportModal";
import { RELATED_NOTES_VIEW_TYPE, RelatedNotesView } from "./ui/relatedNotesView";
import { ObsidianAIAssistantSettingTab } from "./ui/settingsTab";
import { RemoteMcpManager } from "./mcp/remoteMcpClient";
import { MediaImportClient } from "./services/mediaImportClient";
import { MediaImportQueue } from "./services/mediaImportQueue";

interface PluginData {
  settings?: Partial<ObsidianAIAssistantSettings> & {
    includeContextByDefault?: boolean;
    agentModeByDefault?: boolean;
  };
  index?: PersistedIndex;
}

export default class ObsidianAIAssistantPlugin extends Plugin {
  settings: ObsidianAIAssistantSettings = { ...DEFAULT_SETTINGS };

  private chunker = new SemanticChunker(DEFAULT_SETTINGS.chunkSize, DEFAULT_SETTINGS.overlapSize);
  private readonly indexStore = new IndexStore();
  private readonly searchEngine = new HybridSearchEngine();
  private readonly graphSearchEngine = new GraphSearchEngine(this.app.vault, this.app.metadataCache, this.searchEngine);
  private readonly agentTools = new ObsidianAgentTools(
    this.app,
    this.indexStore,
    this.graphSearchEngine,
    () => this.settings.topK,
  );
  private readonly remoteMcpManager = new RemoteMcpManager(() => this.settings.externalMcpServers);
  private readonly aiChatClient = new AIChatClient(
    () => this.settings,
    () => this.indexStore.getVaultOverview(),
    undefined,
    requestUrl,
  );
  private readonly mediaImportClient = new MediaImportClient(() => this.settings);
  private readonly mediaImportQueue = new MediaImportQueue(
    this.app,
    this.mediaImportClient,
    () => this.settings,
  );
  private realtimeIndexer: RealtimeIndexer | null = null;
  private indexingPromise: Promise<void> | null = null;
  private layoutReady = false;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.rebuildChunker();
    this.searchEngine.setChunks(this.indexStore.getAllChunks());

    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new ChatView(
          leaf,
          this.aiChatClient,
          this.agentTools,
          this.remoteMcpManager,
          () => this.settings.developerMode,
          () => this.settings.collapseThinkingByDefault,
          () => {
            void this.openMediaImportModal();
          },
          this.settings.defaultIntent,
        ),
    );

    this.registerView(
      RELATED_NOTES_VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new RelatedNotesView(
          leaf,
          this.indexStore,
          this.graphSearchEngine,
          (path) => {
            void this.startRelatedNoteChat(path);
          },
        ),
    );

    this.addRibbonIcon("message-square", "Open Vault Chat Agent", () => {
      void this.activateView();
    });

    this.addRibbonIcon("network", "Open Related Notes", () => {
      void this.activateRelatedNotesView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "open-related-notes",
      name: "Open related notes",
      callback: () => {
        void this.activateRelatedNotesView();
      },
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Re-index vault",
      callback: () => {
        void this.indexVault();
      },
    });

    this.addCommand({
      id: "summarize-current-note",
      name: "Summarize current note",
      callback: () => {
        void this.runCurrentNoteTask("summarize");
      },
    });

    this.addCommand({
      id: "review-current-note",
      name: "Review current note",
      callback: () => {
        void this.runCurrentNoteTask("review");
      },
    });

    this.addCommand({
      id: "extract-tasks-current-note",
      name: "Extract tasks from current note",
      callback: () => {
        void this.runCurrentNoteTask("tasks");
      },
    });

    this.addCommand({
      id: "improve-current-note",
      name: "Propose improvements to current note",
      callback: () => {
        void this.runCurrentNoteTask("improve");
      },
    });

    this.addCommand({
      id: "text-summarize-selection",
      name: "Text: summarize selection",
      editorCallback: (editor, ctx) => {
        void this.runEditorTextTask(editor, ctx, "summarize");
      },
    });

    this.addCommand({
      id: "text-professional-selection",
      name: "Text: make selection professional",
      editorCallback: (editor, ctx) => {
        void this.runEditorTextTask(editor, ctx, "professional");
      },
    });

    this.addCommand({
      id: "text-action-items-selection",
      name: "Text: extract action items from selection",
      editorCallback: (editor, ctx) => {
        void this.runEditorTextTask(editor, ctx, "action-items");
      },
    });

    this.addCommand({
      id: "text-edit-selection",
      name: "Text: edit selection with prompt",
      editorCallback: (editor, ctx) => {
        void this.runSavedPrompt(editor, ctx, "edit");
      },
    });

    this.addCommand({
      id: "prompt-run-saved",
      name: "Prompt: run saved prompt",
      editorCallback: (editor, ctx) => {
        void this.runSavedPrompt(editor, ctx);
      },
    });

    this.addCommand({
      id: "workflow-weekly-review",
      name: "Workflow: draft weekly review",
      callback: () => {
        void this.runWorkflow("weekly-review");
      },
    });

    this.addCommand({
      id: "workflow-meeting-tasks",
      name: "Workflow: meeting notes to tasks",
      callback: () => {
        void this.runWorkflow("meeting-tasks");
      },
    });

    this.addCommand({
      id: "workflow-project-status",
      name: "Workflow: draft project status",
      callback: () => {
        void this.runWorkflow("project-status");
      },
    });

    this.addSettingTab(new ObsidianAIAssistantSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      void this.activateView();
      void this.syncIndex()
        .catch((error) => {
          console.error("Vault Chat Agent startup index sync failed", error);
          new Notice("Vault Chat Agent: startup index sync failed. See console for details.", 6000);
        })
        .finally(() => {
          this.configureRealtimeIndexer();
        });
    });
  }

  onunload(): void {
    this.realtimeIndexer?.stop();
    void this.remoteMcpManager.close();
  }

  async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = migrateSettings(data?.settings);
    this.indexStore.load(data?.index);
    if (this.pruneExcludedIndexEntries()) {
      await this.savePluginData();
    }
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      index: this.indexStore.toPersistedIndex(),
    } satisfies PluginData);
  }

  async indexVault(): Promise<void> {
    if (this.indexingPromise) {
      new Notice("Vault Chat Agent: indexing is already running.", 3000);
      return this.indexingPromise;
    }

    this.indexingPromise = this.indexVaultNow();
    try {
      await this.indexingPromise;
    } finally {
      this.indexingPromise = null;
    }
  }

  async syncIndex(): Promise<void> {
    if (this.indexingPromise) {
      return this.indexingPromise;
    }

    this.indexingPromise = this.syncIndexNow();
    try {
      await this.indexingPromise;
    } finally {
      this.indexingPromise = null;
    }
  }

  private async indexVaultNow(): Promise<void> {
    this.rebuildChunker();
    const indexed = await indexVaultFiles(this.app.vault, this.app.metadataCache, this.chunker, this.indexStore);
    this.searchEngine.setChunks(this.indexStore.getAllChunks());
    await this.savePluginData();
    new Notice(`Vault Chat Agent: indexed ${indexed.indexedFiles}/${indexed.totalFiles} files.`, 3000);
  }

  private async syncIndexNow(): Promise<void> {
    this.rebuildChunker();
    const result = await syncVaultIndex(this.app.vault, this.app.metadataCache, this.chunker, this.indexStore);
    this.searchEngine.setChunks(this.indexStore.getAllChunks());
    if (result.changedFiles > 0 || result.deletedFiles > 0) {
      await this.savePluginData();
    }
  }

  configureRealtimeIndexer(): void {
    this.realtimeIndexer?.stop();
    this.realtimeIndexer = null;

    if (!this.settings.realtimeIndexing || !this.layoutReady || this.indexingPromise) {
      return;
    }

    this.rebuildChunker();
    this.realtimeIndexer = new RealtimeIndexer(
      this.app.vault,
      this.app.metadataCache,
      this.chunker,
      this.indexStore,
      () => this.savePluginData(),
      () => this.searchEngine.setChunks(this.indexStore.getAllChunks()),
      (eventRef) => this.registerEvent(eventRef),
    );
    this.realtimeIndexer.start();
  }

  getIndexedChunkCount(): number {
    return this.indexStore.getAllChunks().length;
  }

  getIndexCoverage(): IndexCoverage {
    return this.indexStore.getCoverage();
  }

  async testMarkitdownConnection(): Promise<void> {
    await this.mediaImportClient.checkHealth();
  }

  refreshChatViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) {
        leaf.view.refreshDeveloperMode();
      }
    }
  }

  private rebuildChunker(): void {
    this.chunker = new SemanticChunker(this.settings.chunkSize, this.settings.overlapSize);
  }

  private pruneExcludedIndexEntries(): boolean {
    let changed = false;
    for (const document of this.indexStore.getAllDocuments()) {
      if (!isIndexableVaultFileLike({ path: document.path, stat: { size: document.size } }, { configDir: this.app.vault.configDir })) {
        this.indexStore.deleteFile(document.path);
        changed = true;
      }
    }
    return changed;
  }

  private async activateView(): Promise<ChatView | null> {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Vault Chat Agent: could not open chat pane.", 4000);
        return null;
      }
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  private async activateRelatedNotesView(): Promise<RelatedNotesView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RELATED_NOTES_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Vault Chat Agent: could not open related notes pane.", 4000);
        return null;
      }
      await leaf.setViewState({ type: RELATED_NOTES_VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view instanceof RelatedNotesView ? leaf.view : null;
    await view?.refresh();
    return view;
  }

  private async openMediaImportModal(): Promise<void> {
    const chatView = await this.activateView();
    new MediaImportModal(this.app, this.mediaImportQueue, (path) => {
      chatView?.mentionPath(path);
    }).open();
  }

  private async startRelatedNoteChat(path: string): Promise<void> {
    const view = await this.activateView();
    if (!view) {
      return;
    }
    view.startTask(`Use openNote on "${path}" first. Then answer: what are the main points in this related note, and why might it be relevant to my current note or selected text? Cite "${path}".`, "ask");
  }

  private async runCurrentNoteTask(task: "summarize" | "review" | "tasks" | "improve"): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Vault Chat Agent: no active note.", 3000);
      return;
    }

    const view = await this.activateView();
    if (!view) {
      return;
    }

    view.startTask(this.buildCurrentNotePrompt(task, file.path), this.getCurrentNoteTaskIntent(task));
  }

  private async runEditorTextTask(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, task: "summarize" | "professional" | "action-items"): Promise<void> {
    const view = await this.activateView();
    if (!view) {
      return;
    }

    const prompt = this.buildEditorTextPrompt(editor, ctx, task);
    view.startTask(prompt, task === "professional" ? "edit" : "ask");
  }

  private async runSavedPrompt(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, forcedIntent?: ChatIntent): Promise<void> {
    const prompts = this.settings.savedPrompts.filter((prompt) => prompt.title.trim() && prompt.prompt.trim());
    if (prompts.length === 0) {
      new Notice("Vault Chat Agent: add a saved prompt in settings first.", 4000);
      return;
    }

    new SavedPromptPickerModal(this.app, prompts, async (savedPrompt) => {
      const view = await this.activateView();
      if (!view) {
        return;
      }
      const intent = forcedIntent ?? savedPrompt.intent;
      view.startTask(this.buildSavedPromptMessage(editor, ctx, savedPrompt, intent), intent);
    }).open();
  }

  private async runWorkflow(workflow: "weekly-review" | "meeting-tasks" | "project-status"): Promise<void> {
    const view = await this.activateView();
    if (!view) {
      return;
    }

    const file = this.app.workspace.getActiveFile();
    const scope = getWorkflowScope(workflow, Boolean(file));
    view.startTask(this.buildWorkflowPrompt(workflow, file?.path), "edit", scope);
  }

  private getCurrentNoteTaskIntent(task: "summarize" | "review" | "tasks" | "improve"): ChatIntent {
    return task === "improve" ? "edit" : "ask";
  }

  private buildCurrentNotePrompt(task: "summarize" | "review" | "tasks" | "improve", path: string): string {
    switch (task) {
      case "summarize":
        return `Summarize current note: ${path}\n\nUse openNote on "${path}" first. Treat it as the current note. Summarize it clearly, cite the file path, and mention any obvious missing context from linked notes.`;
      case "review":
        return `Review current note: ${path}\n\nUse openNote on "${path}" first. Treat it as the current note. Review it for clarity, structure, contradictions, stale TODOs, and missing links. Do not edit unless I ask; give concrete suggestions with section references.`;
      case "tasks":
        return `Extract tasks from current note: ${path}\n\nUse openNote on "${path}" first. Treat it as the current note. Extract actionable tasks from the note. Group them by urgency when possible and cite the file path. Do not edit the file.`;
      case "improve":
        return `Propose improvements to current note: ${path}\n\nUse openNote on "${path}" first. Treat it as the current note. Propose concrete improvements to this note. If small text edits are useful, use proposePatch or proposePatchBatch so I can review them before applying.`;
    }
  }

  private buildEditorTextPrompt(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, task: "summarize" | "professional" | "action-items"): string {
    const path = getEditorPath(ctx) ?? this.app.workspace.getActiveFile()?.path ?? "";
    const selection = editor.getSelection().trim();
    const target = selection ? "selected text" : "current note";
    const contentBlock = selection ? `\n\nSelected text:\n\n${selection}` : "";
    const noteInstruction = path ? `Use openNote on "${path}" if you need surrounding context. Cite "${path}" in the response.` : "Use the active note if you need surrounding context.";

    switch (task) {
      case "summarize":
        return `Summarize the ${target} clearly and preserve the important details.\n\n${noteInstruction}${contentBlock}`;
      case "action-items":
        return `Extract actionable tasks from the ${target}. Group them by urgency or owner when the text supports it. Do not edit the file.\n\n${noteInstruction}${contentBlock}`;
      case "professional":
        return selection && path
          ? `Rewrite the selected text in a more professional, polished tone. Use openNote on "${path}" first, then proposePatch replacing exactly the selected text below. Keep the meaning intact.\n\nSelected text:\n\n${selection}`
          : `Review the current note and propose small patch edits that make the writing more professional and polished.\n\n${noteInstruction}`;
    }
  }

  private buildSavedPromptMessage(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, savedPrompt: SavedPrompt, intent: ChatIntent): string {
    const path = getEditorPath(ctx) ?? this.app.workspace.getActiveFile()?.path ?? "";
    const selection = editor.getSelection().trim();
    const context = selection
      ? `Selected text:\n\n${selection}`
      : path
        ? `No text is selected. Use openNote on "${path}" and treat it as the target note.`
        : "No text is selected and no active note path is available.";
    const editInstruction =
      intent === "edit" && selection && path
        ? `\n\nIf you edit the selected text, use proposePatch on "${path}" and replace exactly the selected text.`
        : "";

    return [`Run saved prompt: ${savedPrompt.title}`, savedPrompt.prompt, context + editInstruction].join("\n\n");
  }

  private buildWorkflowPrompt(workflow: "weekly-review" | "meeting-tasks" | "project-status", activePath: string | undefined): string {
    const date = formatDateForPath(new Date());
    const activeNote = activePath ? `"${activePath}"` : "the active note if one is available";
    const activeFolder = activePath ? `"${folderPath(activePath) || "/"}"` : "the vault";

    switch (workflow) {
      case "weekly-review":
        return [
          `Workflow: weekly review for ${activeFolder}.`,
          "Use searchNotes and openNote to gather relevant notes from the current scope.",
          "Look for accomplishments, decisions, open loops, blockers, stale TODOs, and next actions.",
          `Prepare a pending new note at "Reviews/Weekly Review ${date}.md" with sections: Wins, Decisions, Open loops, Blockers, Next actions, Source notes.`,
          "Do not apply the edit. The note must stay pending for review.",
        ].join("\n\n");
      case "meeting-tasks":
        return [
          `Workflow: meeting notes to tasks from ${activeNote}.`,
          activePath ? `Use openNote on ${activeNote} first.` : "Use getCurrentNote and openCurrentNote first.",
          "Extract decisions, action items, owners, due dates, follow-ups, and unresolved questions. Preserve uncertainty instead of inventing missing owners or dates.",
          `Prepare a pending new note at "Tasks/Meeting Tasks ${date}.md" with sections: Decisions, Action items, Follow-ups, Questions, Source.`,
          "Do not apply the edit. The note must stay pending for review.",
        ].join("\n\n");
      case "project-status":
        return [
          `Workflow: project status summary for ${activeFolder}.`,
          "Use listFolder, searchNotes, and openNote to inspect project-relevant notes in the current scope.",
          "Summarize progress, recent decisions, risks, blockers, timeline signals, and recommended next steps. Cite source note paths.",
          `Prepare a pending new note at "Status/Project Status ${date}.md" with sections: Summary, Progress, Decisions, Risks, Blockers, Next steps, Source notes.`,
          "Do not apply the edit. The note must stay pending for review.",
        ].join("\n\n");
    }
  }
}

class SavedPromptPickerModal extends SuggestModal<SavedPrompt> {
  constructor(
    app: App,
    private readonly prompts: SavedPrompt[],
    private readonly onChoose: (prompt: SavedPrompt) => Promise<void>,
  ) {
    super(app);
    this.setPlaceholder("Search saved prompts...");
  }

  getSuggestions(query: string): SavedPrompt[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return this.prompts.slice(0, 50);
    }
    return this.prompts.filter((prompt) => `${prompt.title}\n${prompt.prompt}`.toLocaleLowerCase().includes(normalized)).slice(0, 50);
  }

  renderSuggestion(prompt: SavedPrompt, el: HTMLElement): void {
    el.createDiv({ cls: "vault-chat-agent-suggest-title", text: prompt.title });
    el.createDiv({ cls: "vault-chat-agent-suggest-note", text: `${prompt.intent === "edit" ? "Edit" : "Ask"} · ${prompt.prompt.slice(0, 120)}` });
  }

  onChooseSuggestion(prompt: SavedPrompt): void {
    void this.onChoose(prompt);
  }
}

function getEditorPath(ctx: MarkdownView | MarkdownFileInfo): string | undefined {
  return ctx.file?.path;
}

function getWorkflowScope(workflow: "weekly-review" | "meeting-tasks" | "project-status", hasActiveFile: boolean): ChatSearchScopeMode {
  if (!hasActiveFile) {
    return "vault";
  }
  return workflow === "meeting-tasks" ? "current-note" : "current-folder";
}

function folderPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function formatDateForPath(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function migrateSettings(settings: PluginData["settings"]): ObsidianAIAssistantSettings {
  const currentSettings = { ...(settings ?? {}) };
  const { agentModeByDefault, defaultIntent: storedDefaultIntent } = currentSettings;
  delete currentSettings.includeContextByDefault;
  delete currentSettings.agentModeByDefault;
  delete currentSettings.defaultIntent;
  const defaultIntent = isChatIntent(storedDefaultIntent) ? storedDefaultIntent : agentModeByDefault ? "edit" : "ask";
  return {
    ...DEFAULT_SETTINGS,
    ...currentSettings,
    defaultIntent,
    mediaImportConcurrency: normalizeMediaImportConcurrency(currentSettings.mediaImportConcurrency),
    mediaImportOverwriteMode: normalizeMediaImportOverwriteMode(currentSettings.mediaImportOverwriteMode),
    externalMcpServers: normalizeExternalMcpServers(currentSettings.externalMcpServers),
  };
}

function isChatIntent(value: unknown): value is ChatIntent {
  return value === "ask" || value === "edit";
}

function normalizeMediaImportConcurrency(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : DEFAULT_SETTINGS.mediaImportConcurrency;
}

function normalizeMediaImportOverwriteMode(value: unknown): MediaImportOverwriteMode {
  return value === "rename" || value === "overwrite" || value === "skip" ? value : DEFAULT_SETTINGS.mediaImportOverwriteMode;
}

function normalizeExternalMcpServers(value: unknown): ExternalMcpServerSettings[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ExternalMcpServerSettings[] => {
    if (!isRecord(item) || typeof item.name !== "string") {
      return [];
    }
    const name = item.name.trim() || "mcp-server";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    const apiKey = typeof item.apiKey === "string" && item.apiKey.trim() ? item.apiKey.trim() : extractFirecrawlApiKey(url);
    const provider = item.provider === "firecrawl" || isFirecrawlMcpUrl(url) || (name.toLowerCase() === "firecrawl" && Boolean(apiKey)) ? "firecrawl" : "custom";
    if (provider === "custom" && !url) {
      return [];
    }
    return [
      {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        name: provider === "firecrawl" ? "firecrawl" : name,
        provider,
        transport: "http",
        url: provider === "firecrawl" ? "" : url,
        headers: normalizeStringRecord(item.headers),
        apiKey,
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      },
    ];
  });
}

function isFirecrawlMcpUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "mcp.firecrawl.dev";
  } catch {
    return false;
  }
}

function extractFirecrawlApiKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "mcp.firecrawl.dev") {
      return undefined;
    }
    const match = url.pathname.match(/^\/([^/]+)\/v2\/mcp\/?$/);
    const apiKey = match?.[1] ? decodeURIComponent(match[1]) : "";
    return apiKey && apiKey !== "YOUR_FIRECRAWL_API_KEY" ? apiKey : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (normalizedKey && typeof itemValue === "string") {
      result[normalizedKey] = itemValue;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
