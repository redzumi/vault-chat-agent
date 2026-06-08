const EXCLUDED_PATH_PARTS = new Set([".git", "node_modules"]);

export const MAX_INDEXABLE_FILE_BYTES = 1_500_000;

export interface IndexableVaultPathOptions {
  configDir?: string;
}

export function isIndexableVaultPath(path: string, options: IndexableVaultPathOptions = {}): boolean {
  if (isPathInsideDirectory(path, options.configDir)) {
    return false;
  }

  const parts = path.split("/");
  return parts.every((part) => part && !part.startsWith(".") && !EXCLUDED_PATH_PARTS.has(part));
}

export function isIndexableVaultFileLike(file: { path: string; stat?: { size?: number } }, options: IndexableVaultPathOptions = {}): boolean {
  if (!isIndexableVaultPath(file.path, options)) {
    return false;
  }

  return typeof file.stat?.size !== "number" || file.stat.size <= MAX_INDEXABLE_FILE_BYTES;
}

function isPathInsideDirectory(path: string, directory?: string): boolean {
  const normalizedDirectory = directory?.replace(/^\/+|\/+$/g, "");
  if (!normalizedDirectory) {
    return false;
  }

  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}
