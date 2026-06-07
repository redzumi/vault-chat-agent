import { App, Modal, Notice, setIcon } from "obsidian";
import { MediaImportItem, MediaImportStatus } from "../core/types";
import { MediaImportQueue } from "../services/mediaImportQueue";

export class MediaImportModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly queue: MediaImportQueue,
    private readonly mentionImportedFile: (path: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("vault-chat-agent-media-import-modal");
    this.contentEl.addClass("vault-chat-agent-media-import-view");
    this.unsubscribe = this.queue.subscribe(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const items = this.queue.getItems();

    const toolbar = this.contentEl.createDiv({ cls: "vault-chat-agent-media-import-toolbar" });
    toolbar.createDiv({ cls: "vault-chat-agent-media-import-title", text: "Media Import" });
    const actions = toolbar.createDiv({ cls: "vault-chat-agent-media-import-toolbar-actions" });

    const fileInput = actions.createEl("input", {
      attr: {
        type: "file",
        multiple: "true",
      },
    });
    fileInput.addClass("vault-chat-agent-hidden-file-input");
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = "";
      if (files.length === 0) {
        return;
      }
      this.queue.addFiles(files);
    };

    const selectButton = actions.createEl("button", {
      cls: "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Choose files to import" },
    });
    setIcon(selectButton, "folder-open");
    selectButton.onclick = () => fileInput.click();

    const clearButton = actions.createEl("button", {
      cls: "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Clear completed imports" },
    });
    setIcon(clearButton, "list-x");
    clearButton.disabled = !items.some((item) => item.status === "done" || item.status === "error" || item.status === "canceled");
    clearButton.onclick = () => this.queue.clearCompleted();

    this.contentEl.createDiv({
      cls: "vault-chat-agent-media-import-status",
      text: buildSummary(items),
    });

    const body = this.contentEl.createDiv({ cls: "vault-chat-agent-media-import-list" });
    if (items.length === 0) {
      body.createDiv({
        cls: "setting-item-description",
        text: "Choose PDF, DOCX, CSV, XLSX, HTML, image, audio, or text files to convert them to Markdown notes.",
      });
      return;
    }

    for (const item of items) {
      this.renderItem(body, item);
    }
  }

  private renderItem(parent: HTMLElement, item: MediaImportItem): void {
    const itemEl = parent.createDiv({ cls: `vault-chat-agent-media-import-item is-${item.status}` });
    const header = itemEl.createDiv({ cls: "vault-chat-agent-media-import-item-header" });
    const nameEl = header.createDiv({ cls: "vault-chat-agent-media-import-name", text: item.originalName });
    nameEl.title = item.originalName;
    header.createDiv({ cls: "vault-chat-agent-media-import-size", text: formatBytes(item.size) });

    const meta = itemEl.createDiv({ cls: "vault-chat-agent-media-import-meta" });
    const status = meta.createSpan({ cls: "vault-chat-agent-media-import-badge", text: statusLabel(item.status) });
    status.addClass(`is-${item.status}`);
    meta.createSpan({ cls: "vault-chat-agent-media-import-message", text: item.error ?? item.outputPath ?? item.message });
    if (item.warning && item.status !== "done") {
      itemEl.createDiv({ cls: "vault-chat-agent-media-import-warning", text: item.warning });
    }

    const progress = itemEl.createDiv({ cls: "vault-chat-agent-media-import-progress" });
    progress.createDiv({
      cls: "vault-chat-agent-media-import-progress-fill",
      attr: { style: `width: ${statusProgress(item.status)}%` },
    });

    const actions = itemEl.createDiv({ cls: "vault-chat-agent-media-import-actions" });
    if (item.outputPath) {
      const openButton = actions.createEl("button", { text: "Open" });
      openButton.onclick = () => {
        void this.app.workspace.openLinkText(item.outputPath ?? "", "", false);
      };
      const mentionButton = actions.createEl("button", {
        cls: "vault-chat-agent-toolbar-button",
        attr: { "aria-label": "Mention saved note in chat" },
      });
      setIcon(mentionButton, "at-sign");
      mentionButton.onclick = () => {
        if (!item.outputPath) {
          return;
        }
        this.mentionImportedFile(item.outputPath);
        this.close();
      };
    }
    if (item.status === "error") {
      const retryButton = actions.createEl("button", { text: "Retry" });
      retryButton.onclick = () => this.queue.retry(item.id);
    }
    if (item.status === "queued" || item.status === "uploading" || item.status === "converting") {
      const cancelButton = actions.createEl("button", {
        cls: "vault-chat-agent-toolbar-button",
        attr: { "aria-label": "Cancel import" },
      });
      setIcon(cancelButton, "ban");
      cancelButton.onclick = () => this.queue.cancel(item.id);
    }
    if (item.status === "done") {
      const copyButton = actions.createEl("button", {
        cls: "vault-chat-agent-toolbar-button",
        attr: { "aria-label": "Copy saved path" },
      });
      setIcon(copyButton, "copy");
      copyButton.onclick = () => {
        void navigator.clipboard.writeText(item.outputPath ?? "").then(
          () => new Notice("Vault Chat Agent: copied import path.", 2000),
          () => new Notice("Vault Chat Agent: could not copy import path.", 3000),
        );
      };
    }
    const removeButton = actions.createEl("button", {
      cls: "vault-chat-agent-toolbar-button",
      attr: { "aria-label": "Remove from import history" },
    });
    setIcon(removeButton, "x");
    removeButton.disabled = item.status === "uploading" || item.status === "converting" || item.status === "saving";
    removeButton.onclick = () => this.queue.remove(item.id);
  }
}

function buildSummary(items: MediaImportItem[]): string {
  if (items.length === 0) {
    return "No files queued.";
  }
  const done = items.filter((item) => item.status === "done").length;
  const errors = items.filter((item) => item.status === "error").length;
  const active = items.filter((item) => item.status === "uploading" || item.status === "converting" || item.status === "saving").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const canceled = items.filter((item) => item.status === "canceled").length;
  return `${items.length} files. ${done} done, ${active} active, ${queued} queued, ${errors} errors, ${canceled} canceled.`;
}

function statusLabel(status: MediaImportStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "converting":
      return "Converting";
    case "saving":
      return "Saving";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "canceled":
      return "Canceled";
  }
}

function statusProgress(status: MediaImportStatus): number {
  switch (status) {
    case "queued":
      return 8;
    case "uploading":
      return 32;
    case "converting":
      return 64;
    case "saving":
      return 86;
    case "done":
      return 100;
    case "error":
      return 100;
    case "canceled":
      return 100;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
