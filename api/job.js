import { queryValue, readBackendJson } from "../lib/sandbox.js";
import { methodNotAllowed, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    const id = queryValue(req.query.id);
    if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return res.status(400).json({ error: "Invalid job id" });
    const data = await readBackendJson(`/jobs/${id}`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ...data, downloadUrl: data.status === "ready" ? `/api/download/${data.id}` : null });
  } catch (error) {
    return sendError(res, error);
  }
}
