// Vercel serverless entry for the playground API: every /api/pg/* request lands here and is
// handled by the same code the Vite dev server mounts. Addresses come from the project's
// environment variables (see README, "Deploying the playground"); there is no key.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../../site/server/frame-api";

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleRequest(req, res);
}
