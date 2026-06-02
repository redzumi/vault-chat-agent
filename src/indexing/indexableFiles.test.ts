import { equal } from "node:assert/strict";
import { test } from "node:test";
import { MAX_INDEXABLE_FILE_BYTES, isIndexableVaultFileLike, isIndexableVaultPath } from "./indexableFiles";

test("isIndexableVaultPath excludes service and hidden paths", () => {
  equal(isIndexableVaultPath("Notes/Project.md"), true);
  equal(isIndexableVaultPath(".obsidian/plugins/vault-chat-agent/data.json"), false);
  equal(isIndexableVaultPath("Notes/.hidden.md"), false);
  equal(isIndexableVaultPath(".git/config"), false);
  equal(isIndexableVaultPath("node_modules/pkg/index.js"), false);
});

test("isIndexableVaultFileLike excludes oversized files", () => {
  equal(isIndexableVaultFileLike({ path: "Notes/Small.md", stat: { size: MAX_INDEXABLE_FILE_BYTES } }), true);
  equal(isIndexableVaultFileLike({ path: "Notes/Large.md", stat: { size: MAX_INDEXABLE_FILE_BYTES + 1 } }), false);
});
