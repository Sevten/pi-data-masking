/**
 * Conservative diagnostics for JavaScript regular expressions that may take
 * excessive time on a failing input. This is intentionally advisory: regex
 * performance is input-dependent, so callers should warn rather than reject.
 */

export interface RegexSafetyIssue {
  kind: "nested-repetition" | "overlapping-alternatives" | "adjacent-repetition";
  message: string;
}

interface Quantifier {
  unbounded: boolean;
  min: number;
}

interface RegexNode {
  kind: "atom" | "group" | "assertion";
  source: string;
  alternatives?: RegexNode[][];
  quantifier?: Quantifier;
  min: number;
}

interface ParserState {
  index: number;
  pattern: string;
}

function readQuantifier(state: ParserState): Quantifier | undefined {
  const { pattern } = state;
  const start = state.index;
  let quantifier: Quantifier | undefined;
  if (pattern[start] === "*") {
    quantifier = { min: 0, unbounded: true };
    state.index++;
  } else if (pattern[start] === "+") {
    quantifier = { min: 1, unbounded: true };
    state.index++;
  } else if (pattern[start] === "?") {
    quantifier = { min: 0, unbounded: false };
    state.index++;
  } else if (pattern[start] === "{") {
    const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(start));
    if (match) {
      quantifier = {
        min: Number(match[1]),
        unbounded: match[2] === "",
      };
      state.index += match[0].length;
    }
  }
  if (quantifier && (pattern[state.index] === "?" || pattern[state.index] === "+")) {
    state.index++;
  }
  return quantifier;
}

function parseAlternatives(state: ParserState): RegexNode[][] {
  const alternatives: RegexNode[][] = [[]];
  while (state.index < state.pattern.length && state.pattern[state.index] !== ")") {
    if (state.pattern[state.index] === "|") {
      alternatives.push([]);
      state.index++;
      continue;
    }
    alternatives[alternatives.length - 1]!.push(parseAtom(state));
  }
  return alternatives;
}

function parseAtom(state: ParserState): RegexNode {
  const start = state.index;
  const first = state.pattern[state.index]!;
  let node: RegexNode;

  if (first === "[") {
    state.index++;
    while (state.index < state.pattern.length) {
      if (state.pattern[state.index] === "\\") state.index += 2;
      else if (state.pattern[state.index++] === "]") break;
    }
    node = { kind: "atom", source: state.pattern.slice(start, state.index), min: 1 };
  } else if (first === "\\") {
    state.index += 2;
    if ((state.pattern[start + 1] === "p" || state.pattern[start + 1] === "P") && state.pattern[state.index] === "{") {
      const close = state.pattern.indexOf("}", state.index + 1);
      if (close >= 0) state.index = close + 1;
    }
    const source = state.pattern.slice(start, state.index);
    const assertion = /^\\[bBAzZG]$/.test(source);
    node = { kind: assertion ? "assertion" : "atom", source, min: assertion ? 0 : 1 };
  } else if (first === "(") {
    state.index++;
    let assertion = false;
    if (state.pattern[state.index] === "?") {
      if (state.pattern.startsWith("?<=", state.index) || state.pattern.startsWith("?<!", state.index)) {
        assertion = true;
        state.index += 3;
      } else if (state.pattern.startsWith("?=", state.index) || state.pattern.startsWith("?!", state.index)) {
        assertion = true;
        state.index += 2;
      } else if (state.pattern.startsWith("?:", state.index)) {
        state.index += 2;
      } else if (state.pattern.startsWith("?<", state.index)) {
        const close = state.pattern.indexOf(">", state.index + 2);
        state.index = close >= 0 ? close + 1 : state.index + 2;
      } else {
        const colon = state.pattern.indexOf(":", state.index + 1);
        if (colon >= 0) state.index = colon + 1;
      }
    }
    const alternatives = parseAlternatives(state);
    if (state.pattern[state.index] === ")") state.index++;
    node = {
      kind: assertion ? "assertion" : "group",
      source: state.pattern.slice(start, state.index),
      alternatives,
      min: assertion ? 0 : Math.min(...alternatives.map(sequenceMin)),
    };
  } else {
    state.index++;
    const assertion = first === "^" || first === "$";
    node = { kind: assertion ? "assertion" : "atom", source: first, min: assertion ? 0 : 1 };
  }

  const quantifier = readQuantifier(state);
  if (quantifier) {
    node.quantifier = quantifier;
    node.min *= quantifier.min;
  }
  return node;
}

function sequenceMin(sequence: RegexNode[]): number {
  return sequence.reduce((sum, node) => sum + node.min, 0);
}

function isUnbounded(node: RegexNode): boolean {
  return node.quantifier?.unbounded === true;
}

function hasUnboundedDescendant(node: RegexNode): boolean {
  return node.alternatives?.some((sequence) => sequence.some(
    (child) => isUnbounded(child) || hasUnboundedDescendant(child),
  )) ?? false;
}

function atomClass(node: RegexNode): string | undefined {
  if (node.kind !== "atom") return undefined;
  if (node.source === ".") return "any";
  if (node.source === "\\d" || node.source === "\\D") return node.source;
  if (node.source === "\\w" || node.source === "\\W") return node.source;
  if (node.source === "\\s" || node.source === "\\S") return node.source;
  if (node.source.startsWith("[")) return node.source;
  if (node.source.startsWith("\\") && node.source.length === 2) return `literal:${node.source[1]}`;
  if (node.source.length === 1) return `literal:${node.source}`;
  return undefined;
}

function classesOverlap(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  if (left === "any" || right === "any" || left === right) return true;
  const literal = left.startsWith("literal:") ? left.slice(8) : right.startsWith("literal:") ? right.slice(8) : undefined;
  const category = left.startsWith("literal:") ? right : right.startsWith("literal:") ? left : undefined;
  if (literal !== undefined && category) {
    if (category === "\\d") return /[0-9]/.test(literal);
    if (category === "\\w") return /[A-Za-z0-9_]/.test(literal);
    if (category === "\\s") return /\s/.test(literal);
  }
  return (left === "\\d" && right === "\\w") || (left === "\\w" && right === "\\d");
}

function nestedRepetitionMayOverlap(group: RegexNode): boolean {
  if (!group.alternatives) return false;
  for (const sequence of group.alternatives) {
    for (let index = 0; index < sequence.length; index++) {
      const child = sequence[index]!;
      if (!isUnbounded(child) && !hasUnboundedDescendant(child)) continue;
      const peers = sequence.filter((_, peerIndex) => peerIndex !== index && sequence[peerIndex]!.min > 0);
      if (peers.length === 0) return true;
      const childClass = atomClass(child);
      if (peers.some((peer) => classesOverlap(childClass, atomClass(peer)))) return true;
    }
  }
  return false;
}

function simpleLiteral(sequence: RegexNode[]): string | undefined {
  let result = "";
  for (const node of sequence) {
    if (node.kind === "assertion") continue;
    if (node.kind !== "atom" || node.quantifier || node.source.startsWith("[") || node.source === ".") return undefined;
    if (node.source.startsWith("\\")) {
      if (node.source.length !== 2 || /[dDsSwWpPkK]/.test(node.source[1]!)) return undefined;
      result += node.source[1];
    } else {
      result += node.source;
    }
  }
  return result || undefined;
}

function alternativesOverlap(group: RegexNode): boolean {
  const literals = group.alternatives?.map(simpleLiteral).filter((value): value is string => value !== undefined) ?? [];
  for (let left = 0; left < literals.length; left++) {
    for (let right = left + 1; right < literals.length; right++) {
      if (literals[left]!.startsWith(literals[right]!) || literals[right]!.startsWith(literals[left]!)) return true;
    }
  }
  return false;
}

function inspectSequences(alternatives: RegexNode[][], issues: Set<RegexSafetyIssue["kind"]>): void {
  for (const sequence of alternatives) {
    for (let index = 0; index < sequence.length; index++) {
      const node = sequence[index]!;
      if (node.kind === "group" && isUnbounded(node)) {
        if (nestedRepetitionMayOverlap(node)) issues.add("nested-repetition");
        if (alternativesOverlap(node)) issues.add("overlapping-alternatives");
      }
      if (node.alternatives) inspectSequences(node.alternatives, issues);
      const next = sequence[index + 1];
      if (next && isUnbounded(node) && isUnbounded(next)
        && classesOverlap(atomClass(node), atomClass(next))) {
        issues.add("adjacent-repetition");
      }
    }
  }
}

export function analyzeRegexSafety(pattern: string): RegexSafetyIssue[] {
  const state: ParserState = { index: 0, pattern };
  const alternatives = parseAlternatives(state);
  const kinds = new Set<RegexSafetyIssue["kind"]>();
  inspectSequences(alternatives, kinds);
  const messages: Record<RegexSafetyIssue["kind"], string> = {
    "nested-repetition": "nested unbounded quantifiers may cause excessive backtracking on a non-match",
    "overlapping-alternatives": "overlapping alternatives inside an unbounded repetition may cause excessive backtracking",
    "adjacent-repetition": "adjacent overlapping unbounded quantifiers may cause excessive backtracking",
  };
  return [...kinds].map((kind) => ({ kind, message: messages[kind] }));
}
