# Media Document Import

Working specification for importing media documents into Vault Chat Agent.

## Goal

Add a file import modal that opens from the chat toolbar. Users can choose one or more documents, send them to the MarkItDown API, receive Markdown, and save the result into a configured vault folder.

Primary scenario: users import PDF, DOCX, CSV, and other documents as `.md` notes so they become available for reading, search, and chat inside Obsidian.

## User Flow

1. The user clicks the media import button in the chat toolbar.
2. The user selects one or more files through the system file picker.
3. The plugin adds the files to the import queue.
4. The user sees the current status for each file.
5. The plugin sends each file to the MarkItDown API.
6. After the API responds, the plugin saves the Markdown into the folder configured in settings.
7. The output file keeps the original basename and uses the `.md` extension.
8. After saving, the file is indexed by the existing realtime indexing flow.

## UI

Add an Obsidian modal opened from the chat view toolbar.

Working modal title: `Media Import`.

Minimum interface:

- file picker button;
- selected file list;
- per-file status;
- per-file progress/stage;
- saved `.md` vault path;
- action to open a successful import;
- action to mention a successful import in the current chat draft;
- action to retry failed imports;
- action to remove an item from import history;
- action to cancel queued or active imports;
- action to clear completed items.
- preflight warnings for large files and extensions outside the known MarkItDown format list.

File statuses:

- `queued` - file has been added to the queue;
- `uploading` - file is being sent to the API;
- `converting` - request has been sent and Markdown is pending;
- `saving` - Markdown has been received and is being written to the vault;
- `done` - file has been saved;
- `error` - import did not complete.
- `canceled` - user canceled a queued or active import.

The current MarkItDown API is synchronous, so `uploading` and `converting` are stages of one `POST /convert` request. If the service later adds a job API, the UI can move to polling without changing the user-facing model.

## Settings

Add plugin settings:

- `mediaImportFolder`: vault-relative folder path for imported Markdown files.
- `markitdownApiBaseUrl`: service base URL, default `https://markitdown.redz.sbs`.
- `markitdownUsername`: optional Basic Auth username if the service is behind an auth proxy.
- `markitdownPassword`: optional Basic Auth password.
- `mediaImportConcurrency`: number of parallel conversions, default `2`.
- `mediaImportOverwriteMode`: filename conflict policy.

Settings should include a `Test` action for the MarkItDown API URL and credentials. It calls `GET /health` and reports either a healthy connection or a concrete HTTP/network error.

Filename conflict policy:

- `rename` - default, create `file.md`, then `file 1.md`, `file 2.md`;
- `overwrite` - overwrite the existing `.md`;
- `skip` - do not import when the output file already exists.

## API

Use the MarkItDown service:

- repository: `https://github.com/redzumi/markitdown-service`;
- production host: `https://markitdown.redz.sbs`;
- health check: `GET /health`;
- file conversion: `POST /convert`;
- request: `multipart/form-data` with a `file` field;
- response:

```json
{
  "markdown": "# Title\n\nContent...",
  "source": "document.pdf"
}
```

Supported formats from the service README:

- PDF: `.pdf`;
- Word: `.docx`;
- PowerPoint: `.pptx`;
- Excel: `.xlsx`, `.xls`;
- HTML: `.html`, `.htm`;
- text-like: `.txt`, `.csv`, `.json`, `.xml`;
- images: `.jpg`, `.png`, `.gif`, `.webp`;
- audio: `.mp3`, `.wav`;
- URL import can be a separate future scenario.

The current production host returns `401 Basic`, so settings need Basic Auth support through separate username and password fields. The plugin builds `Authorization: Basic ...` before sending the request.

## Vault Save Behavior

The output path is built as:

```text
<mediaImportFolder>/<original basename>.md
```

Examples:

- `report.pdf` -> `Imported Media/report.md`;
- `meeting-transcript.docx` -> `Imported Media/meeting-transcript.md`;
- `table.csv` -> `Imported Media/table.md`.

The folder is created automatically if it does not exist. If a file already exists at any folder path segment, import fails with a settings/path error.

Markdown is saved through the Obsidian Vault API so Obsidian sees it as a normal note and the realtime indexer can process the change.

Imported Markdown should include source metadata:

```yaml
---
source_file: "report.pdf"
source: "report.pdf"
imported_at: "2026-06-07T19:08:28.000Z"
converter: markitdown
---
```

## Queue And Concurrency

Import should run through an internal queue.

Initial policy:

- maximum 2 concurrent conversions;
- start order follows file selection order;
- one file error does not stop other files;
- closing the modal does not cancel already running imports;
- queued imports can be canceled before they start;
- active upload/conversion requests can be marked canceled; because Obsidian `requestUrl` is used to avoid browser CORS failures, in-flight HTTP work may finish in the background and its result is ignored;
- the first version does not need to restore unfinished queue items after an Obsidian restart.

If the API or proxy limits request size/rate, the queue should show a clear error on the affected file.

## Errors

The user should see a short error reason in the file row.

Typical errors:

- service unavailable;
- authentication required or invalid;
- format unsupported by MarkItDown;
- file too large;
- API returned invalid JSON;
- response does not contain `markdown`;
- folder creation failed;
- filename conflict in `skip` mode;
- file could not be saved to the vault.

## Code Integration

Expected modules:

- `src/services/mediaImportClient.ts` - HTTP client for the MarkItDown API;
- `src/services/mediaImportQueue.ts` - queue, statuses, concurrency;
- `src/ui/mediaImportModal.ts` - Obsidian import modal;
- `src/core/types.ts` - settings and status types;
- `src/ui/settingsTab.ts` - folder, URL, auth, concurrency, and conflict settings;
- `src/main.ts` - modal creation and chat toolbar wiring.

The current indexer already indexes `.md`, `.txt`, `.csv`, `.json`, and Canvas files. Imported `.md` files do not need separate indexing logic.

## Open Questions

- Should URL import live in the same modal, since the service already supports `url`?
- Should original files be stored in the vault next to the `.md`, or should the plugin save only Markdown?
- Should users choose the destination folder per import, or only through the global setting?
- Should the plugin automatically open the saved note after a single-file import?
