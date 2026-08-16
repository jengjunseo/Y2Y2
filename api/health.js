import { methodNotAllowed } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true, service: "y2y2", backend: "vercel-sandbox", lazy: true });
}
