/**
 * config-watcher.ts
 * Config hot-reload file watching: layered fs.watch fallbacks (direct file,
 * parent directory, nearest existing ancestor, recursive when supported)
 * plus a low-cost polling safety net for inotify creation races and editor
 * atomic replaces, debounced before notifying.
 */

import { watch, existsSync, statSync, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * Watch a config file so later creation or edits trigger a reload:
 *  - if the file exists, watch it directly (catches edits);
 *  - if its parent directory exists, watch the directory (catches creation
 *    and editor-style replace-and-rename), filtered to the file name;
 *  - otherwise watch the nearest existing ancestor directory with
 *    recursive:true when supported (Windows/macOS), falling back to a
 *    non-recursive watch.
 */
function watchConfigFile(
  configPath: string,
  handleChange: () => void,
  watchers: FSWatcher[]
): void {
  const configDir = dirname(configPath);
  const fileName = basename(configPath);
  const expectedSuffix = join("pi-data-masking", fileName).split("\\").join("/");

  function matches(filename: unknown): boolean {
    if (filename === null || filename === undefined) return false;
    const normalized = String(filename).split("\\").join("/");
    return (
      normalized === fileName ||
      normalized === expectedSuffix ||
      normalized.endsWith("/" + expectedSuffix)
    );
  }

  // 1. Watch the file itself when it already exists (covers in-place edits).
  if (existsSync(configPath)) {
    try {
      watchers.push(watch(configPath, () => handleChange()));
    } catch {
      // ignore — the directory watcher below still covers most cases
    }
  }

  // 2. Watch the direct parent directory when it exists (covers creation).
  if (existsSync(configDir)) {
    try {
      watchers.push(watch(configDir, (_event, filename) => {
        if (matches(filename)) handleChange();
      }));
      return;
    } catch {
      // ignore — fall through to the ancestor watch
    }
  }

  // 3. Nearest existing ancestor (covers the whole directory chain being
  //    created after session start). Prefer recursive where supported.
  let target = configDir;
  while (!existsSync(target)) {
    const parent = dirname(target);
    if (parent === target) return; // filesystem root; nothing to watch
    target = parent;
  }
  try {
    const watcher = watch(target, { recursive: true }, (_event, filename) => {
      if (matches(filename)) handleChange();
    });
    watchers.push(watcher);
  } catch {
    try {
      watchers.push(watch(target, (_event, filename) => {
        if (matches(filename)) handleChange();
      }));
    } catch {
      // Silently ignore if watching is unsupported for this directory
    }
  }
}

export function watchConfigPaths(
  globalPath: string,
  projectPath: string,
  onChange: () => void
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleChange() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  }

  watchConfigFile(globalPath, handleChange, watchers);
  watchConfigFile(projectPath, handleChange, watchers);

  // fs.watch can miss a file created immediately after a watcher is
  // registered (notably on Linux/inotify). Polling the two small config files
  // is a low-cost safety net for that race and for editor atomic replaces.
  function fileSignature(path: string): string | null {
    try {
      const stat = statSync(path);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  let globalSignature = fileSignature(globalPath);
  let projectSignature = fileSignature(projectPath);
  const poller = setInterval(() => {
    const nextGlobalSignature = fileSignature(globalPath);
    const nextProjectSignature = fileSignature(projectPath);
    if (nextGlobalSignature !== globalSignature || nextProjectSignature !== projectSignature) {
      globalSignature = nextGlobalSignature;
      projectSignature = nextProjectSignature;
      handleChange();
    }
  }, 250);

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poller);
    watchers.forEach((w) => w.close());
  };
}
