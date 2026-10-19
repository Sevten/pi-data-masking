/**
 * Destination extraction from tool-call arguments: given the deep strings of
 * an input object, produce the deduplicated, normalized set of network
 * destinations the call appears to target. Only runs on the tool_call path
 * when a scoped rule's placeholder was hit — no placeholders, no cost.
 *
 * Two shapes are recognized (see docs/egress-scoping-design.md):
 * - structured fields (`url`, `endpoint`, `host`, `hostname`, `baseUrl`,
 *   `origin`, …) parsed as a whole URL or bare host;
 * - free-form strings scanned for `scheme://host[:port]/…`, `host:port`,
 *   and `user@host` shapes.
 *
 * All hosts go through normalizeHost() (lowercase, trailing dot, punycode,
 * IPv4 literal decoding); userinfo components are excluded so
 * `https://api.stripe.com@evil.com/` yields `evil.com`.
 */

import { normalizeHost } from "./restore-scope.ts";

/** Keys whose whole string value is treated as a URL/host (lowercased). */
const STRUCTURED_KEYS = new Set([
  "url",
  "endpoint",
  "host",
  "hostname",
  "baseurl",
  "base_url",
  "origin",
  "server",
  "target",
  "targeturl",
  "target_url",
  "apiurl",
  "api_url",
  "webhook",
  "webhookurl",
  "webhook_url",
  "remote",
  "repository",
]);

/** HOST core: domain names, IPv4 literals (full, short-dotted, decimal,
 *  hex forms — normalizeHost folds them all via WHATWG URL rules),
 *  `localhost`, and IPv6 (bracketed, or bare with ≥ 3 colon-separated
 *  groups so `host:port`-shaped text cannot match). */
const HOST_CORE =
  "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}|" +
    "(?:\\d{1,8}|0x[0-9a-f]+)(?:\\.(?:\\d{1,8}|0x[0-9a-f]+)){1,3}|" +
    "\\d{8,10}|localhost";
const BRACKET_IPV6 = "\\[[0-9a-f:.]+\\]";
const BARE_IPV6 = "[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,}";

/**
 * Free-form scan: optional scheme, optional userinfo (excluded from the
 * result), optional port. Trailing path/query/whitespace/punctuation ends
 * the match. Used only when a whole-string URL/host parse did not apply.
 */
const FREEFORM = new RegExp(
  "((?:[a-z][a-z0-9+.-]*:\\/\\/))?" + // 1: scheme
    "((?:[^\\s:@/'\"<>`]+@))?" + // 2: userinfo (excluded from results)
    `(${HOST_CORE}|${BRACKET_IPV6}|${BARE_IPV6})` + // 3: host
    "(:\\d{1,5})?" + // 4: port
    "(?=$|[/?#:\\s,;){}<>\"'])",
  "gi",
);

/** Extract the deduplicated, normalized destination hosts of a tool input. */
export function extractDestinations(input: unknown): string[] {
  const found = new Set<string>();
  collect(input, found, false);
  return [...found];
}

/**
 * Raw destination URL text of a tool input (audit display only — never
 * used in decisions, plan §A6): the matched `scheme://host[:port]/path`
 * fragments so a blocked call reads with its request context, not just
 * the host. Bounded: 5 URLs, 160 characters each.
 */
export function extractDestinationUrls(input: unknown): string[] {
  const strings: string[] = [];
  collectStrings(input, strings);
  const found: string[] = [];
  const seen = new Set<string>();
  FREEFORM.lastIndex = 0;
  for (const text of strings) {
    for (const m of text.matchAll(FREEFORM)) {
      if (!m[1] && !m[2] && !m[4]) continue; // same pinned shapes as hosts
      const raw = m[0].slice(0, 160);
      if (!seen.has(raw)) {
        seen.add(raw);
        found.push(raw);
        if (found.length >= 5) return found;
      }
    }
  }
  return found;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function collect(value: unknown, found: Set<string>, structuredKey: boolean, structuredOnly = false): void {
  if (typeof value === "string") {
    if (structuredKey) {
      addHost(value, found);
      // Structured fields may still carry several URLs (e.g. an array
      // serialized as text); scan leftovers too.
      scanFreeform(value, found);
      return;
    }
    if (structuredOnly) return; // payload≠intent: skip non-structured strings
    scanFreeform(value, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found, structuredKey, structuredOnly);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, found, STRUCTURED_KEYS.has(key.toLowerCase()), structuredOnly);
    }
  }
}

/** Parse one structured value: whole URL first, then bare host. */
function addHost(value: string, found: Set<string>): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  for (const candidate of urlHost(trimmed) ?? [trimmed]) {
    const normalized = normalizeHost(candidate);
    if (normalized) found.add(normalized);
  }
}

/** Destinations declared by structured fields only (`url`, `host`,
 *  `endpoint`, …): the payload≠intent discipline for tools whose input is
 *  a record (write `content`, read results, …). Free-form strings in
 *  non-structured fields merely mention hosts — a document body naming
 *  `evil.com` is not an outbound call — so they are not scanned. Shell
 *  tools (bash/powershell) must NOT use this: their `command` string is
 *  both action and payload, and is not under a structured key. */
export function extractStructuredDestinations(input: unknown): string[] {
  const found = new Set<string>();
  collect(input, found, false, true);
  return [...found];
}

/** Hostname of a full URL, userinfo excluded. Null when not URL-shaped. */
function urlHost(value: string): string[] | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith("//")) return null;
  try {
    return [new URL(value).hostname];
  } catch {
    return null;
  }
}

function scanFreeform(text: string, found: Set<string>): void {
  FREEFORM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FREEFORM.exec(text))) {
    // Pinned free-form shapes: scheme://host, user@host, host:port. A bare
    // domain-shaped token ("cat config.yaml") is not a destination.
    const scheme = m[1];
    const userinfo = m[2];
    const host = m[3];
    const port = m[4];
    if (!scheme && !userinfo && !port) continue;
    const bare = host.replace(/^\[|\]$/g, "");
    // Bare IPv6 needs brackets for the URL-based normalizer, and only
    // normalizes when it is a real address (odd shapes drop out).
    const normalized = normalizeHost(bare.includes(":") ? `[${bare}]` : bare);
    if (normalized) found.add(normalized);
  }
}
