import { test } from "node:test";
import assert from "node:assert/strict";
import { Masker } from "../masker.ts";

// A regex rule shaped like a key matched inside a screenshot's base64: the placeholder corrupted the image, and the
// provider rejected every later request that carried it. Image data is never masked; the same text still is.
const rule = { id: "b64-key", name: "32-byte base64 key", enabled: true, type: "regex" as const, pattern: "[A-Za-z0-9+/]{43}=" };
const key = "Q".repeat(20) + "abcdefghijklmnopqrstuvw" + "=";
const imageData = "iVBORw0KGgoAAAANSUhEUgAA" + key + "AAAAElFTkSuQmCC";

test("image data passes through unmasked; the same shape in text is still masked", () => {
  const masker = new Masker([rule], Buffer.alloc(32, 7));
  const message = { role: "user", content: [{ type: "text", text: "key " + key }, { type: "image", data: imageData, mimeType: "image/png" }] };
  const masked = masker.maskValue(message).value as any;
  assert.equal(masked.content[1].data, imageData);
  assert.ok(!masked.content[0].text.includes(key), "text keys are still masked");
  const toolResult = { role: "toolResult", content: [{ type: "image", data: imageData, mimeType: "image/png" }] };
  assert.equal((masker.maskValue(toolResult).value as any).content[0].data, imageData);
  assert.equal((masker.unmaskValue(toolResult).value as any).content[0].data, imageData);
});

test("provider-shaped images in the final request are left alone too", () => {
  const masker = new Masker([rule], Buffer.alloc(32, 7));
  const anthropic = { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }] };
  assert.equal((masker.maskValue(anthropic).value as any).content[0].source.data, imageData);
  const url = "data:image/png;base64," + imageData;
  const openai = { role: "user", content: [{ type: "image_url", image_url: { url } }] };
  assert.equal((masker.maskValue(openai).value as any).content[0].image_url.url, url);
});
