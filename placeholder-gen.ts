/**
 * placeholder-gen.ts
 * Session key management + format-preserving placeholder generation.
 *
 * Algorithm: HMAC(sessionKey, real) derives a deterministic byte stream, then
 * each character is mapped by type (upper->upper, lower->lower, digit->digit,
 * separators kept as-is).
 *
 * Connection strings: known schemes (postgresql://, mysql://, ...) keep the
 * scheme, port, and path; only userinfo and host are replaced.
 *
 * IPv4 addresses: a plain per-character replacement can't guarantee each
 * octet stays within 0-255 (e.g. "172" could become "988"). When real is
 * exactly a valid IPv4 address, each octet is generated independently in
 * 0-255 so the placeholder is always syntactically valid.
 *
 * Same real + same sessionKey always yields the same placeholder, so
 * Masker's unmask logic needs no extra bookkeeping for literal rules.
 *
 * Used in two contexts:
 *  1. Literal rules — config-loader.ts calls this once at load time.
 *  2. Regex rules — masker.ts calls this at runtime for each newly matched
 *     value, since the real value isn't known until a match occurs.
 *
 * Collision protection: an optional `attempt` parameter perturbs the HMAC
 * input. The caller (masker.ts) retries with an incremented attempt when a
 * generated placeholder collides with one already in use.
 */

import { createHmac, randomBytes } from "node:crypto";

// ─── Character sets ───────────────────────────────────────────────────────

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS    = "0123456789";

// ─── Known URI schemes ────────────────────────────────────────────────────

const KNOWN_SCHEMES = [
  "postgresql", "mysql", "mariadb", "redis", "mongodb",
  "amqp", "amqps", "https", "http", "ftp", "sftp",
];

// ─── Public API ───────────────────────────────────────────────────────────

/** Generate a session key once per session_start. */
export function generateSessionKey(): Buffer {
  return randomBytes(32);
}

/**
 * Generate a format-preserving placeholder for a real value.
 * Same real + same sessionKey + same attempt always yields the same result.
 *
 * @param attempt Collision-retry counter, default 0. Caller increments it
 *                when the result collides with an already-used placeholder.
 */
export function generatePlaceholder(
  real: string,
  sessionKey: Buffer,
  attempt = 0
): string {
  const bytes = deriveKeyStream(sessionKey, real, real.length + 64, attempt);

  for (const scheme of KNOWN_SCHEMES) {
    if (real.startsWith(scheme + "://")) {
      return replaceConnectionString(real, scheme + "://", bytes);
    }
  }

  const ipv4Placeholder = replaceIPv4(real, bytes);
  if (ipv4Placeholder !== null) return ipv4Placeholder;

  // Default: format-preserving replacement over the whole string
  return Array.from(real)
    .map((ch, i) => fprChar(ch, bytes[i]))
    .join("");
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Derive a deterministic byte stream. Each HMAC round yields 32 bytes;
 * rounds are concatenated until the requested length is reached. `round`
 * acts as a nonce so rounds are independent; `attempt` is mixed in too so
 * collision retries get an unrelated byte stream.
 */
function deriveKeyStream(
  sessionKey: Buffer,
  real: string,
  length: number,
  attempt = 0
): number[] {
  const bytes: number[] = [];
  let round = 0;
  while (bytes.length < length) {
    const h = createHmac("sha256", sessionKey);
    h.update(`${attempt}:${round}:${real}`);
    bytes.push(...Array.from(h.digest()));
    round++;
  }
  return bytes;
}

/**
 * If real is exactly a valid IPv4 address (four octets, 0-255 each),
 * generate a placeholder by picking a random byte (already 0-255) per
 * octet. Returns null otherwise so the caller falls back to generic FPR.
 */
function replaceIPv4(real: string, bytes: number[]): string | null {
  const m = real.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;

  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null; // not a valid IPv4, treat as plain text

  return [0, 1, 2, 3].map((i) => String(bytes[i])).join(".");
}

/** Single-character format-preserving replacement */
function fprChar(ch: string, byte: number): string {
  if (ch >= "A" && ch <= "Z") return UPPERCASE[byte % 26];
  if (ch >= "a" && ch <= "z") return LOWERCASE[byte % 26];
  if (ch >= "0" && ch <= "9") return DIGITS[byte % 10];
  return ch; // separators / special chars kept as-is
}

/**
 * Format-preserving replacement for connection strings.
 * `bytes` is indexed by position in the original string so each segment is
 * randomized independently.
 *
 * Strategy:
 *   scheme://  → kept as-is (protocol identifier)
 *   userinfo   → replaced (the "admin:password" part)
 *   @          → kept as-is (separator)
 *   host       → replaced
 *   :port/path → kept as-is (structural, the LLM needs it for context)
 */
function replaceConnectionString(
  real: string,
  prefix: string,
  bytes: number[]
): string {
  const rest = real.slice(prefix.length);
  const result: string[] = [prefix]; // scheme written as-is
  let pos = prefix.length;           // byte-stream offset follows original position

  const atIdx = rest.lastIndexOf("@");

  if (atIdx !== -1) {
    // Has userinfo: replace it, keep the @
    const userinfo = rest.slice(0, atIdx);
    for (let i = 0; i < userinfo.length; i++) {
      result.push(fprChar(userinfo[i], bytes[pos + i]));
    }
    result.push("@");
    pos += userinfo.length + 1; // +1 to skip @

    // Replace host, keep :port/path
    const hostAndPath = rest.slice(atIdx + 1);
    const m = hostAndPath.match(/^([^:/?#]+)(.*)/s);
    if (m) {
      const [, host, remainder] = m;
      for (let i = 0; i < host.length; i++) {
        result.push(fprChar(host[i], bytes[pos + i]));
      }
      result.push(remainder); // :5432/prod kept as-is
    } else {
      result.push(hostAndPath);
    }
  } else {
    // No userinfo: replace host only, keep :port/path
    const m = rest.match(/^([^:/?#]+)(.*)/s);
    if (m) {
      const [, host, remainder] = m;
      for (let i = 0; i < host.length; i++) {
        result.push(fprChar(host[i], bytes[pos + i]));
      }
      result.push(remainder);
    } else {
      result.push(rest);
    }
  }

  return result.join("");
}
