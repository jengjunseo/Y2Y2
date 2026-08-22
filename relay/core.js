import crypto from "node:crypto";

export const RELAY_TTL_MS = 60 * 60 * 1000;
export const PRESENCE_TTL_SECONDS = 50;
export const MINUTE_CREATE_LIMIT = 30;
export const DAILY_ITEM_LIMIT = 1000;

export function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function signSession(ownerSecret, now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = b64url(JSON.stringify({ v: 1, exp: now + maxAgeMs }));
  const sig = crypto.createHmac("sha256", ownerSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token, ownerSecret, now = Date.now()) {
  if (!token || !ownerSecret) return false;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", ownerSecret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(sig, "base64url"); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data?.v === 1 && Number(data.exp) > now;
  } catch {
    return false;
  }
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function safeBlobName(value, fallback = "media.bin") {
  const raw = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const finalName = (raw || fallback).slice(0, 180);
  return finalName || fallback;
}

export function expiresAtFrom(uploadedAt, ttlMs = RELAY_TTL_MS) {
  return Number(uploadedAt) + Number(ttlMs);
}

export function isExpired(expiresAt, now = Date.now()) {
  return !Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now;
}

export async function expireArtifact({ now = Date.now(), expiresAt, deleteBlob, markExpired }) {
  if (!isExpired(expiresAt, now)) return { expired: false };
  await deleteBlob();
  await markExpired();
  return { expired: true };
}

export function publicStatus(status) {
  if (status === "done") return "ready";
  if (status === "expired") return "expired";
  if (["queued", "claimed", "processing", "failed", "canceled"].includes(status)) return status;
  return "failed";
}

export function homePresence(lastSeenMs, now = Date.now(), ttlSeconds = PRESENCE_TTL_SECONDS) {
  const seen = Number(lastSeenMs || 0);
  if (!seen) return { state: "offline", lastSeen: null };
  const age = now - seen;
  return age <= ttlSeconds * 1000
    ? { state: "online", lastSeen: seen }
    : { state: "offline", lastSeen: seen };
}

export const RATE_LIMIT_LUA = `
local minute = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
local reqCost = tonumber(ARGV[1])
local itemCost = tonumber(ARGV[2])
local minuteLimit = tonumber(ARGV[3])
local dailyLimit = tonumber(ARGV[4])
if minute + reqCost > minuteLimit then return {0, minute, daily, 1} end
if daily + itemCost > dailyLimit then return {0, minute, daily, 2} end
minute = redis.call('INCRBY', KEYS[1], reqCost)
daily = redis.call('INCRBY', KEYS[2], itemCost)
redis.call('EXPIRE', KEYS[1], 120)
redis.call('EXPIRE', KEYS[2], 172800)
return {1, minute, daily, 0}
`;

export const ENQUEUE_LUA = `
redis.call('HSET', KEYS[1],
  'id', ARGV[1],
  'deviceId', ARGV[2],
  'kind', ARGV[3],
  'status', 'queued',
  'payload', ARGV[4],
  'createdAt', ARGV[5],
  'updatedAt', ARGV[5],
  'attempt', '0')
redis.call('EXPIRE', KEYS[1], 86400)
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
return 1
`;

export const CLAIM_LUA = `
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local deviceId = ARGV[3]
local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, id in ipairs(stale) do
  local jk = ARGV[4] .. id
  local status = redis.call('HGET', jk, 'status')
  local claimedBy = redis.call('HGET', jk, 'claimedBy')
  if claimedBy == deviceId and (status == 'claimed' or status == 'processing') then
    redis.call('HSET', jk, 'status', 'queued', 'updatedAt', now)
    redis.call('RPUSH', KEYS[1], id)
  end
  redis.call('ZREM', KEYS[2], id)
end
for i=1,20 do
  local id = redis.call('LPOP', KEYS[1])
  if not id then return nil end
  local jk = ARGV[4] .. id
  local status = redis.call('HGET', jk, 'status')
  if status == 'queued' then
    local untilAt = now + lease
    redis.call('HSET', jk, 'status', 'claimed', 'claimedBy', deviceId, 'leaseUntil', untilAt, 'updatedAt', now)
    redis.call('ZADD', KEYS[2], untilAt, id)
    return id
  end
end
return nil
`;
