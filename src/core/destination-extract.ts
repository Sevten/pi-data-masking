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

/** HOST core: domain names, IPv4 literals, `localhost`. */
const HOST_CORE =
  "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}|" +
    "(?:\\d{1,3}\\.){3}\\d{1,3}|\\d{8,10}|localhost";
const BRACKET_IPV6 = "\\[[0-9a-f:.]+\\]";

/**
 * Free-form scan: optional scheme, optional userinfo (excluded from the
 * result), optional port. Trailing path/query/whitespace/punctuation ends
 * the match. Used only when a whole-string URL/host parse did not apply.
 */
const FREEFORM = new RegExp(
  "((?:[a-z][a-z0-9+.-]*:\\/\\/))?" + // 1: scheme
    "((?:[^\\s:@/'\"<>`]+@))?" + // 2: userinfo (excluded from results)
    `(${HOST_CORE}|${BRACKET_IPV6})` + // 3: host
    "(:\\d{1,5})?" + // 4: port
    "(?=$|[/?#:\\s,;){}<>])",
  "gi",
);

/** Extract the deduplicated, normalized destination hosts of a tool input. */
export function extractDestinations(input: unknown): string[] {
  const found = new Set<string>();
  collect(input, found, false);
  return [...found];
}

function collect(value: unknown, found: Set<string>, structuredKey: boolean): void {
  if (typeof value === "string") {
    if (structuredKey) {
      addHost(value, found);
      // Structured fields may still carry several URLs (e.g. an array
      // serialized as text); scan leftovers too.
      scanFreeform(value, found);
      return;
    }
    scanFreeform(value, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found, structuredKey);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, found, STRUCTURED_KEYS.has(key.toLowerCase()));
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
    const normalized = normalizeHost(host.replace(/^\[|\]$/g, ""));
    if (normalized) found.add(normalized);
  }
}
