/**
 * guidance.ts
 * Composes the data-masking system-prompt note (options.systemPromptGuidance).
 *
 * Two switches compose into three states (see docs/model-guidance-design.md):
 *  - off                → no note at all
 *  - guidance only      → preamble only, no list-oriented phrasing
 *  - full form          → preamble + grouped disclosure list
 *
 * Disclosure requires guidance: the config loader auto-corrects a config
 * that enables disclosure without guidance (see config-loader.ts).
 */

import type { MaskingConfig } from "./config-loader.ts";

export interface GuidanceDisclosureEntry {
  placeholder: string;
  /** true → "Custom substitutes" group (fixed replacement text). */
  custom: boolean;
}

const PREAMBLE_HEAD =
  "Some values in this conversation are synthetic placeholders substituted for hidden real values.";

const PREAMBLE_BODY = [
  "Placeholders are opaque tokens. Generated placeholders preserve length,",
  "character classes, separators, and any explicitly retained prefixes or IP",
  "octets — these properties are faithful to the original values, and all",
  "other characters are random. Substitutes that are not generated may not",
  "preserve any structure. Two placeholders are equal if and only if their",
  "original values are equal (within this conversation). To compare two values,",
  "pass both strings verbatim to a tool (or compare the complete strings",
  "exactly); any sampled, normalized, or derived comparison — prefix/suffix,",
  "length, case-folding, encoding, hashing — can equate different values or",
  "split identical ones. For anything beyond equality, prefer a tool:",
  "placeholders are restored automatically in tool arguments. If a task needs a",
  "transformed form of a value (encoded, escaped, or embedded in generated",
  "code), pass the placeholder verbatim to a tool and let the tool perform the",
  "transformation. Always pass them verbatim; never slice, hash, or encode them",
  "yourself. Do not read meaning into their characters: they preserve only",
  "rough shape, so assertions about the original value's content will be wrong.",
  "If a value behaves inconsistently in a way that blocks your task (its",
  "documented properties do not match, sources disagree about its identity, a",
  "tool rejects a value that appears correct), do not investigate the value",
  "itself or try to locate its original form; describe the discrepancy and ask",
  "the user how to proceed. Never request the original values.",
].join("\n");

const GENERATED_GROUP_HEADING = "Generated substitutes (structure preserved):";
const CUSTOM_GROUP_HEADING = "Custom substitutes (structure not preserved):";

/**
 * Compose the note. `entries` may be empty — the disclosure block (lead-in
 * sentence, group headings, entries) is emitted atomically only when at
 * least one entry is present, so the guidance-only form contains no
 * list-oriented phrasing at all.
 */
export function composeGuidanceNote(entries: readonly GuidanceDisclosureEntry[]): string {
  const generated = dedupeEntries(entries.filter((entry) => !entry.custom));
  const custom = dedupeEntries(entries.filter((entry) => entry.custom));

  const blocks: string[] = [PREAMBLE_HEAD];
  if (generated.length > 0 || custom.length > 0) {
    const listLines: string[] = ["The following strings are placeholders (this list may not be exhaustive):", ""];
    if (generated.length > 0) {
      listLines.push(GENERATED_GROUP_HEADING);
      listLines.push(...generated.map((entry) => `- ${entry.placeholder}`));
      if (custom.length > 0) listLines.push("");
    }
    if (custom.length > 0) {
      listLines.push(CUSTOM_GROUP_HEADING);
      listLines.push(...custom.map((entry) => `- ${entry.placeholder}`));
    }
    blocks.push(listLines.join("\n"));
  }
  blocks.push(PREAMBLE_BODY);
  return `[Data-masking note]\n${blocks.join("\n\n")}`;
}

/** Keep first occurrence; placeholders dedupe across rules sharing a real value. */
function dedupeEntries(entries: readonly GuidanceDisclosureEntry[]): GuidanceDisclosureEntry[] {
  const seen = new Set<string>();
  const result: GuidanceDisclosureEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.placeholder)) continue;
    seen.add(entry.placeholder);
    result.push(entry);
  }
  return result;
}

/**
 * Resolve the disclosure entries for the current config: enabled + available
 * literal rules whose effective disclosure flag (rule override, else the
 * global `disclosePlaceholders` default) is true. WAIT-state rules have no
 * placeholder and are skipped. Regex rules are never disclosed — their
 * placeholders are generated lazily and would break the provider prefix
 * cache mid-session.
 */
export function guidanceDisclosureEntries(config: MaskingConfig): GuidanceDisclosureEntry[] {
  const entries: GuidanceDisclosureEntry[] = [];
  for (const configured of config.configuredRules) {
    if (!configured.enabled || !configured.available) continue;
    if (configured.sourceKind !== "literal") continue;
    const literal = configured.rule as { placeholder?: string; disclosePlaceholder?: boolean };
    const effective = literal.disclosePlaceholder ?? config.options.disclosePlaceholders;
    if (!effective) continue;
    const placeholder = literal.placeholder;
    if (!placeholder || placeholder === "auto") continue; // WAIT-state or lazy
    entries.push({ placeholder, custom: configured.placeholderMode === "custom" });
  }
  return entries;
}

/** The composed note, or null when guidance is disabled (no note at all). */
export function guidanceNoteForConfig(config: MaskingConfig): string | null {
  if (!config.options.systemPromptGuidance) return null;
  return composeGuidanceNote(guidanceDisclosureEntries(config));
}
