import { App, Notice, PluginSettingTab, Setting, SuggestModal } from "obsidian";
import { DEFAULT_SETTINGS, ExternalMcpServerSettings, SavedPrompt } from "../core/types";
import ObsidianAIAssistantPlugin from "../main";
import { detectProviderPreset, fetchProviderModels, PROVIDER_PRESETS, ProviderPreset } from "./providerSettings";

export class ObsidianAIAssistantSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianAIAssistantPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Chat Agent" });

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc("Sets a base URL and starter model for common OpenAI-compatible providers.")
      .addDropdown((dropdown) => {
        for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
          dropdown.addOption(key, preset.name);
        }
        dropdown.setValue(detectProviderPreset(this.plugin.settings.apiBaseUrl));
        dropdown.onChange(async (value) => {
          const preset = PROVIDER_PRESETS[value as ProviderPreset];
          if (!preset || value === "custom") {
            return;
          }
          this.plugin.settings.apiBaseUrl = preset.apiBaseUrl;
          this.plugin.settings.model = preset.model;
          await this.plugin.savePluginData();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in Obsidian plugin data on this device. Local providers can leave this empty.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any model accepted by your configured OpenAI-compatible provider.")
      .addText((text) => {
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.savePluginData();
        });
      })
      .addButton((button) =>
        button.setButtonText("Browse").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Loading...");
          try {
            const models = await fetchProviderModels(this.plugin.settings);
            if (models.length === 0) {
              new Notice("Vault Chat Agent: provider returned no models.", 4000);
              return;
            }
            new ModelPickerModal(this.app, models, async (model) => {
              this.plugin.settings.model = model;
              await this.plugin.savePluginData();
              this.display();
            }).open();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Vault Chat Agent: could not load models. ${message}`, 7000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Browse");
          }
        }),
      );

    new Setting(containerEl)
      .setName("Developer mode")
      .setDesc("Show advanced provider, indexing, MCP, and debug controls.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.developerMode).onChange(async (value) => {
          this.plugin.settings.developerMode = value;
          await this.plugin.savePluginData();
          this.plugin.refreshChatViews();
        }),
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI-compatible base URL. The plugin calls /v1/chat/completions.")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiBaseUrl).onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Approximate maximum characters per indexed chunk.")
      .addSlider((slider) =>
        slider
          .setLimits(300, 2400, 100)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.chunkSize)
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Overlap")
      .setDesc("Characters carried between neighboring chunks.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 500, 25)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.overlapSize)
          .onChange(async (value) => {
            this.plugin.settings.overlapSize = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Search results")
      .setDesc("Number of note chunks sent as context.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.topK)
          .onChange(async (value) => {
            this.plugin.settings.topK = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Default chat intent")
      .setDesc("Choose whether new chat panes start in read-only Ask or reviewed Edit.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask")
          .addOption("edit", "Edit")
          .setValue(this.plugin.settings.defaultIntent)
          .onChange(async (value) => {
            this.plugin.settings.defaultIntent = value === "edit" ? "edit" : "ask";
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Extra instructions added to every chat. Use this to set tone, assumptions, and explanation style.")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.addClass("vault-chat-agent-system-prompt-input");
        text
          .setPlaceholder(DEFAULT_SETTINGS.systemPrompt)
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Strip reasoning blocks")
      .setDesc("Remove <think>, <reasoning>, and <thought> blocks from assistant output.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.stripReasoningBlocks).onChange(async (value) => {
          this.plugin.settings.stripReasoningBlocks = value;
          await this.plugin.savePluginData();
        }),
      );

    new Setting(containerEl)
      .setName("Collapse streamed thinking")
      .setDesc("Start streamed thinking output collapsed in chat messages.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.collapseThinkingByDefault).onChange(async (value) => {
          this.plugin.settings.collapseThinkingByDefault = value;
          await this.plugin.savePluginData();
          this.plugin.refreshChatViews();
        }),
      );

    new Setting(containerEl)
      .setName("Realtime indexing")
      .setDesc("Update the local index when vault files change.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.realtimeIndexing).onChange(async (value) => {
          this.plugin.settings.realtimeIndexing = value;
          await this.plugin.savePluginData();
          this.plugin.configureRealtimeIndexer();
        }),
      );

    containerEl.createEl("h3", { text: "Media import" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Convert PDF, DOCX, CSV, and other documents to Markdown notes through MarkItDown.",
    });

    new Setting(containerEl)
      .setName("Import folder")
      .setDesc("Vault folder where converted Markdown files are saved.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.mediaImportFolder)
          .setValue(this.plugin.settings.mediaImportFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaImportFolder = value.trim() || DEFAULT_SETTINGS.mediaImportFolder;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("MarkItDown API URL")
      .setDesc("Base URL. The plugin calls /convert with multipart/form-data.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.markitdownApiBaseUrl)
          .setValue(this.plugin.settings.markitdownApiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.markitdownApiBaseUrl = value.trim() || DEFAULT_SETTINGS.markitdownApiBaseUrl;
            await this.plugin.savePluginData();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Testing...");
          try {
            await this.plugin.testMarkitdownConnection();
            new Notice("Vault Chat Agent: MarkItDown connection is healthy.", 3000);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Vault Chat Agent: MarkItDown check failed. ${message}`, 7000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Test");
          }
        }),
      );

    new Setting(containerEl)
      .setName("MarkItDown username")
      .setDesc("Optional Basic Auth username for the MarkItDown service.")
      .addText((text) =>
        text
          .setPlaceholder("Username")
          .setValue(this.plugin.settings.markitdownUsername)
          .onChange(async (value) => {
            this.plugin.settings.markitdownUsername = value.trim();
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("MarkItDown password")
      .setDesc("Optional Basic Auth password for the MarkItDown service.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Password")
          .setValue(this.plugin.settings.markitdownPassword)
          .onChange(async (value) => {
            this.plugin.settings.markitdownPassword = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Parallel imports")
      .setDesc("Maximum concurrent MarkItDown conversions.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 4, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.mediaImportConcurrency)
          .onChange(async (value) => {
            this.plugin.settings.mediaImportConcurrency = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Name conflicts")
      .setDesc("What to do when the target Markdown file already exists.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("rename", "Rename")
          .addOption("overwrite", "Overwrite")
          .addOption("skip", "Skip")
          .setValue(this.plugin.settings.mediaImportOverwriteMode)
          .onChange(async (value) => {
            this.plugin.settings.mediaImportOverwriteMode = value === "overwrite" || value === "skip" ? value : "rename";
            await this.plugin.savePluginData();
          }),
      );

    containerEl.createEl("h3", { text: "External MCP servers" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "External MCP servers exposed to the agent as read-only tools. Remote HTTPS Streamable HTTP endpoints are supported.",
    });

    new Setting(containerEl)
      .setName("Add Firecrawl MCP")
      .setDesc("Adds Firecrawl's hosted MCP endpoint. Enter the API key in a separate field after adding it.")
      .addButton((button) =>
        button
          .setButtonText("Add Firecrawl")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.externalMcpServers = [
              ...this.plugin.settings.externalMcpServers,
              createExternalMcpServer("firecrawl", "", "firecrawl"),
            ];
            await this.plugin.savePluginData();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Add custom MCP")
      .setDesc("Adds a blank remote MCP server entry.")
      .addButton((button) =>
        button.setButtonText("Add server").onClick(async () => {
          this.plugin.settings.externalMcpServers = [...this.plugin.settings.externalMcpServers, createExternalMcpServer("mcp-server", "https://example.com/mcp", "custom")];
          await this.plugin.savePluginData();
          this.display();
        }),
      );

    for (const server of this.plugin.settings.externalMcpServers) {
      const isFirecrawl = server.provider === "firecrawl";
      new Setting(containerEl)
        .setName(isFirecrawl ? "Firecrawl MCP" : "MCP server")
        .setDesc(server.id)
        .addToggle((toggle) =>
          toggle.setValue(server.enabled).onChange(async (value) => {
            server.enabled = value;
            await this.plugin.savePluginData();
            }),
        )
        .addText((text) => {
          text
            .setPlaceholder("Name")
            .setValue(server.name)
            .onChange(async (value) => {
              server.name = value.trim() || (isFirecrawl ? "firecrawl" : "mcp-server");
              await this.plugin.savePluginData();
            });
          if (isFirecrawl) {
            text.setDisabled(true);
          }
        })
        .addButton((button) =>
          button
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.externalMcpServers = this.plugin.settings.externalMcpServers.filter((item) => item.id !== server.id);
              await this.plugin.savePluginData();
              this.display();
            }),
        );

      if (isFirecrawl) {
        new Setting(containerEl)
          .setName("Firecrawl API key")
          .setDesc("Stored in Obsidian plugin data on this device. The hosted MCP URL is assembled automatically.")
          .addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("fc-...")
              .setValue(server.apiKey ?? "")
              .onChange(async (value) => {
                server.apiKey = value.trim();
                server.url = "";
                await this.plugin.savePluginData();
              });
          });
      } else {
        new Setting(containerEl)
          .setName("MCP URL")
          .setDesc("Remote HTTPS Streamable HTTP MCP endpoint.")
          .addText((text) =>
            text
              .setPlaceholder("https://...")
              .setValue(server.url)
              .onChange(async (value) => {
                server.url = value.trim();
                await this.plugin.savePluginData();
              }),
          );

        new Setting(containerEl)
          .setName("Headers")
          .setDesc("Optional request headers, one KEY=value pair per line.")
          .addTextArea((text) => {
            text.inputEl.rows = 3;
            text
              .setPlaceholder("Authorization=Bearer ...")
              .setValue(formatKeyValueLines(server.headers))
              .onChange(async (value) => {
                server.headers = parseKeyValueLines(value);
                await this.plugin.savePluginData();
              });
          });
      }
    }

    containerEl.createEl("h3", { text: "Saved prompts" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Reusable prompts for the Prompt: run saved prompt command. Edit prompts can propose reviewed patches; Ask prompts only answer in chat.",
    });

    new Setting(containerEl)
      .setName("Add saved prompt")
      .setDesc("Create a prompt that can be run from the command palette.")
      .addButton((button) =>
        button
          .setButtonText("Add prompt")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.savedPrompts = [
              ...this.plugin.settings.savedPrompts,
              createSavedPrompt(),
            ];
            await this.plugin.savePluginData();
            this.display();
          }),
      );

    for (const prompt of this.plugin.settings.savedPrompts) {
      new Setting(containerEl)
        .setName("Saved prompt")
        .setDesc(prompt.id)
        .addText((text) =>
          text
            .setPlaceholder("Prompt title")
            .setValue(prompt.title)
            .onChange(async (value) => {
              prompt.title = value;
              await this.plugin.savePluginData();
            }),
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption("ask", "Ask")
            .addOption("edit", "Edit")
            .setValue(prompt.intent)
            .onChange(async (value) => {
              prompt.intent = value === "edit" ? "edit" : "ask";
              await this.plugin.savePluginData();
            }),
        )
        .addButton((button) =>
          button
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.savedPrompts = this.plugin.settings.savedPrompts.filter((item) => item.id !== prompt.id);
              await this.plugin.savePluginData();
              this.display();
            }),
        );

      new Setting(containerEl)
        .setName("Prompt text")
        .setDesc("Instructions to run against the current selection or active note.")
        .addTextArea((text) => {
          text.inputEl.rows = 4;
          text.inputEl.addClass("vault-chat-agent-saved-prompt-input");
          text
            .setPlaceholder("Example: Rewrite this as concise meeting notes.")
            .setValue(prompt.prompt)
            .onChange(async (value) => {
              prompt.prompt = value;
              await this.plugin.savePluginData();
            });
        });
    }

    containerEl.createEl("h3", { text: "Index" });
    const coverage = this.plugin.getIndexCoverage();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: [
        `${coverage.totalFiles} files tracked.`,
        `${coverage.indexedFiles} indexed with text.`,
        `${coverage.metadataOnlyFiles} metadata-only.`,
        `${coverage.errorFiles} errors.`,
        `${coverage.chunkCount} chunks.`,
      ].join(" "),
    });

    new Setting(containerEl)
      .setName("Re-index vault")
      .setDesc("Rebuilds the local index from supported vault files.")
      .addButton((button) =>
        button
          .setButtonText("Re-index")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Indexing...");
            try {
              await this.plugin.indexVault();
            } finally {
              button.setDisabled(false);
              this.display();
            }
          }),
      );
  }
}

function createSavedPrompt(): SavedPrompt {
  return {
    id: `prompt:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    title: "New prompt",
    prompt: "",
    intent: "ask",
  };
}

function createExternalMcpServer(name: string, url: string, provider: ExternalMcpServerSettings["provider"]): ExternalMcpServerSettings {
  return {
    id: `${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    name,
    provider,
    transport: "http",
    url,
    enabled: true,
  };
}

function parseKeyValueLines(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    result[key] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

function formatKeyValueLines(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {})
    .map(([key, itemValue]) => `${key}=${itemValue}`)
    .join("\n");
}

class ModelPickerModal extends SuggestModal<string> {
  constructor(
    app: App,
    private readonly models: string[],
    private readonly onChoose: (model: string) => Promise<void>,
  ) {
    super(app);
    this.setPlaceholder("Search provider models...");
  }

  getSuggestions(query: string): string[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return this.models.slice(0, 100);
    }
    return this.models.filter((model) => model.toLocaleLowerCase().includes(normalized)).slice(0, 100);
  }

  renderSuggestion(model: string, el: HTMLElement): void {
    el.setText(model);
  }

  onChooseSuggestion(model: string): void {
    void this.onChoose(model);
  }
}
