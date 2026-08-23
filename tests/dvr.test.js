import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Local Web DVR exposes the consent, crop and recorder pipeline", async () => {
  const [html, script] = await Promise.all([
    read("public/dvr/index.html"),
    read("public/dvr/dvr.js"),
  ]);

  assert.match(html, /id="capture-target"/);
  assert.match(html, /현재 탭/);
  assert.match(html, /권리·정책 경계/);
  assert.match(script, /getDisplayMedia/);
  assert.match(script, /RestrictionTarget\.fromElement/);
  assert.match(script, /CropTarget\.fromElement/);
  assert.match(script, /new MediaRecorder/);
  assert.match(script, /showSaveFilePicker/);
  assert.match(script, /settings\.displaySurface !== "browser"/);
});

test("DVR deployment permits self display capture and sends iframe referrer identity", async () => {
  const config = JSON.parse(await read("vercel.json"));
  const globalHeaders = config.headers.find((rule) => rule.source === "/(.*)")?.headers || [];
  const dvrHeaders = config.headers.find((rule) => rule.source === "/dvr/(.*)")?.headers || [];

  assert.ok(globalHeaders.some((header) => header.key === "Permissions-Policy" && header.value.includes("display-capture=(self)")));
  assert.ok(dvrHeaders.some((header) => header.key === "Referrer-Policy" && header.value === "strict-origin-when-cross-origin"));
});

