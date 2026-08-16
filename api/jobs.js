import { readBackendJson } from "../lib/sandbox.js";
import { methodNotAllowed, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const data = await readBackendJson("/jobs", { method: "POST", body });
    res.setHeader("Cache-Control", "no-store");
    return res.status(202).json({ ...data, downloadUrl: data.status === "ready" ? `/api/download/${data.id}` : null });
  } catch (error) {
    return sendError(res, error);
  }
}
