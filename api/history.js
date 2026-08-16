import { readBackendJson } from "../lib/sandbox.js";
import { methodNotAllowed, sendError } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    const data = await readBackendJson("/history");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (error) {
    return sendError(res, error);
  }
}
