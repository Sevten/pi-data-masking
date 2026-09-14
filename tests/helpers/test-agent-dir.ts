/**
 * Must be imported FIRST (before anything that loads config-loader.ts):
 * it sets PI_CODING_AGENT_DIR so module-level path constants like
 * GLOBAL_CONFIG_PATH resolve into a throwaway temp directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "masking-ui-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.on("exit", () => rmSync(TEST_AGENT_DIR, { recursive: true, force: true }));
/** Global config path under the overridden agent dir. */
export const globalConfigPath = join(TEST_AGENT_DIR, "pi-data-masking", "masking.config.json");
