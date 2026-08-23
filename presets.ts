/**
 * Built-in, versioned masking presets. Config files reference these by name;
 * the loader expands each reference into an ordinary runtime regex rule.
 */

import type { PreserveStructure, RegexMaskingRule } from "./masker.ts";

export interface MaskingPreset {
  name: string;
  label: string;
  description: string;
  example: string;
  pattern: string;
  flags?: string;
  preserveStructure?: PreserveStructure;
}

export const MASKING_PRESETS: readonly MaskingPreset[] = [
  {
    name: "github-pat",
    label: "GitHub personal access token",
    description: "GitHub personal access tokens (classic and fine-grained)",
    example: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    pattern: "\\bghp_[A-Za-z0-9]{36}\\b|\\bgithub_pat_[A-Za-z0-9_]{22,}\\b",
  },
  {
    name: "npm-token",
    label: "npm access token",
    description: "npm access tokens beginning with npm_",
    example: "npm_1234567890abcdefghijklmnopqrstuvwxyz",
    pattern: "\\bnpm_[A-Za-z0-9]{36}\\b",
  },
  {
    name: "huggingface-token",
    label: "Hugging Face access token",
    description: "Hugging Face access tokens beginning with hf_",
    example: "hf_1234567890abcdefghijklmnopqrstuvwx",
    pattern: "\\bhf_[A-Za-z0-9]{34,}\\b",
  },
  {
    name: "aws-access-key-id",
    label: "AWS access key ID",
    description: "AWS access key IDs beginning with AKIA",
    example: "AKIAIOSFODNN7EXAMPLE",
    pattern: "\\bAKIA[0-9A-Z]{16}\\b",
  },
  {
    name: "slack-token",
    label: "Slack token",
    description: "Slack bot, user, app, refresh, and legacy tokens",
    example: "xoxb-1234567890-abcdefghijkl",
    pattern: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b",
  },
  {
    name: "jwt",
    label: "JSON Web Token",
    description: "JSON Web Tokens with three base64url segments",
    example: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureABC",
    pattern: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
  },
  {
    name: "pem-private-key",
    label: "PEM private key",
    description: "PEM private-key body while preserving BEGIN/END markers",
    example: "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----",
    pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----([\\s\\S]*?)-----END [A-Z ]*PRIVATE KEY-----",
  },
  {
    name: "bearer-token",
    label: "Bearer token",
    description: "Bearer token value while preserving the authorization prefix",
    example: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo-token",
    pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)",
    flags: "i",
  },
  {
    name: "database-userinfo",
    label: "Database connection credentials",
    description: "Credentials in common database and message-queue connection strings",
    example: "postgresql://admin:secret@db.example/app",
    pattern: "(?:postgresql|mysql|mariadb|redis|mongodb(?:\\+srv)?|amqp|amqps):\\/\\/([^\\s]+)@",
  },
  {
    name: "private-ipv4",
    label: "Private IPv4 address",
    description: "RFC 1918 private IPv4 addresses",
    example: "192.168.10.25",
    pattern: "\\b(?:10\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)|172\\.(?:1[6-9]|2\\d|3[01])\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)|192\\.168\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d))\\b",
    preserveStructure: { keepIPv4Octets: 2 },
  },
];

const PRESET_BY_NAME = new Map(MASKING_PRESETS.map((preset) => [preset.name, preset]));

export function getMaskingPreset(name: string): MaskingPreset | undefined {
  return PRESET_BY_NAME.get(name);
}

export function expandMaskingPreset(
  preset: MaskingPreset,
  overrides: {
    id: string;
    name?: string;
    enabled?: boolean;
    description?: string;
    lowEntropy?: boolean;
    preserveStructure?: PreserveStructure;
  },
): RegexMaskingRule {
  return {
    id: overrides.id,
    name: overrides.name,
    type: "regex",
    enabled: overrides.enabled,
    description: overrides.description ?? `${preset.description} · Example: ${preset.example}`,
    pattern: preset.pattern,
    flags: preset.flags,
    lowEntropy: overrides.lowEntropy,
    preserveStructure: overrides.preserveStructure ?? (
      preset.preserveStructure ? { ...preset.preserveStructure } : undefined
    ),
  };
}
