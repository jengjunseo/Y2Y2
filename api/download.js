import { getBackend, queryValue, readBackendJson } from "../lib/sandbox.js";
import { methodNotAllowed, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    const id = queryValue(req.query.id);
    if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return res.status(400).json({ error: "Invalid job id" });
    const job = await readBackendJson(`/jobs/${id}`);
    if (job.status !== "ready") return res.status(409).json({ error: "File is not ready" });

    const backend = await getBackend();
    const rawPrefix = queryValue(req.query.prefix) || "";
    const prefix = /^\d{2,3} - $/.test(rawPrefix) ? rawPrefix : "";
    const target = new URL(`/download/${id}`, backend.baseUrl);
    target.searchParams.set("token", backend.downloadToken);
    if (prefix) target.searchParams.set("prefix", prefix);
    res.setHeader("Cache-Control", "private, no-store");
    return res.redirect(307, target.toString());
  } catch (error) {
    return sendError(res, error);
  }
}
