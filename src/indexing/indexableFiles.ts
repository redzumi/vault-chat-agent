const EXCLUDED_PATH_PARTS = new Set([".obsidian", ".git", "node_modules"]);

export const MAX_INDEXABLE_FILE_BYTES = 1_500_000;

export function isIndexableVaultPath(path: string): boolean {
  const parts = path.split("/");
  return parts.every((part) => part && !part.startsWith(".") && !EXCLUDED_PATH_PARTS.has(part));
}

export function isIndexableVaultFileLike(file: { path: string; stat?: { size?: number } }): boolean {
  if (!isIndexableVaultPath(file.path)) {
    return false;
  }

  return typeof file.stat?.size !== "number" || file.stat.size <= MAX_INDEXABLE_FILE_BYTES;
}
