/**
 * tests/git-remote.test.ts
 * Git-remote and gh destination resolution (plan §B1/§B2): invocation
 * parsing, URL classification, .git/config lookup, and the tri-state
 * resolution contract (host / local / unknown).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRemoteUrl,
  ghDestinationHost,
  parseGitInvocation,
  remoteUrlFromConfig,
  resolveGitRemote,
} from "../src/core/git-remote.ts";

// ── Invocation parsing ───────────────────────────────────────────────

test("remote-contacting subcommands are found", () => {
  assert.deepEqual(parseGitInvocation("git push origin main"), { sub: "push", remote: "origin", dir: undefined });
  assert.deepEqual(parseGitInvocation("git -C /repo push -u origin main"), { sub: "push", remote: "origin", dir: "/repo" });
  assert.deepEqual(parseGitInvocation("sudo git fetch"), { sub: "fetch", remote: undefined, dir: undefined });
  assert.equal(parseGitInvocation("git status"), undefined);
  assert.equal(parseGitInvocation("git log --oneline"), undefined);
});

// ── URL classification ───────────────────────────────────────────────

test("scheme remotes resolve to hosts", () => {
  assert.deepEqual(classifyRemoteUrl("https://github.com/acme/app.git"), { kind: "host", host: "github.com" });
  assert.deepEqual(classifyRemoteUrl("ssh://git@yor-agent/home/agent/projects/x.git"), { kind: "host", host: "yor-agent" });
  assert.deepEqual(classifyRemoteUrl("git://git.server.internal/repo"), { kind: "host", host: "git.server.internal" });
  assert.deepEqual(classifyRemoteUrl("file:///srv/bare.git"), { kind: "local" });
});

test("scp-style remotes resolve to hosts; drive letters do not", () => {
  assert.deepEqual(classifyRemoteUrl("git@github.com:acme/app.git"), { kind: "host", host: "github.com" });
  assert.deepEqual(classifyRemoteUrl("yor-agent:/home/agent/projects/x.git"), { kind: "host", host: "yor-agent" });
  assert.equal(classifyRemoteUrl("C:/repos/x.git").kind, "unknown");
});

test("path remotes are local", () => {
  assert.deepEqual(classifyRemoteUrl("/srv/git/x.git"), { kind: "local" });
  assert.deepEqual(classifyRemoteUrl("../bare.git"), { kind: "local" });
  assert.deepEqual(classifyRemoteUrl("~/repos/x.git"), { kind: "local" });
});

// ── Config lookup + tri-state resolution ─────────────────────────────

const CONFIG = [
  '[core]',
  "\trepositoryformatversion = 0",
  '[remote "origin"]',
  "\turl = git@github.com:acme/app.git",
  "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  '[branch "main"]',
  "\tremote = origin",
].join("\n");

const INTRANET_CONFIG = [
  '[remote "origin"]',
  "\turl = yor-agent:/home/agent/projects/app.git",
].join("\n");

const readerFor = (text: string | null) => (path: string) =>
  path.endsWith(".git/config") ? text : null;

test("remote name resolves through .git/config", () => {
  assert.deepEqual(resolveGitRemote("git push origin main", "/repo", readerFor(CONFIG)), {
    kind: "host",
    host: "github.com",
  });
  assert.deepEqual(resolveGitRemote("git push", "/repo", readerFor(INTRANET_CONFIG)), {
    kind: "host",
    host: "yor-agent",
  });
});

test("bare-repo remote resolves to local (signature cleared upstream)", () => {
  const cfg = '[remote "origin"]\n\turl = /srv/git/app.git\n';
  assert.deepEqual(resolveGitRemote("git push origin", "/repo", readerFor(cfg)), { kind: "local" });
});

test("unresolvable remotes stay unknown (detection-gap cell)", () => {
  assert.deepEqual(resolveGitRemote("git push evilremote main", "/repo", readerFor(CONFIG)), { kind: "unknown" });
  assert.deepEqual(resolveGitRemote("git push origin main", "/repo", readerFor(null)), { kind: "unknown" });
  assert.deepEqual(resolveGitRemote("git status", "/repo", readerFor(CONFIG)), { kind: "unknown" });
});

test("URL-shaped remote tokens classify without the config", () => {
  assert.deepEqual(resolveGitRemote("git push https://evil.example/x.git main", "/repo", readerFor(null)), {
    kind: "host",
    host: "evil.example",
  });
});

test("remoteUrlFromConfig ignores other sections", () => {
  assert.equal(remoteUrlFromConfig(CONFIG, "upstream"), undefined);
  assert.equal(remoteUrlFromConfig(CONFIG, "origin"), "git@github.com:acme/app.git");
});

// ── gh host resolution ───────────────────────────────────────────────

test("gh defaults to github.com; --hostname and GH_HOST override", () => {
  assert.equal(ghDestinationHost("gh api repos/x/y", {}), "github.com");
  assert.equal(ghDestinationHost("gh api --hostname ghe.corp.acme.com repos/x", {}), "ghe.corp.acme.com");
  assert.equal(ghDestinationHost("gh repo clone x", { GH_HOST: "ghe.corp.acme.com" }), "ghe.corp.acme.com");
  assert.equal(ghDestinationHost("git push origin main", {}), undefined);
});
