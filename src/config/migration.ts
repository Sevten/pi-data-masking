/**
 * migration.ts
 * One-time upgrade notices for existing users. State lives in a marker file
 * next to (but separate from) the strict-JSON masking configs, so hand edits
 * and schema validation of the configs are unaffected.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Bump to re-notify users of a materially new guidance-related capability. */
export const GUIDANCE_NOTICE_VERSION = 1;

export interface MigrationState {
  guidanceNoticeVersion?: number;
}

export function migrationStatePath(agentDir: string): string {
  return join(agentDir, "pi-data-masking", "migration-state.json");
}

export function readMigrationStateSync(path: string): MigrationState {
  try {
    const parsed = JSON.parse(existsSync(path) ? readFileSync(path, "utf8") : "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as MigrationState;
  } catch {
    return {};
  }
}

/** Atomically persist state with user-only permissions. */
export async function writeMigrationState(path: string, state: MigrationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

export interface GuidanceNoticeDecision {
  /** Show the one-time notify and the settings highlight row. */
  pending: boolean;
}

/**
 * Decide whether the guidance notice should fire. Only existing-config users
 * are notified — new users discover the toggles during first-run setup. The
 * caller persists the marker immediately after (once-only semantics).
 */
export function decideGuidanceNotice(
  state: MigrationState,
  configExists: boolean,
): GuidanceNoticeDecision {
  return { pending: configExists && (state.guidanceNoticeVersion ?? 0) < GUIDANCE_NOTICE_VERSION };
}

/** The marker update that makes the notice never repeat. */
export function markGuidanceNoticeShown(state: MigrationState): MigrationState {
  return { ...state, guidanceNoticeVersion: GUIDANCE_NOTICE_VERSION };
}
