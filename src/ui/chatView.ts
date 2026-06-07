import { App, ItemView, MarkdownRenderer, Notice, setIcon, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { AgentToolExecution, AgentToolExecutor, ChatIntent, ChatRunMode, ChatSearchScope, ChatSearchScopeMode, DebugLogEntry, PendingEdit, SearchResult, WorkingSetItem } from "../core/types";
import { ObsidianMcpServer, summarizePendingEdit } from "../mcp/obsidianMcpServer";
import { RemoteMcpManager } from "../mcp/remoteMcpClient";
import { AIChatClient } from "../services/aiChatClient";
import { addMentionInstructions, ChatMention, formatMention, getMentionTrigger, MentionKind, parseMentions } from "./mentions";

export const CHAT_VIEW_TYPE = "vault-chat-agent-chat-view";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string;
  streaming?: boolean;
  error?: boolean;
}

interface MentionSuggestion {
  kind: MentionKind;
  label: string;
  detail: string;
  insertText: string;
  searchText: string;
}

interface SlashCommand {
  name: string;
  detail: string;
  acceptsPrompt: boolean;
  searchText: string;
}

type PanelId = "edits" | "workingSet" | "sources" | "debug";

export class ChatView extends ItemView {
  private messages: ChatMessage[] = [];
  private draftText = "";
  private intent: ChatIntent;
  private runMode: ChatRunMode = "direct";
  private lastSources: SearchResult[] = [];
  private searchScopeMode: ChatSearchScopeMode = "vault";
  private pendingEdits: PendingEdit[] = [];
  private draftMentions: ChatMention[] = [];
  private mentionSuggestions: MentionSuggestion[] = [];
  private selectedMentionIndex = 0;
  private commandSuggestions: SlashCommand[] = [];
  private selectedCommandIndex = 0;
  private workingSet: WorkingSetItem[] = [];
  private debugLogs: DebugLogEntry[] = [];
  private isSending = false;
  private abortController: AbortController | null = null;
  private streamingRenderTimer: number | null = null;
  private allowApplyToolsForNextMessage = false;
  private statusText = "";
  private readonly expandedPanels: Record<PanelId, boolean> = {
    edits: true,
    workingSet: false,
    sources: false,
    debug: false,
  };

  constructor(
    leaf: WorkspaceLeaf,
    private readonly aiChatClient: AIChatClient,
    private readonly agentTools: AgentToolExecutor,
    private readonly remoteMcpManager: RemoteMcpManager,
    private readonly getDeveloperMode: () => boolean,
    private readonly getCollapseThinkingByDefault: () => boolean,
    private readonly openMediaImport: () => void,
    defaultIntent: ChatIntent,
  ) {
    super(leaf);
    this.intent = defaultIntent;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Vault Chat Agent";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("vault-chat-agent-view");
    this.render();
  }

  refreshDeveloperMode(): void {
    if (!this.getDeveloperMode()) {
      this.expandedPanels.debug = false;
    }
    this.render();
  }

  startTask(content: string, intent: ChatIntent, searchScopeMode?: ChatSearchScopeMode): void {
    if (this.isSending) {
      new Notice("Vault Chat Agent is already working.", 3000);
      return;
    }

    this.intent = intent;
    if (intent !== "edit") {
      this.runMode = "direct";
    }
    if (searchScopeMode) {
      this.searchScopeMode = searchScopeMode;
    }
    void this.sendMessage(content);
  }

  private render(): void {
    this.containerEl.empty();

    const toolbar = this.containerEl.createDiv({ cls: "vault-chat-agent-toolbar" });
    this.renderIntentControl(toolbar);
    if (this.getDeveloperMode()) {
      this.renderPlanControl(toolbar);
      this.renderScopeControl(toolbar);
    }

    if (this.getDeveloperMode()) {
      const debugButton = toolbar.createEl("button", {
        cls: this.expandedPanels.debug ? "vault-chat-agent-toolbar-button is-active" : "vault-chat-agent-toolbar-button",
        attr: { "aria-label": "Show debug log" },
      });
      setIcon(debugButton, "bug");
      debugButton.onclick = () => {
        this.expandedPanels.debug = !this.expandedPanels.debug;
        this.render();
      };

      const exportButton = toolbar.createEl("button", { cls: "vault-chat-agent-toolbar-button", attr: { "aria-label": "Export chat debug data" } });
      setIcon(exportButton, "download");
      exportButton.onclick = () => {
        void this.exportDebugData().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(message, 6000);
        });
      };
    }

    const importButton = toolbar.createEl("button", {
      cls: "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Import media documents" },
    });
    setIcon(importButton, "file-input");
    importButton.onclick = () => this.openMediaImport();

    const clearButton = toolbar.createEl("button", { attr: { "aria-label": "Clear chat" } });
    setIcon(clearButton, "trash-2");
    clearButton.onclick = () => {
      this.messages = [];
      this.lastSources = [];
      this.pendingEdits = [];
      this.draftMentions = [];
      this.mentionSuggestions = [];
      this.commandSuggestions = [];
      this.workingSet = [];
      this.debugLogs = [];
      this.render();
    };

    const messagesEl = this.containerEl.createDiv({ cls: "vault-chat-agent-messages" });
    if (this.messages.length === 0) {
      messagesEl.createEl("div", {
        cls: "setting-item-description",
        text: this.getEmptyStateText(),
      });
    }

    for (const message of this.messages) {
      void this.renderMessage(messagesEl, message);
    }

    if (this.isSending) {
      messagesEl.createDiv({ cls: "vault-chat-agent-status", text: this.statusText || "Working..." });
    }

    if (this.pendingEdits.length > 0) {
      this.renderPendingEdits();
    }

    if (this.getDeveloperMode() && this.workingSet.length > 0) {
      this.renderWorkingSet();
    }

    if (this.getDeveloperMode() && this.lastSources.length > 0) {
      this.renderSources();
    }

    if (this.getDeveloperMode() && (this.expandedPanels.debug || this.debugLogs.length > 0)) {
      this.renderDebugLog();
    }

    this.renderInput();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private renderIntentControl(toolbar: HTMLElement): void {
    const intentControl = toolbar.createDiv({ cls: "vault-chat-agent-intent-control", attr: { "aria-label": "Chat intent" } });
    const intents: Array<{ intent: ChatIntent; label: string; description: string }> = [
      { intent: "ask", label: "Ask", description: "Inspect the vault with read-only tools" },
      { intent: "edit", label: "Edit", description: "Prepare reviewed changes for approval" },
    ];

    for (const item of intents) {
      const button = intentControl.createEl("button", {
        cls: `vault-chat-agent-intent-button ${this.intent === item.intent ? "is-active" : ""}`,
        text: item.label,
        attr: { "aria-label": item.description },
      });
      button.disabled = this.isSending;
      button.onclick = () => {
        this.intent = item.intent;
        if (this.intent !== "edit") {
          this.runMode = "direct";
        }
        this.render();
      };
    }
  }

  private renderPlanControl(toolbar: HTMLElement): void {
    const button = toolbar.createEl("button", {
      cls: this.runMode === "plan" ? "vault-chat-agent-toolbar-button is-active" : "vault-chat-agent-toolbar-button",
      text: "Plan",
      attr: { "aria-label": "Plan before preparing edits" },
    });
    button.disabled = this.isSending || this.intent !== "edit";
    button.onclick = () => {
      this.runMode = this.runMode === "plan" ? "direct" : "plan";
      this.render();
    };
  }

  private renderScopeControl(toolbar: HTMLElement): void {
    const scopeSelect = toolbar.createEl("select", {
      cls: "vault-chat-agent-scope-select",
      attr: { "aria-label": "Search scope" },
    });
    const scopes: Array<{ mode: ChatSearchScopeMode; label: string }> = [
      { mode: "vault", label: "Vault" },
      { mode: "current-note", label: "Note" },
      { mode: "current-folder", label: "Folder" },
    ];
    for (const scope of scopes) {
      scopeSelect.createEl("option", { value: scope.mode, text: scope.label });
    }
    scopeSelect.value = this.searchScopeMode;
    scopeSelect.disabled = this.isSending;
    scopeSelect.onchange = () => {
      this.searchScopeMode = isChatSearchScopeMode(scopeSelect.value) ? scopeSelect.value : "vault";
      this.render();
    };
  }

  private getEmptyStateText(): string {
    if (this.intent === "edit") {
      if (this.runMode === "plan") {
        return "Plan reviewed changes first. The assistant can inspect notes but cannot prepare edits until Plan is off.";
      }
      return "Ask for reviewed changes. Edits stay pending until you apply them.";
    }
    return "Ask about your vault. The assistant can inspect notes but will not prepare edits.";
  }

  private async renderMessage(parent: HTMLElement, message: ChatMessage): Promise<void> {
    const cls = [
      "vault-chat-agent-message",
      message.role === "user" ? "vault-chat-agent-message-user" : "vault-chat-agent-message-assistant",
      message.error ? "vault-chat-agent-message-error" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const messageEl = parent.createDiv({ cls });
    const contentEl = messageEl.createDiv({ cls: "vault-chat-agent-message-content" });
    const copyButton = messageEl.createEl("button", {
      cls: "vault-chat-agent-message-copy",
      attr: { "aria-label": "Copy message text" },
    });
    setIcon(copyButton, "copy");
    copyButton.onclick = () => {
      void navigator.clipboard.writeText(formatMessageForCopy(message)).then(
        () => new Notice("Copied message.", 2000),
        (error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          new Notice(errorMessage, 5000);
        },
      );
    };

    if (message.reasoningContent && message.role === "assistant" && !message.error) {
      const reasoningEl = contentEl.createEl("details", { cls: "vault-chat-agent-message-reasoning" });
      reasoningEl.open = !this.getCollapseThinkingByDefault();
      reasoningEl.createEl("summary", { text: "Thinking" });
      reasoningEl.createDiv({ cls: "vault-chat-agent-message-reasoning-content", text: message.reasoningContent });
    }

    if (message.role === "assistant" && !message.error && message.streaming) {
      if (message.content) {
        contentEl.createDiv({ cls: "vault-chat-agent-message-answer-stream", text: message.content });
      }
    } else if (message.role === "assistant" && !message.error) {
      if (message.content) {
        await MarkdownRenderer.render(this.app, message.content, contentEl, "", this);
      }
    } else {
      contentEl.setText(message.content);
    }
  }

  private renderSources(): void {
    const body = this.renderPanel("sources", `Sources (${this.lastSources.length})`);
    if (!body) {
      return;
    }

    for (const result of this.lastSources) {
      const sourceEl = body.createDiv({ cls: "vault-chat-agent-source" });
      const title = sourceEl.createEl("button", { cls: "vault-chat-agent-source-title", text: result.chunk.filePath });
      title.onclick = () => {
        void this.app.workspace.openLinkText(result.chunk.filePath, "", false);
      };
      sourceEl.createDiv({ cls: "vault-chat-agent-source-score", text: `Score ${result.score.toFixed(3)}` });
      sourceEl.createDiv({
        cls: "vault-chat-agent-source-snippet",
        text: result.chunk.content.slice(0, 280),
      });
    }
  }

  private renderPendingEdits(): void {
    const body = this.renderPanel("edits", `Pending edits (${this.pendingEdits.length})`);
    if (!body) {
      return;
    }

    const batchActions = body.createDiv({ cls: "vault-chat-agent-panel-actions" });
    const applyAllButton = batchActions.createEl("button", { cls: "mod-cta", text: "Apply all" });
    const rejectAllButton = batchActions.createEl("button", { text: "Reject all" });
    applyAllButton.disabled = this.isSending;
    applyAllButton.onclick = () => {
      void this.applyAllPendingEdits();
    };
    rejectAllButton.onclick = () => {
      this.pendingEdits = [];
      this.render();
    };

    for (const edit of this.pendingEdits) {
      const editEl = body.createDiv({ cls: "vault-chat-agent-edit" });
      const header = editEl.createDiv({ cls: "vault-chat-agent-edit-header" });
      header.createDiv({ cls: "vault-chat-agent-edit-title", text: edit.path });
      header.createDiv({ cls: "vault-chat-agent-edit-summary", text: `${editKindLabel(edit)}: ${edit.summary}` });

      const diffEl = editEl.createDiv({ cls: "vault-chat-agent-diff" });
      const diff = buildEditDiff(edit);
      for (const line of diff.slice(0, 240)) {
        diffEl.createDiv({
          cls: `vault-chat-agent-diff-line vault-chat-agent-diff-${line.type}`,
          text: `${line.prefix} ${line.text}`,
        });
      }

      if (diff.length > 240) {
        diffEl.createDiv({ cls: "vault-chat-agent-diff-line", text: `[${diff.length - 240} more diff lines hidden]` });
      }

      const actions = editEl.createDiv({ cls: "vault-chat-agent-edit-actions" });
      const openButton = actions.createEl("button", { text: "Open" });
      const applyButton = actions.createEl("button", { cls: "mod-cta", text: "Apply" });
      const rejectButton = actions.createEl("button", { text: "Reject" });
      applyButton.disabled = this.isSending;

      openButton.onclick = () => {
        void this.app.workspace.openLinkText(edit.path, "", false);
      };
      applyButton.onclick = () => {
        void this.applyPendingEdit(edit);
      };
      rejectButton.onclick = () => {
        this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
        this.render();
      };
    }
  }

  private renderWorkingSet(): void {
    const body = this.renderPanel("workingSet", `Working set (${this.workingSet.length})`);
    if (!body) {
      return;
    }

    for (const item of this.workingSet.slice(0, 80)) {
      const itemEl = body.createDiv({ cls: "vault-chat-agent-working-set-item" });
      itemEl.createSpan({ cls: `vault-chat-agent-working-set-role vault-chat-agent-working-set-${item.role}`, text: item.role });
      itemEl.createSpan({ cls: "vault-chat-agent-working-set-path", text: item.path });
      itemEl.createSpan({ cls: "vault-chat-agent-working-set-detail", text: item.detail });
    }

    if (this.workingSet.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.workingSet.length - 80} more items hidden.` });
    }
  }

  private renderPanel(panelId: PanelId, title: string): HTMLElement | null {
    const panelEl = this.containerEl.createDiv({ cls: "vault-chat-agent-panel" });
    const header = panelEl.createEl("button", {
      cls: "vault-chat-agent-panel-header",
      attr: { "aria-expanded": String(this.expandedPanels[panelId]) },
    });
    setIcon(header, this.expandedPanels[panelId] ? "chevron-down" : "chevron-right");
    header.createSpan({ text: title });
    header.onclick = () => {
      this.expandedPanels[panelId] = !this.expandedPanels[panelId];
      this.render();
    };

    if (!this.expandedPanels[panelId]) {
      return null;
    }

    return panelEl.createDiv({ cls: `vault-chat-agent-panel-body vault-chat-agent-panel-${panelId}` });
  }

  private renderDebugLog(): void {
    const body = this.renderPanel("debug", `Debug log (${this.debugLogs.length})`);
    if (!body) {
      return;
    }

    const actions = body.createDiv({ cls: "vault-chat-agent-panel-actions" });
    const copyButton = actions.createEl("button", { text: "Copy JSON" });
    const exportButton = actions.createEl("button", { cls: "mod-cta", text: "Export JSON" });
    const copyTextButton = actions.createEl("button", { text: "Copy text" });
    const exportTextButton = actions.createEl("button", { cls: "mod-cta", text: "Export text" });
    copyButton.disabled = this.debugLogs.length === 0 && this.messages.length === 0;
    exportButton.disabled = copyButton.disabled;
    copyTextButton.disabled = copyButton.disabled;
    exportTextButton.disabled = copyButton.disabled;

    copyButton.onclick = () => {
      void this.copyDebugData().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    };
    exportButton.onclick = () => {
      void this.exportDebugData().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    };
    copyTextButton.onclick = () => {
      void this.copyDebugTextLog().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    };
    exportTextButton.onclick = () => {
      void this.exportDebugTextLog().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
      });
    };

    body.createDiv({
      cls: "setting-item-description",
      text: "Debug export can include prompts, note excerpts, tool results, and model responses.",
    });

    for (const entry of this.debugLogs.slice(-80)) {
      const entryEl = body.createDiv({ cls: "vault-chat-agent-debug-entry" });
      const header = entryEl.createDiv({ cls: "vault-chat-agent-debug-entry-header" });
      header.createSpan({ cls: `vault-chat-agent-debug-type vault-chat-agent-debug-${entry.type}`, text: entry.type });
      header.createSpan({ cls: "vault-chat-agent-debug-time", text: formatDebugTime(entry.timestamp) });
      entryEl.createDiv({ cls: "vault-chat-agent-debug-summary", text: entry.summary });
    }

    if (this.debugLogs.length > 80) {
      body.createDiv({ cls: "setting-item-description", text: `${this.debugLogs.length - 80} older debug events hidden.` });
    }
  }

  private renderInput(): void {
    const mentionsEl = this.containerEl.createDiv({ cls: "vault-chat-agent-mentions" });
    this.renderDraftMentions(mentionsEl);
    const commandSuggestionsEl = this.containerEl.createDiv({ cls: "vault-chat-agent-command-suggestions" });
    const suggestionsEl = this.containerEl.createDiv({ cls: "vault-chat-agent-mention-suggestions" });

    const inputRow = this.containerEl.createDiv({ cls: "vault-chat-agent-input-row" });
    const textarea = inputRow.createEl("textarea", {
      cls: "vault-chat-agent-input",
      attr: {
        placeholder: this.intent === "edit" && this.runMode === "plan" ? "Ask for a plan..." : this.intent === "edit" ? "Ask for reviewed changes..." : "Ask about your vault...",
      },
    });
    textarea.value = this.draftText;
    const sendButton = inputRow.createEl("button", { cls: "mod-cta", attr: { "aria-label": "Send" } });
    setIcon(sendButton, "send");
    sendButton.disabled = this.isSending;
    const stopButton = inputRow.createEl("button", { attr: { "aria-label": "Stop" } });
    setIcon(stopButton, "square");
    stopButton.disabled = !this.isSending;
    if (this.pendingEdits.length > 0) {
      const applyPermissionLabel = inputRow.createEl("label", { cls: "vault-chat-agent-apply-permission" });
      const applyPermissionInput = applyPermissionLabel.createEl("input", { type: "checkbox" });
      applyPermissionInput.checked = this.allowApplyToolsForNextMessage;
      applyPermissionInput.disabled = this.isSending;
      applyPermissionLabel.createSpan({ text: "Allow apply" });
      applyPermissionInput.onchange = () => {
        this.allowApplyToolsForNextMessage = applyPermissionInput.checked;
      };
    }

    const send = () => {
      const value = textarea.value.trim();
      if (!value) {
        return;
      }
      if (this.isSending) {
        if (value.toLocaleLowerCase() === "/stop") {
          this.executeSlashCommand("/stop", "");
        }
        return;
      }
      if (this.handleSlashCommandInput(value)) {
        return;
      }
      this.draftText = "";
      void this.sendMessage(value);
    };

    sendButton.onclick = send;
    stopButton.onclick = () => {
      this.abortController?.abort();
    };
    textarea.onkeydown = (event) => {
      if (this.commandSuggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.selectedCommandIndex = (this.selectedCommandIndex + 1) % this.commandSuggestions.length;
          this.renderCommandSuggestions(commandSuggestionsEl, textarea, mentionsEl, suggestionsEl);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          this.selectedCommandIndex = (this.selectedCommandIndex - 1 + this.commandSuggestions.length) % this.commandSuggestions.length;
          this.renderCommandSuggestions(commandSuggestionsEl, textarea, mentionsEl, suggestionsEl);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const selected = this.commandSuggestions[this.selectedCommandIndex];
          if (selected && !selected.acceptsPrompt && getSlashCommandTrigger(textarea.value, textarea.selectionStart)?.query === selected.name.slice(1)) {
            this.executeSlashCommand(selected.name, "");
            return;
          }
          if (selected) {
            this.insertSlashCommand(textarea, selected);
            this.updateInputState(textarea, mentionsEl, suggestionsEl, commandSuggestionsEl);
          }
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          this.insertSlashCommand(textarea, this.commandSuggestions[this.selectedCommandIndex]);
          this.updateInputState(textarea, mentionsEl, suggestionsEl, commandSuggestionsEl);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.commandSuggestions = [];
          this.renderCommandSuggestions(commandSuggestionsEl, textarea, mentionsEl, suggestionsEl);
          return;
        }
      }
      if (this.mentionSuggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.selectedMentionIndex = (this.selectedMentionIndex + 1) % this.mentionSuggestions.length;
          this.renderMentionSuggestions(suggestionsEl, textarea, mentionsEl);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          this.selectedMentionIndex = (this.selectedMentionIndex - 1 + this.mentionSuggestions.length) % this.mentionSuggestions.length;
          this.renderMentionSuggestions(suggestionsEl, textarea, mentionsEl);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          this.insertMentionSuggestion(textarea, this.mentionSuggestions[this.selectedMentionIndex]);
          this.updateInputState(textarea, mentionsEl, suggestionsEl, commandSuggestionsEl);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.mentionSuggestions = [];
          this.renderMentionSuggestions(suggestionsEl, textarea, mentionsEl, commandSuggestionsEl);
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    };
    textarea.oninput = () => {
      this.updateInputState(textarea, mentionsEl, suggestionsEl, commandSuggestionsEl);
    };
    textarea.onblur = () => {
      window.setTimeout(() => {
        this.mentionSuggestions = [];
        this.commandSuggestions = [];
        this.renderMentionSuggestions(suggestionsEl, textarea, mentionsEl);
        this.renderCommandSuggestions(commandSuggestionsEl, textarea, mentionsEl, suggestionsEl);
      }, 120);
    };
  }

  private renderDraftMentions(parent: HTMLElement): void {
    parent.empty();
    if (this.draftMentions.length === 0) {
      return;
    }

    parent.createSpan({ cls: "vault-chat-agent-mentions-label", text: "Context" });
    for (const mention of this.draftMentions) {
      parent.createSpan({ cls: `vault-chat-agent-mention vault-chat-agent-mention-${mention.kind}`, text: formatMention(mention) });
    }
  }

  private updateInputState(textarea: HTMLTextAreaElement, mentionsEl: HTMLElement, suggestionsEl: HTMLElement, commandSuggestionsEl: HTMLElement): void {
    this.draftText = textarea.value;
    this.draftMentions = parseMentions(textarea.value, (path) => this.resolveMentionPath(path));
    this.renderDraftMentions(mentionsEl);
    this.commandSuggestions = this.getSlashCommandSuggestions(textarea);
    if (this.commandSuggestions.length > 0) {
      this.mentionSuggestions = [];
    } else {
      this.mentionSuggestions = this.getMentionSuggestions(textarea);
    }
    if (this.selectedMentionIndex >= this.mentionSuggestions.length) {
      this.selectedMentionIndex = 0;
    }
    if (this.selectedCommandIndex >= this.commandSuggestions.length) {
      this.selectedCommandIndex = 0;
    }
    this.renderCommandSuggestions(commandSuggestionsEl, textarea, mentionsEl, suggestionsEl);
    this.renderMentionSuggestions(suggestionsEl, textarea, mentionsEl, commandSuggestionsEl);
  }

  private getMentionSuggestions(textarea: HTMLTextAreaElement): MentionSuggestion[] {
    const trigger = getMentionTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) {
      return [];
    }

    const query = trigger.query.toLocaleLowerCase();
    return buildMentionSuggestions(this.app)
      .filter((suggestion) => !query || suggestion.searchText.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }

  private renderMentionSuggestions(parent: HTMLElement, textarea: HTMLTextAreaElement, mentionsEl?: HTMLElement, commandSuggestionsEl?: HTMLElement): void {
    parent.empty();
    if (this.mentionSuggestions.length === 0) {
      return;
    }

    const query = getMentionTrigger(textarea.value, textarea.selectionStart)?.query ?? "";
    this.mentionSuggestions.forEach((suggestion, index) => {
      const button = parent.createEl("button", {
        cls: index === this.selectedMentionIndex ? "vault-chat-agent-mention-suggestion is-selected" : "vault-chat-agent-mention-suggestion",
      });
      renderHighlightedSuggestionText(button.createSpan({ cls: "vault-chat-agent-mention-suggestion-label" }), suggestion.label, query);
      renderHighlightedSuggestionText(button.createSpan({ cls: "vault-chat-agent-mention-suggestion-detail" }), suggestion.detail, query);
      button.onmousedown = (event) => {
        event.preventDefault();
        this.insertMentionSuggestion(textarea, suggestion);
        if (commandSuggestionsEl) {
          this.updateInputState(textarea, mentionsEl ?? parent, parent, commandSuggestionsEl);
        } else {
          this.draftMentions = parseMentions(textarea.value, (path) => this.resolveMentionPath(path));
          this.renderDraftMentions(mentionsEl ?? parent);
          this.mentionSuggestions = this.getMentionSuggestions(textarea);
          this.renderMentionSuggestions(parent, textarea, mentionsEl);
        }
      };
    });
  }

  private insertMentionSuggestion(textarea: HTMLTextAreaElement, suggestion: MentionSuggestion): void {
    const trigger = getMentionTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) {
      return;
    }

    const before = textarea.value.slice(0, trigger.from);
    const after = textarea.value.slice(trigger.to);
    const needsSpace = after.length === 0 || /^\s/.test(after) ? "" : " ";
    const inserted = `${suggestion.insertText}${needsSpace}`;
    textarea.value = `${before}${inserted}${after}`;
    this.draftText = textarea.value;
    const cursor = before.length + inserted.length;
    textarea.setSelectionRange(cursor, cursor);
    textarea.focus();
  }

  private getSlashCommandSuggestions(textarea: HTMLTextAreaElement): SlashCommand[] {
    const trigger = getSlashCommandTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) {
      return [];
    }

    const query = trigger.query.toLocaleLowerCase();
    return buildSlashCommands(this.isSending)
      .filter((command) => !query || command.searchText.includes(query))
      .slice(0, 8);
  }

  private renderCommandSuggestions(parent: HTMLElement, textarea: HTMLTextAreaElement, mentionsEl: HTMLElement, suggestionsEl: HTMLElement): void {
    parent.empty();
    if (this.commandSuggestions.length === 0) {
      return;
    }

    this.commandSuggestions.forEach((command, index) => {
      const button = parent.createEl("button", {
        cls: index === this.selectedCommandIndex ? "vault-chat-agent-command-suggestion is-selected" : "vault-chat-agent-command-suggestion",
      });
      button.createSpan({ cls: "vault-chat-agent-command-suggestion-name", text: command.name });
      button.createSpan({ cls: "vault-chat-agent-command-suggestion-detail", text: command.detail });
      button.onmousedown = (event) => {
        event.preventDefault();
        if (!command.acceptsPrompt && getSlashCommandTrigger(textarea.value, textarea.selectionStart)?.query === command.name.slice(1)) {
          this.executeSlashCommand(command.name, "");
          return;
        }
        this.insertSlashCommand(textarea, command);
        this.updateInputState(textarea, mentionsEl, suggestionsEl, parent);
      };
    });
  }

  private insertSlashCommand(textarea: HTMLTextAreaElement, command: SlashCommand): void {
    const trigger = getSlashCommandTrigger(textarea.value, textarea.selectionStart);
    if (!trigger) {
      return;
    }

    const before = textarea.value.slice(0, trigger.from);
    const after = textarea.value.slice(trigger.to).replace(/^\s*/, "");
    const inserted = `${command.name} `;
    textarea.value = `${before}${inserted}${after}`;
    this.draftText = textarea.value;
    const cursor = before.length + inserted.length;
    textarea.setSelectionRange(cursor, cursor);
    textarea.focus();
  }

  mentionPath(path: string): void {
    const mention = `@[[${path.replace(/\.md$/i, "")}]]`;
    const separator = this.draftText.trim() ? " " : "";
    this.draftText = `${this.draftText.trimEnd()}${separator}${mention} `;
    this.draftMentions = parseMentions(this.draftText, (rawPath) => this.resolveMentionPath(rawPath));
    this.render();
  }

  private handleSlashCommandInput(value: string): boolean {
    const match = value.match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) {
      return false;
    }

    const commandName = `/${match[1].toLocaleLowerCase()}`;
    const prompt = match[2]?.trim() ?? "";
    return this.executeSlashCommand(commandName, prompt);
  }

  private executeSlashCommand(commandName: string, prompt: string): boolean {
    switch (commandName) {
      case "/ask":
        this.intent = "ask";
        this.runMode = "direct";
        break;
      case "/edit":
        this.intent = "edit";
        this.runMode = "direct";
        break;
      case "/plan":
        this.intent = "edit";
        this.runMode = "plan";
        break;
      case "/direct":
        this.runMode = "direct";
        break;
      case "/vault":
        this.searchScopeMode = "vault";
        break;
      case "/note":
        this.searchScopeMode = "current-note";
        break;
      case "/folder":
        this.searchScopeMode = "current-folder";
        break;
      case "/clear":
        this.messages = [];
        this.lastSources = [];
        this.pendingEdits = [];
        this.draftMentions = [];
        this.mentionSuggestions = [];
        this.commandSuggestions = [];
        this.workingSet = [];
        this.debugLogs = [];
        this.render();
        return true;
      case "/stop":
        this.abortController?.abort();
        this.render();
        return true;
      default:
        return false;
    }

    if (prompt) {
      void this.sendMessage(prompt);
      return true;
    }

    this.render();
    return true;
  }

  private async sendMessage(content: string): Promise<void> {
    const history = this.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const mentions = parseMentions(content, (path) => this.resolveMentionPath(path));
    const agentContent = addMentionInstructions(content, mentions);
    this.messages.push({ role: "user", content });
    this.isSending = true;
    this.abortController = new AbortController();
    const allowApplyTools = this.allowApplyToolsForNextMessage;
    this.allowApplyToolsForNextMessage = false;
    let streamingMessage: ChatMessage | null = null;
    const ensureStreamingMessage = (): ChatMessage => {
      if (!streamingMessage) {
        streamingMessage = { role: "assistant", content: "", streaming: true };
        this.messages.push(streamingMessage);
      }
      return streamingMessage;
    };
    const removeStreamingMessage = (): void => {
      if (!streamingMessage) {
        return;
      }
      this.messages = this.messages.filter((message) => message !== streamingMessage);
      streamingMessage = null;
      this.scheduleStreamingRender();
    };
    this.render();

    try {
      this.statusText = this.intent === "edit" && this.runMode === "plan" ? "Planning reviewed changes..." : this.intent === "edit" ? "Preparing reviewed changes..." : "Inspecting the vault...";
      this.render();
      await this.remoteMcpManager.refreshEnabledServers();
      const mcpErrors = this.remoteMcpManager.getErrors();
      if (mcpErrors.length > 0) {
        new Notice(`Vault Chat Agent: MCP connection failed. ${mcpErrors[0]}`, 7000);
      }
      const searchScope = this.createSearchScope();
      const result = await this.aiChatClient.completeWithAgent(
        agentContent,
        history,
        this.createMcpServer(),
        this.intent,
        (entry) => {
          this.debugLogs.push(entry);
          if (this.expandedPanels.debug) {
            this.render();
          }
        },
        {
          intent: this.intent,
          runMode: this.runMode,
          searchScope,
          pendingEdits: this.pendingEdits.map(summarizePendingEdit),
          allowedCapabilities: [
            "read",
            ...(this.intent === "edit" && this.runMode !== "plan" ? (["propose_edit"] as const) : []),
            ...(allowApplyTools ? (["apply_edit"] as const) : []),
          ],
          externalToolNames: this.remoteMcpManager.getToolNames(),
        },
        this.abortController.signal,
        {
          onContentDelta: (delta) => {
            this.statusText = "Writing...";
            ensureStreamingMessage().content += delta;
            this.scheduleStreamingRender();
          },
          onReasoningDelta: (delta) => {
            const message = ensureStreamingMessage();
            message.reasoningContent = `${message.reasoningContent ?? ""}${delta}`;
            this.statusText = "Thinking...";
            this.scheduleStreamingRender();
          },
          onContentReset: removeStreamingMessage,
        },
      );
      this.lastSources = result.sources;
      this.pendingEdits = this.pendingEdits.concat(result.pendingEdits);
      this.workingSet = mergeWorkingSet(
        this.workingSet,
        result.workingSet,
        result.pendingEdits.map((edit) => ({ path: edit.path, role: "edited", detail: edit.summary })),
      );
      if (streamingMessage !== null) {
        const message = streamingMessage as ChatMessage;
        message.content = result.answer;
        message.streaming = false;
      } else {
        this.messages.push({ role: "assistant", content: result.answer });
      }
    } catch (error) {
      if (isAbortError(error)) {
        removeStreamingMessage();
        this.messages.push({ role: "assistant", content: "Stopped." });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 6000);
      this.messages.push({ role: "assistant", content: message, error: true });
    } finally {
      this.isSending = false;
      this.abortController = null;
      this.statusText = "";
      if (this.streamingRenderTimer !== null) {
        window.clearTimeout(this.streamingRenderTimer);
        this.streamingRenderTimer = null;
      }
      this.render();
    }
  }

  private scheduleStreamingRender(): void {
    if (this.streamingRenderTimer !== null) {
      return;
    }
    this.streamingRenderTimer = window.setTimeout(() => {
      this.streamingRenderTimer = null;
      this.render();
    }, 80);
  }

  private createMcpServer(): ObsidianMcpServer {
    return new ObsidianMcpServer(
      this.agentTools,
      (id) => this.applyPendingEditTool(id),
      () => this.applyAllPendingEditsTool(),
      this.remoteMcpManager,
    );
  }

  private createSearchScope(): ChatSearchScope {
    if (this.searchScopeMode === "vault") {
      return { mode: "vault" };
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Vault Chat Agent: no active note for selected scope; using whole vault.", 4000);
      return { mode: "vault" };
    }

    if (this.searchScopeMode === "current-note") {
      return { mode: "current-note", path: file.path };
    }

    const folderPath = file.parent?.path ?? "";
    return folderPath ? { mode: "current-folder", path: folderPath } : { mode: "vault" };
  }

  private resolveMentionPath(rawPath: string): { kind: "note" | "folder"; path: string } | null {
    const cleaned = rawPath.trim().replace(/^\/+/, "");
    if (!cleaned) {
      return null;
    }

    const direct = this.app.vault.getAbstractFileByPath(cleaned);
    if (direct instanceof TFile) {
      return { kind: "note", path: direct.path };
    }
    if (direct instanceof TFolder) {
      return { kind: "folder", path: direct.path };
    }

    const markdownPath = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
    const markdownFile = this.app.vault.getAbstractFileByPath(markdownPath);
    if (markdownFile instanceof TFile) {
      return { kind: "note", path: markdownFile.path };
    }

    const normalizedFolder = cleaned.replace(/\/$/, "");
    const folder = this.app.vault.getAbstractFileByPath(normalizedFolder);
    if (folder instanceof TFolder) {
      return { kind: "folder", path: folder.path };
    }

    return cleaned.endsWith("/") ? { kind: "folder", path: normalizedFolder } : { kind: "note", path: markdownPath };
  }

  private async applyPendingEditTool(id: string): Promise<AgentToolExecution> {
    const edit = this.pendingEdits.find((pending) => pending.id === id);
    if (!edit) {
      return { content: `Pending edit not found: ${id || "(missing id)"}.` };
    }

    await this.agentTools.applyEdit(edit);
    this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
    this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
    return {
      content: `Applied pending edit ${edit.id} to ${edit.path}.`,
      workingSetItems: [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }],
    };
  }

  private async applyAllPendingEditsTool(): Promise<AgentToolExecution> {
    if (this.pendingEdits.length === 0) {
      return { content: "There are no pending edits to apply." };
    }

    const edits = [...this.pendingEdits];
    const appliedPaths: string[] = [];
    for (const edit of edits) {
      await this.agentTools.applyEdit(edit);
      this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
      this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      appliedPaths.push(edit.path);
    }

    return {
      content: `Applied ${appliedPaths.length} pending edits:\n${appliedPaths.map((path) => `- ${path}`).join("\n")}`,
      workingSetItems: appliedPaths.map((path) => ({ path, role: "edited", detail: "Applied pending edit" })),
    };
  }

  private async applyPendingEdit(edit: PendingEdit): Promise<void> {
    try {
      await this.agentTools.applyEdit(edit);
      this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
      this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      new Notice(`${edit.kind === "create" ? "Created note" : "Applied edit"}: ${edit.path}`, 3000);
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 6000);
    }
  }

  private async applyAllPendingEdits(): Promise<void> {
    const edits = [...this.pendingEdits];
    for (const edit of edits) {
      try {
        await this.agentTools.applyEdit(edit);
        this.pendingEdits = this.pendingEdits.filter((pending) => pending.id !== edit.id);
        this.workingSet = mergeWorkingSet(this.workingSet, [{ path: edit.path, role: "edited", detail: `Applied: ${edit.summary}` }]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(message, 6000);
        this.render();
        return;
      }
    }

    new Notice(`Applied ${edits.length} edits.`, 3000);
    this.render();
  }

  private async copyDebugData(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(this.buildDebugExport(), null, 2));
    new Notice("Copied debug JSON.", 3000);
  }

  private async copyDebugTextLog(): Promise<void> {
    await navigator.clipboard.writeText(this.buildDebugTextLog());
    new Notice("Copied debug text log.", 3000);
  }

  private async exportDebugData(): Promise<void> {
    const folderPath = "Vault Chat Agent Debug";
    await this.ensureFolder(folderPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${folderPath}/chat-debug-${timestamp}.json`;
    await this.app.vault.create(path, JSON.stringify(this.buildDebugExport(), null, 2));
    new Notice(`Exported debug data: ${path}`, 5000);
  }

  private async exportDebugTextLog(): Promise<void> {
    const folderPath = "Vault Chat Agent Debug";
    await this.ensureFolder(folderPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${folderPath}/chat-log-${timestamp}.txt`;
    await this.app.vault.create(path, this.buildDebugTextLog());
    new Notice(`Exported debug text log: ${path}`, 5000);
  }

  private buildDebugExport(): Record<string, unknown> {
    return {
      exportedAt: new Date().toISOString(),
      intent: this.intent,
      runMode: this.runMode,
      isSending: this.isSending,
      messages: this.messages,
      pendingEdits: this.pendingEdits,
      sources: this.lastSources,
      workingSet: this.workingSet,
      debugLogs: this.debugLogs,
    };
  }

  private buildDebugTextLog(): string {
    const lines = [
      `[AI-Chat] Exported: ${new Date().toISOString()}`,
      `[AI-Chat] Intent: ${this.intent}; runMode: ${this.runMode}; isSending: ${this.isSending}`,
      "",
      "[AI-Chat] Messages",
      ...this.messages.flatMap((message, index) => [
        `[AI-Chat] Message ${index + 1} role=${message.role}${message.error ? " error=true" : ""}`,
        message.content,
        "",
      ]),
      "[AI-Chat] Working set",
      ...(this.workingSet.length ? this.workingSet.map((item) => `[AI-Chat] ${item.role} ${item.path} - ${item.detail}`) : ["[AI-Chat] none"]),
      "",
      "[AI-Chat] Sources",
      ...(this.lastSources.length ? this.lastSources.map((source) => `[AI-Chat] ${source.chunk.filePath} score=${source.score.toFixed(3)} snippet=${source.chunk.content.slice(0, 300).replace(/\s+/g, " ")}`) : ["[AI-Chat] none"]),
      "",
      "[AI-Chat] Pending edits",
      ...(this.pendingEdits.length ? this.pendingEdits.map((edit) => `[AI-Chat] ${edit.kind} ${edit.path} - ${edit.summary}`) : ["[AI-Chat] none"]),
      "",
      "[AI-Chat] Debug events",
      ...this.debugLogs.flatMap((entry, index) => formatDebugLogEntry(entry, index + 1)),
    ];
    return `${lines.join("\n").trim()}\n`;
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      return;
    }
    if (existing) {
      throw new Error(`Cannot create debug export folder because a file already exists at: ${path}`);
    }
    await this.app.vault.createFolder(path);
  }
}

function formatDebugTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString();
}

function formatDebugLogEntry(entry: DebugLogEntry, index: number): string[] {
  const prefix = debugPrefix(entry.type);
  const lines = [
    `${prefix} #${index} ${entry.timestamp} ${entry.type}: ${entry.summary}`,
  ];

  const summary = summarizeDebugData(entry.data);
  if (summary) {
    lines.push(`${prefix} ${summary}`);
  }
  return [...lines, ""];
}

function debugPrefix(type: DebugLogEntry["type"]): string {
  if (type === "model-request" || type === "model-response" || type === "model-error") {
    return "[Model]";
  }
  if (type === "tool-call" || type === "tool-result") {
    return "[Tool]";
  }
  return "[AI-Chat]";
}

function summarizeDebugData(data: unknown): string {
  if (!isPlainObject(data)) {
    return stringifyCompact(data, 1000);
  }
  const parts: string[] = [];
  for (const key of ["intent", "runMode", "step", "tool", "answer", "userMessage", "historyLength"]) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${stringifyCompact(value, 300)}`);
    }
  }
  if (isPlainObject(data.toolCall)) {
    const name = typeof data.toolCall.name === "string" ? data.toolCall.name : "";
    const argumentsJson = typeof data.toolCall.argumentsJson === "string" ? data.toolCall.argumentsJson : "";
    parts.push(`toolCall=${name}${argumentsJson ? ` args=${argumentsJson}` : ""}`);
  }
  if (isPlainObject(data.args)) {
    parts.push(`args=${stringifyCompact(data.args, 800)}`);
  }
  if (isPlainObject(data.result)) {
    const content = typeof data.result.content === "string" ? data.result.content : stringifyCompact(data.result, 1200);
    parts.push(`result=${content.replace(/\s+/g, " ").slice(0, 1200)}`);
  }
  if (parts.length > 0) {
    return parts.join("; ");
  }
  return stringifyCompact(data, 1200);
}

function stringifyCompact(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ");
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isChatSearchScopeMode(value: string): value is ChatSearchScopeMode {
  return value === "vault" || value === "current-note" || value === "current-folder";
}

function buildMentionSuggestions(app: App): MentionSuggestion[] {
  const currentFile = app.workspace.getActiveFile();
  const current: MentionSuggestion[] = [
    {
      kind: "current",
      label: "@current",
      detail: currentFile?.path ?? "Active note",
      insertText: "@current",
      searchText: `current ${currentFile?.path ?? ""}`,
    },
  ];

  const files = app.vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      kind: "note" as const,
      label: file.basename,
      detail: file.path,
      insertText: `@[[${file.path.replace(/\.md$/i, "")}]]`,
      searchText: `${file.basename} ${file.path}`,
    }));

  const folders = app.vault
    .getAllLoadedFiles()
    .filter((file): file is TFolder => file instanceof TFolder && file.path.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => ({
      kind: "folder" as const,
      label: folder.name || folder.path,
      detail: folder.path,
      insertText: `@${folder.path}/`,
      searchText: `${folder.name} ${folder.path}`,
    }));

  return [...current, ...files, ...folders];
}

function renderHighlightedSuggestionText(parent: HTMLElement, text: string, query: string): void {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    parent.setText(text);
    return;
  }

  const normalizedText = text.toLocaleLowerCase();
  let cursor = 0;
  let matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    parent.setText(text);
    return;
  }

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parent.appendText(text.slice(cursor, matchIndex));
    }
    parent.createSpan({
      cls: "vault-chat-agent-mention-suggestion-highlight",
      text: text.slice(matchIndex, matchIndex + normalizedQuery.length),
    });
    cursor = matchIndex + normalizedQuery.length;
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
  }

  if (cursor < text.length) {
    parent.appendText(text.slice(cursor));
  }
}

function getSlashCommandTrigger(value: string, cursor: number): { from: number; to: number; query: string } | null {
  const beforeCursor = value.slice(0, cursor);
  const afterCursor = value.slice(cursor);
  if (!beforeCursor.startsWith("/") || beforeCursor.includes("\n") || /\s/.test(beforeCursor)) {
    return null;
  }
  if (afterCursor.length > 0 && !/^\s/.test(afterCursor)) {
    return null;
  }

  return {
    from: 0,
    to: cursor,
    query: beforeCursor.slice(1),
  };
}

function buildSlashCommands(isSending: boolean): SlashCommand[] {
  return [
    {
      name: "/ask",
      detail: "Ask mode. Add text after it to send.",
      acceptsPrompt: true,
      searchText: "ask question read inspect",
    },
    {
      name: "/edit",
      detail: "Edit mode. Add text after it to request changes.",
      acceptsPrompt: true,
      searchText: "edit change patch propose",
    },
    {
      name: "/plan",
      detail: "Plan edit changes before preparing patches.",
      acceptsPrompt: true,
      searchText: "plan think review",
    },
    {
      name: "/direct",
      detail: "Turn off plan mode.",
      acceptsPrompt: false,
      searchText: "direct no plan",
    },
    {
      name: "/vault",
      detail: "Search the whole vault.",
      acceptsPrompt: true,
      searchText: "vault all workspace",
    },
    {
      name: "/note",
      detail: "Search only the active note.",
      acceptsPrompt: true,
      searchText: "note current active file",
    },
    {
      name: "/folder",
      detail: "Search the active note folder.",
      acceptsPrompt: true,
      searchText: "folder directory current",
    },
    {
      name: "/clear",
      detail: "Clear chat state.",
      acceptsPrompt: false,
      searchText: "clear reset delete trash",
    },
    ...(isSending
      ? [
          {
            name: "/stop",
            detail: "Stop the current response.",
            acceptsPrompt: false,
            searchText: "stop abort cancel",
          },
        ]
      : []),
  ];
}

function mergeWorkingSet(existing: WorkingSetItem[], ...groups: WorkingSetItem[][]): WorkingSetItem[] {
  const merged = new Map(existing.map((item) => [`${item.path}:${item.role}`, item]));
  for (const item of groups.flat()) {
    const key = `${item.path}:${item.role}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    if (!current.detail.includes(item.detail)) {
      merged.set(key, { ...current, detail: `${current.detail}; ${item.detail}` });
    }
  }
  return Array.from(merged.values());
}

type DiffLine = { type: "same" | "add" | "remove"; prefix: string; text: string };

function buildEditDiff(edit: PendingEdit): DiffLine[] {
  if (edit.kind === "patch" && typeof edit.find === "string" && typeof edit.replace === "string") {
    return buildLineDiff(edit.find, edit.replace);
  }

  return buildLineDiff(edit.originalContent, edit.newContent);
}

function editKindLabel(edit: PendingEdit): string {
  if (edit.kind === "create") {
    return "New note";
  }
  return edit.kind === "patch" ? "Patch" : "Full edit";
}

function formatMessageForCopy(message: ChatMessage): string {
  if (!message.reasoningContent) {
    return message.content;
  }
  return message.content ? `${message.reasoningContent}\n\n${message.content}` : message.reasoningContent;
}

function buildLineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: "same", prefix: " ", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      diff.push({ type: "remove", prefix: "-", text: oldLines[i] });
      i += 1;
    } else {
      diff.push({ type: "add", prefix: "+", text: newLines[j] });
      j += 1;
    }
  }

  while (i < oldLines.length) {
    diff.push({ type: "remove", prefix: "-", text: oldLines[i] });
    i += 1;
  }

  while (j < newLines.length) {
    diff.push({ type: "add", prefix: "+", text: newLines[j] });
    j += 1;
  }

  return collapseUnchanged(diff);
}

function collapseUnchanged(diff: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let unchangedBuffer: DiffLine[] = [];

  const flush = () => {
    if (unchangedBuffer.length <= 8) {
      result.push(...unchangedBuffer);
    } else {
      result.push(...unchangedBuffer.slice(0, 3));
      result.push({ type: "same", prefix: " ", text: `[${unchangedBuffer.length - 6} unchanged lines]` });
      result.push(...unchangedBuffer.slice(-3));
    }
    unchangedBuffer = [];
  };

  for (const line of diff) {
    if (line.type === "same") {
      unchangedBuffer.push(line);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();

  return result;
}
