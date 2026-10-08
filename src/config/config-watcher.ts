/**
 * config-watcher.ts
 * Config hot-reload file watching: strictly non-recursive, bounded fs.watch
 * fallbacks (direct file, config directory, immediate parent) plus a
 * low-cost polling safety net for inotify creation races and editor atomic
 * replaces, debounced before notifying.
 *
 * All watchers are attached with an 'error' listener immediately so
 * ENOSPC/ENOENT/EPERM never crash the host process via an unhandled
 * exception, and the watcher tree never climbs beyond the immediate parent
 * of the config directory (preventing inotify exhaustion over large trees
 * like node_modules or sessions/).
 */

import { watch, existsSync, statSync, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";

/** Test seam passed through from config-loader. */
export interface WatchConfigHooks {
  /** Called whenever an FSWatcher is registered. */
  onWatcher?: (watcher: FSWatcher, target: string) => void;
}

/**
 * Safely watch a filesystem target without recursion. Attaches an 'error'
 * listener immediately so ENOSPC/ENOENT/EPERM never crash the Node process
 * via an unhandled exception.
 */
function safeWatch(
  target: string,
  listener: (event: string, filename: string | null) => void,
  watchers: FSWatcher[],
  hooks?: WatchConfigHooks,
  onError?: (watcher: FSWatcher) => void,
): FSWatcher | null {
  try {
    const watcher = watch(target, listener);
    watcher.on("error", () => {
      try {
        watcher.close();
      } catch {
        // Ignore close failures
      }
      const idx = watchers.indexOf(watcher);
      if (idx !== -1) {
        watchers.splice(idx, 1);
      }
      onError?.(watcher);
    });
    watchers.push(watcher);
    hooks?.onWatcher?.(watcher, target);
    return watcher;
  } catch {
    return null;
  }
}

/** Detach a watcher, ignoring close failures. */
function detachWatcher(watcher: FSWatcher | null, watchers: FSWatcher[]): void {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // Ignore close failures
  }
  const idx = watchers.indexOf(watcher);
  if (idx !== -1) watchers.splice(idx, 1);
}

/**
 * Watch a config file so later creation or edits trigger a reload without
 * exhausting system inotify handles:
 *  - if the file exists, watch it directly (catches in-place edits);
 *  - if its container directory exists, watch it non-recursively (catches
 *    creation and editor-style replace-and-rename);
 *  - if the container directory does not exist yet, watch at most its
 *    immediate parent (e.g. ~/.pi/agent or <cwd>/.pi) non-recursively.
 *
 * Neither recursive watching nor climbing beyond the immediate parent is used,
 * preventing inotify table exhaustion over large trees like node_modules or sessions.
 * Returns a refresh function to promote watchers when newly created files/directories
 * are detected.
 */
function watchConfigFile(
  configPath: string,
  handleChange: () => void,
  watchers: FSWatcher[],
  hooks?: WatchConfigHooks,
): () => void {
  const configDir = dirname(configPath);
  const parentDir = dirname(configDir);
  const fileName = basename(configPath);
  const dirName = basename(configDir);
  const expectedSuffix = join(dirName, fileName).split("\\").join("/");

  let fileWatcher: FSWatcher | null = null;
  let dirWatcher: FSWatcher | null = null;
  let parentWatcher: FSWatcher | null = null;

  function matchesFile(filename: unknown): boolean {
    if (filename === null || filename === undefined) return true;
    const normalized = String(filename).split("\\").join("/");
    return (
      normalized === fileName ||
      normalized === expectedSuffix ||
      normalized.endsWith("/" + expectedSuffix)
    );
  }

  function matchesDir(filename: unknown): boolean {
    if (filename === null || filename === undefined) return true;
    const normalized = String(filename).split("\\").join("/");
    return (
      normalized === dirName ||
      normalized === expectedSuffix ||
      normalized.endsWith("/" + dirName) ||
      normalized.endsWith("/" + expectedSuffix)
    );
  }

  function attachFileWatcher(): void {
    if (fileWatcher || !existsSync(configPath)) return;
    fileWatcher = safeWatch(
      configPath,
      (event) => {
        if (event === "rename") {
          reattachFileWatcher();
        }
        handleChange();
      },
      watchers,
      hooks,
      (w) => {
        if (fileWatcher === w) fileWatcher = null;
      },
    );
  }

  function reattachFileWatcher(): void {
    detachWatcher(fileWatcher, watchers);
    fileWatcher = null;
    attachFileWatcher();
  }

  function attachDirWatcher(): void {
    if (dirWatcher || !existsSync(configDir)) return;
    dirWatcher = safeWatch(
      configDir,
      (_event, filename) => {
        if (matchesFile(filename)) {
          reattachFileWatcher();
          handleChange();
        }
      },
      watchers,
      hooks,
      (w) => {
        if (dirWatcher === w) dirWatcher = null;
      },
    );
  }

  function attachParentWatcher(): void {
    if (parentWatcher || dirWatcher || !existsSync(parentDir) || parentDir === configDir) return;
    parentWatcher = safeWatch(
      parentDir,
      (_event, filename) => {
        if (matchesDir(filename)) {
          if (existsSync(configDir)) {
            attachDirWatcher();
            detachWatcher(parentWatcher, watchers);
            parentWatcher = null;
            if (existsSync(configPath)) {
              attachFileWatcher();
              handleChange();
            }
          }
        }
      },
      watchers,
      hooks,
      (w) => {
        if (parentWatcher === w) parentWatcher = null;
      },
    );
  }

  function refresh(): void {
    reattachFileWatcher();
    attachDirWatcher();
    if (!dirWatcher) {
      attachParentWatcher();
    }
  }

  refresh();
  return refresh;
}

export function watchConfigPaths(
  globalPath: string,
  projectPath: string,
  onChange: () => void,
  hooks?: WatchConfigHooks,
): () => void {
  let stopped = false;
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleChange() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) onChange();
    }, 300);
  }

  const refreshGlobal = watchConfigFile(globalPath, handleChange, watchers, hooks);
  const refreshProject = watchConfigFile(projectPath, handleChange, watchers, hooks);

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
    if (stopped) return;
    const nextGlobalSignature = fileSignature(globalPath);
    const nextProjectSignature = fileSignature(projectPath);
    if (nextGlobalSignature !== globalSignature || nextProjectSignature !== projectSignature) {
      globalSignature = nextGlobalSignature;
      projectSignature = nextProjectSignature;
      refreshGlobal();
      refreshProject();
      handleChange();
    }
  }, 250);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(poller);
    for (const watcher of [...watchers]) {
      try {
        watcher.close();
      } catch {
        // Ignore close failures
      }
    }
    watchers.length = 0;
  };
}
