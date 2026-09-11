/**
 * diff-text.ts
 * Heuristic character-level diff of an original/masked string pair, used to
 * highlight exactly what masking changed in the history viewers. Deliberately
 * marker-free: it splits the pair into common and replaced spans without
 * injecting sentinel characters, with work caps so a long tool result cannot
 * turn rendering into quadratic work.
 */

export interface DiffSegment {
  original: string;
  masked: string;
  changed: boolean;
}

/** Split masked text into common and replaced spans without injecting markers. */
export function diffText(original: string, masked: string): DiffSegment[] {
  if (original === masked) return [{ original, masked, changed: false }];
  const maxWork = 32_000;
  if (original.length + masked.length > maxWork) return [{ original, masked, changed: true }];

  let before = original;
  let after = masked;
  const segments: DiffSegment[] = [];
  const push = (left: string, right: string, changed: boolean) => {
    if (left.length === 0 && right.length === 0) return;
    const prior = segments.at(-1);
    if (prior?.changed === changed) {
      prior.original += left;
      prior.masked += right;
    } else {
      segments.push({ original: left, masked: right, changed });
    }
  };

  while (before !== after && before.length > 0 && after.length > 0) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    // A shared prefix that ends inside a word can belong to the replacement
    // itself (for example the leading `m` in mysecret → maskedsecret). Keep
    // stable punctuation/context, but move the tentative boundary back to the
    // beginning of that lexical token before recording the changed span.
    if (
      prefix > 0 && prefix < before.length && prefix < after.length &&
      WORD_CHARACTER.test(before[prefix - 1] ?? "") &&
      WORD_CHARACTER.test(before[prefix] ?? "") &&
      WORD_CHARACTER.test(after[prefix] ?? "")
    ) {
      while (
        prefix > 0 &&
        WORD_CHARACTER.test(before[prefix - 1] ?? "") &&
        WORD_CHARACTER.test(after[prefix - 1] ?? "")
      ) prefix--;
    }
    push(before.slice(0, prefix), after.slice(0, prefix), false);
    before = before.slice(prefix);
    after = after.slice(prefix);
    if (before === after) {
      push(before, after, false);
      return segments;
    }

    // Look for the next sufficiently useful shared fragment. The cap keeps a
    // long tool result from turning history rendering into quadratic work.
    let anchorOriginal = -1;
    let anchorMasked = -1;
    const scan = Math.min(before.length, 2_000);
    for (let start = 0; start < scan; start++) {
      const fragment = before.slice(start, start + 6);
      if (fragment.length < 3) break;
      const found = after.indexOf(fragment);
      // Prefix rewinding can leave the same shared fragment at offset zero in
      // both strings. Accepting that (0, 0) anchor would slice away nothing
      // and repeat this loop forever, so every anchor must advance at least
      // one side of the comparison.
      if (
        found >= 0 && (start > 0 || found > 0) &&
        isContextAnchor(before, start) && isContextAnchor(after, found)
      ) {
        anchorOriginal = start;
        anchorMasked = found;
        break;
      }
    }
    if (anchorOriginal < 0) {
      // Short closing delimiters (for example the final backtick in
      // `wsl90.top` → `test.xyz`) are too small to qualify as scan anchors,
      // but they are still unchanged context and must not appear inside the
      // factual replacement span. Preserve only the immediately trailing
      // non-word run; shared lexical suffixes remain part of the replacement.
      const trailingContext = sharedTrailingNonWordLength(before, after);
      if (trailingContext > 0) {
        push(before.slice(0, -trailingContext), after.slice(0, -trailingContext), true);
        push(before.slice(-trailingContext), after.slice(-trailingContext), false);
      } else {
        push(before, after, true);
      }
      return segments;
    }
    push(before.slice(0, anchorOriginal), after.slice(0, anchorMasked), true);
    before = before.slice(anchorOriginal);
    after = after.slice(anchorMasked);
  }
  push(before, after, before !== after);
  return segments;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Shared text inside a replacement is not unchanged context. Only use an
 * anchor that begins at a lexical boundary; this keeps `mysecret` →
 * `maskedsecret` as one factual-looking replacement instead of inventing the
 * misleading `my` → `masked` mapping from their shared `secret` suffix.
 */
function isContextAnchor(text: string, start: number): boolean {
  if (start <= 0) return true;
  return !WORD_CHARACTER.test(text[start - 1] ?? "") || !WORD_CHARACTER.test(text[start] ?? "");
}

/** Length of the identical trailing punctuation/whitespace run on both sides. */
function sharedTrailingNonWordLength(original: string, masked: string): number {
  let length = 0;
  while (length < original.length && length < masked.length) {
    const originalChar = original[original.length - length - 1] ?? "";
    const maskedChar = masked[masked.length - length - 1] ?? "";
    if (originalChar !== maskedChar || WORD_CHARACTER.test(originalChar)) break;
    length++;
  }
  return length;
}
