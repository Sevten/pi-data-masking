import assert from "node:assert/strict";
import test from "node:test";

import { diffText } from "../diff-text.ts";

test("text diff keeps replacement spans separate without injecting punctuation", () => {
  assert.deepEqual(
    diffText("token=secret; keep=this", "token=[MASKED]; keep=this"),
    [
      { original: "token=", masked: "token=", changed: false },
      { original: "secret", masked: "[MASKED]", changed: true },
      { original: "; keep=this", masked: "; keep=this", changed: false },
    ],
  );
});

test("text diff does not split a replacement at its shared word suffix", () => {
  assert.deepEqual(
    diffText("mysecret", "maskedsecret"),
    [{ original: "mysecret", masked: "maskedsecret", changed: true }],
  );
});

test("text diff advances after rewinding a shared prefix to the word start", () => {
  assert.deepEqual(
    diffText("abcdefX", "abcdefY"),
    [{ original: "abcdefX", masked: "abcdefY", changed: true }],
  );
  assert.deepEqual(
    diffText("value=abcdefX; keep=this", "value=abcdefY; keep=this"),
    [
      { original: "value=", masked: "value=", changed: false },
      { original: "abcdefX", masked: "abcdefY", changed: true },
      { original: "; keep=this", masked: "; keep=this", changed: false },
    ],
  );
});

test("text diff excludes short shared closing delimiters from a replacement", () => {
  assert.deepEqual(
    diffText("`wsl90.top`", "`test.xyz`"),
    [
      { original: "`", masked: "`", changed: false },
      { original: "wsl90.top", masked: "test.xyz", changed: true },
      { original: "`", masked: "`", changed: false },
    ],
  );
  assert.deepEqual(
    diffText("mysecret`", "maskedsecret`"),
    [
      { original: "mysecret", masked: "maskedsecret", changed: true },
      { original: "`", masked: "`", changed: false },
    ],
  );
});

test("text diff caps work on oversized input instead of scanning forever", () => {
  const filler = "说明 ".repeat(6000);
  const segments = diffText(`前缀 ${filler}A`, `前缀 ${filler}B`);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.changed, true);
});

test("repeated values stay locally anchored when the document also contains the bare value", () => {
  // Regression: anchor discovery used a 6-char fragment matched anywhere in
  // the other string. In a server inventory where every row contains
  // `*.netbird.internal` (replaced) but the prose also mentions a bare
  // `netbird status` command (unreplaced), the fragment "netbir" taken from
  // inside the replaced value matched that far-away command, and the changed
  // span swallowed everything between — the viewer highlighted from
  // ".internal" to the end of the block.
  const rows = [
    "| `homelab` | 主服务器 | NetBird | `agent` | `homelab.netbird.internal` |",
    "| `opnsense-agent` | OPNsense 防火墙/路由器 | NetBird | `agent` | `os.netbird.internal` |",
    "| `switch-lan-agent` | 网络交换机 | 局域网 | `wlx102` | `192.168.10.11` |",
    "| `ap1-lan-agent` | 无线 AP | 局域网 | `root` | `192.168.10.21` |",
    "| `ap2-lan-agent` | 无线 AP | 局域网 | `root` | `192.168.10.22` |",
  ];
  const prose = [
    "连接前可用 `ssh <名称> 'netbird status'` 确认隧道已建立。",
    "这是配置层面的判断；需要确认实时连通性时执行该命令。",
  ];
  const original = [...rows.slice(0, 2), prose[0], rows.slice(2).join("\n"), prose[1]].join("\n");
  const masked = original.replaceAll("netbird.internal", "homenet.internal");

  const segments = diffText(original, masked);
  const changed = segments.filter((segment) => segment.changed);
  // Exactly one small span per replaced occurrence — no runaway span.
  assert.equal(changed.length, 2);
  for (const segment of changed) {
    assert.deepEqual(
      { original: segment.original, masked: segment.masked },
      { original: "netbird", masked: "homenet" },
    );
  }
  assert.ok(changed.every((segment) => segment.original.length < 20));
});
