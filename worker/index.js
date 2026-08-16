import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint } from "cloudflare:workers";

const OUTPUT_CONTRACT_VERSION = "v1";
const SHARD_COUNT = 4;
const MP3_QUALITIES = new Set([128, 192, 256, 320]);
const MP4_QUALITIES = new Set([360, 720, 1080, 1440, 2160]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export class MediaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
}

export class MediaWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const job = event.payload;

    await step.do("mark-processing", async () => {
      await updateJob(this.env.DB, job.id, {
        status: "processing",
        stage: "processing",
        error: null,
      });
    });

    try {
      const result = await step.do(
        "process-and-store",
        {
          retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
          timeout: "30 minutes",
        },
        async () => {
          const existing = await this.env.ARTIFACTS.head(job.objectKey);
          if (existing) {
            return {
              filename: existing.customMetadata?.filename || fallbackFilename(job),
              contentType:
                existing.httpMetadata?.contentType ||
                (job.mediaType === "mp3" ? "audio/mpeg" : "video/mp4"),
              sizeBytes: existing.size,
              reused: true,
            };
          }

          const container = getMediaContainer(this.env, job.cacheKey);
          const response = await container.fetch(
            new Request("http://container/process", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: job.url,
                title: job.title,
                mediaType: job.mediaType,
                quality: job.quality,
              }),
            }),
          );

          if (!response.ok || !response.body) {
            const detail = await safeResponseText(response);
            throw new Error(detail || `container returned ${response.status}`);
          }

          const encodedFilename = response.headers.get("x-y2y2-filename");
          const filename = sanitizeFilename(
            encodedFilename ? safeDecodeURIComponent(encodedFilename) : fallbackFilename(job),
          );
          const contentType =
            response.headers.get("content-type") ||
            (job.mediaType === "mp3" ? "audio/mpeg" : "video/mp4");
          const sizeBytes = Number(response.headers.get("x-y2y2-size") || 0) || null;

          await this.env.ARTIFACTS.put(job.objectKey, response.body, {
            httpMetadata: {
              contentType,
              contentDisposition: contentDisposition(filename),
            },
            customMetadata: {
              filename,
              title: job.title.slice(0, 512),
              cacheKey: job.cacheKey,
            },
          });

          return { filename, contentType, sizeBytes, reused: false };
        },
      );

      await step.do("commit-ready", async () => {
        const now = new Date().toISOString();
        await this.env.DB.prepare(
          `INSERT INTO artifacts
            (cache_key, object_key, filename, content_type, size_bytes, title, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             object_key = excluded.object_key,
             filename = excluded.filename,
             content_type = excluded.content_type,
             size_bytes = excluded.size_bytes,
             title = excluded.title`,
        )
          .bind(
            job.cacheKey,
            job.objectKey,
            result.filename,
            result.contentType,
            result.sizeBytes,
            job.title,
            now,
          )
          .run();

        await updateJob(this.env.DB, job.id, {
          status: "ready",
          stage: result.reused ? "reused" : "ready",
          object_key: job.objectKey,
          filename: result.filename,
          content_type: result.contentType,
          size_bytes: result.sizeBytes,
          error: null,
        });
      });

      return result;
    } catch (error) {
      const message = normalizeError(error);
      await step.do("mark-failed", async () => {
        await updateJob(this.env.DB, job.id, {
          status: "failed",
          stage: "failed",
          error: message,
        });
      });
      throw error;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "y2y2", now: new Date().toISOString() });
      }

      if (url.pathname === "/api/inspect" && request.method === "POST") {
        const body = await readJson(request);
        const sourceUrl = validateYoutubeUrl(body.url);
        const container = getMediaContainer(env, sourceUrl);
        const response = await container.fetch(
          new Request("http://container/inspect", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: sourceUrl }),
          }),
        );
        if (!response.ok) {
          return json(
            { error: await safeResponseText(response) || "Unable to inspect this video" },
            response.status,
          );
        }
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/jobs" && request.method === "POST") {
        const body = await readJson(request);
        const job = await createJob(env, body);
        return json(job, job.reusedArtifact ? 200 : 202);
      }

      if (url.pathname === "/api/history" && request.method === "GET") {
        const result = await env.DB.prepare(
          `SELECT id, video_id, title, media_type, quality, status, stage,
                  filename, size_bytes, error, created_at, updated_at
             FROM jobs
            ORDER BY created_at DESC
            LIMIT 100`,
        ).all();
        return json({ items: result.results || [] });
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)$/);
      if (jobMatch && request.method === "GET") {
        const row = await getJob(env.DB, jobMatch[1]);
        if (!row) return json({ error: "Job not found" }, 404);
        return json(publicJob(row));
      }

      const downloadMatch = url.pathname.match(/^\/api\/download\/([A-Za-z0-9-]+)$/);
      if (downloadMatch && request.method === "GET") {
        return downloadJob(env, request, downloadMatch[1]);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      const status = error instanceof ClientError ? error.status : 500;
      return json({ error: normalizeError(error) }, status);
    }
  },
};

async function createJob(env, body) {
  const url = validateYoutubeUrl(body.url);
  const videoId = requireString(body.videoId, "videoId", 128);
  const title = requireString(body.title, "title", 512);
  const mediaType = body.mediaType;
  const quality = Number(body.quality);

  if (mediaType === "mp3" && !MP3_QUALITIES.has(quality)) {
    throw new ClientError("Unsupported MP3 bitrate");
  }
  if (mediaType === "mp4" && !MP4_QUALITIES.has(quality)) {
    throw new ClientError("Unsupported MP4 quality");
  }
  if (!["mp3", "mp4"].includes(mediaType)) {
    throw new ClientError("mediaType must be mp3 or mp4");
  }

  const cacheKey = await sha256Hex(
    `${videoId}|${mediaType}|${quality}|${OUTPUT_CONTRACT_VERSION}`,
  );
  const extension = mediaType;
  const objectKey = `artifacts/${cacheKey}.${extension}`;
  const now = new Date().toISOString();

  const object = await env.ARTIFACTS.head(objectKey);
  if (object) {
    const id = crypto.randomUUID();
    const filename = object.customMetadata?.filename || `${sanitizeFilename(title)}.${extension}`;
    const contentType =
      object.httpMetadata?.contentType ||
      (mediaType === "mp3" ? "audio/mpeg" : "video/mp4");

    await env.DB.prepare(
      `INSERT INTO jobs
        (id, cache_key, source_url, video_id, title, media_type, quality, status,
         stage, object_key, filename, content_type, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'reused', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        cacheKey,
        url,
        videoId,
        title,
        mediaType,
        quality,
        objectKey,
        filename,
        contentType,
        object.size,
        now,
        now,
      )
      .run();

    return { ...publicJob(await getJob(env.DB, id)), reusedArtifact: true };
  }

  const active = await env.DB.prepare(
    `SELECT * FROM jobs
      WHERE cache_key = ? AND status IN ('queued', 'processing')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(cacheKey)
    .first();
  if (active) return { ...publicJob(active), joinedExistingJob: true };

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, cache_key, source_url, video_id, title, media_type, quality, status,
         stage, object_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)`,
    )
      .bind(id, cacheKey, url, videoId, title, mediaType, quality, objectKey, now, now)
      .run();
  } catch (error) {
    const concurrent = await env.DB.prepare(
      `SELECT * FROM jobs
        WHERE cache_key = ? AND status IN ('queued', 'processing')
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(cacheKey)
      .first();
    if (concurrent) return { ...publicJob(concurrent), joinedExistingJob: true };
    throw error;
  }

  try {
    await env.MEDIA_WORKFLOW.create({
      id,
      params: { id, cacheKey, objectKey, url, videoId, title, mediaType, quality },
      retention: { successRetention: "1 day", errorRetention: "7 days" },
    });
  } catch (error) {
    await updateJob(env.DB, id, {
      status: "failed",
      stage: "workflow-start-failed",
      error: normalizeError(error),
    });
    throw error;
  }

  return publicJob(await getJob(env.DB, id));
}

async function downloadJob(env, request, id) {
  const row = await getJob(env.DB, id);
  if (!row) return json({ error: "Job not found" }, 404);
  if (row.status !== "ready" || !row.object_key) {
    return json({ error: "File is not ready" }, 409);
  }

  const object = await env.ARTIFACTS.get(row.object_key);
  if (!object) {
    await updateJob(env.DB, id, {
      status: "failed",
      stage: "artifact-expired",
      error: "The temporary file expired. Prepare it again.",
    });
    return json({ error: "Temporary file expired" }, 410);
  }

  const requestUrl = new URL(request.url);
  const requestedPrefix = requestUrl.searchParams.get("prefix") || "";
  const prefix = /^\d{2,3} - $/.test(requestedPrefix) ? requestedPrefix : "";
  const filename = sanitizeFilename(`${prefix}${row.filename || fallbackFilename(row)}`);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set(
    "Content-Type",
    row.content_type || (row.media_type === "mp3" ? "audio/mpeg" : "video/mp4"),
  );
  headers.set("Content-Disposition", contentDisposition(filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

function getMediaContainer(env, seed) {
  return getContainer(env.MEDIA_CONTAINER, `media-${shard(seed)}`);
}

function shard(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % SHARD_COUNT;
}

async function getJob(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1").bind(id).first();
}

async function updateJob(db, id, patch) {
  const allowed = [
    "status",
    "stage",
    "object_key",
    "filename",
    "content_type",
    "size_bytes",
    "error",
  ];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = ?`);
  const values = entries.map(([, value]) => value ?? null);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  await db
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

function publicJob(row) {
  return {
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    mediaType: row.media_type,
    quality: row.quality,
    status: row.status,
    stage: row.stage,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: row.status === "ready" ? `/api/download/${row.id}` : null,
  };
}

function validateYoutubeUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) {
    throw new ClientError("Invalid URL");
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ClientError("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ClientError("Only standard YouTube URLs are supported");
  }
  return parsed.toString();
}

function requireString(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ClientError(`Invalid ${name}`);
  }
  return value.trim();
}

function sanitizeFilename(value) {
  return String(value || "media")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180) || "media";
}

function fallbackFilename(job) {
  return `${sanitizeFilename(job.title)}.${job.mediaType}`;
}

function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new ClientError("Expected JSON body");
  const text = await request.text();
  if (text.length > 64 * 1024) throw new ClientError("Request body too large", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError("Invalid JSON body");
  }
}

async function safeResponseText(response) {
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return data.error || text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function normalizeError(error) {
  if (error instanceof Error) return error.message.slice(0, 3000);
  return String(error).slice(0, 3000);
}

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
