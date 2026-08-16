export function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  return res.status(405).json({ error: "Method not allowed" });
}

export function sendError(res, error) {
  console.error(error);
  const status = Number(error?.status) || 500;
  const message = error instanceof Error ? error.message : String(error);
  return res.status(status).json({ error: message.slice(0, 3000) });
}
