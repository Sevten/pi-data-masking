import { readFileSync } from "node:fs";

/** Normalize values exactly as the bundled high-risk term list is matched. */
export function normalizeCommonSemanticValue(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function loadCommonSemanticTerms(): ReadonlySet<string> {
  const source = readFileSync(new URL("./common-semantic-terms.txt", import.meta.url), "utf8");
  const terms = new Set<string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    terms.add(normalizeCommonSemanticValue(line));
  }
  return terms;
}

/**
 * True when the complete value is a bundled common semantic term. Deliberately
 * does not use substring matching: a longer, uncommon value containing
 * "admin" does not have the same accidental-collision risk as "admin" itself.
 */
export const COMMON_SEMANTIC_TERMS = loadCommonSemanticTerms();

export function isCommonSemanticValue(value: string): boolean {
  return COMMON_SEMANTIC_TERMS.has(normalizeCommonSemanticValue(value));
}
