import test from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_ITEM_LIMIT, MINUTE_CREATE_LIMIT, RELAY_TTL_MS,
  expireArtifact, expiresAtFrom, homePresence, safeBlobName,
  signSession, verifySession,
} from "../relay/core.js";

test("owner session is signed, rejects wrong secret, and expires", () => {
  const now = 1_000_000;
  const token = signSession("owner-secret", now, 5_000);
  assert.equal(verifySession(token, "owner-secret", now + 1), true);
  assert.equal(verifySession(token, "wrong-secret", now + 1), false);
  assert.equal(verifySession(token, "owner-secret", now + 5_001), false);
});

test("home presence fails closed after its TTL", () => {
  const lastSeen = 1_000_000;
  assert.equal(homePresence(lastSeen, lastSeen + 24_000).state, "online");
  assert.equal(homePresence(lastSeen, lastSeen + 26_000).state, "offline");
  assert.equal(homePresence(0, lastSeen).state, "offline");
});

test("relay artifact logical TTL defaults to exactly one hour", () => {
  assert.equal(RELAY_TTL_MS, 3_600_000);
  assert.equal(expiresAtFrom(10_000), 3_610_000);
});

test("expiry cleanup deletes and marks only after logical expiry", async () => {
  const calls = [];
  const early = await expireArtifact({
    now: 9_999,
    expiresAt: 10_000,
    deleteBlob: async () => calls.push("delete"),
    markExpired: async () => calls.push("mark"),
  });
  assert.deepEqual(early, { expired: false });
  assert.deepEqual(calls, []);
  const expired = await expireArtifact({
    now: 10_000,
    expiresAt: 10_000,
    deleteBlob: async () => calls.push("delete"),
    markExpired: async () => calls.push("mark"),
  });
  assert.deepEqual(expired, { expired: true });
  assert.deepEqual(calls, ["delete", "mark"]);
});

test("relay blob names cannot preserve separators or traversal", () => {
  const name = safeBlobName("../../evil\\name.mp3");
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("\\"), false);
  assert.equal(name.includes(".."), false);
});

test("rate limit defaults are finite and conservative", () => {
  assert.equal(MINUTE_CREATE_LIMIT, 30);
  assert.equal(DAILY_ITEM_LIMIT, 1000);
  assert.ok(MINUTE_CREATE_LIMIT < DAILY_ITEM_LIMIT);
});
