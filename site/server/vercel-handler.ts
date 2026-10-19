// Bundled into api/pg/_handler.cjs on Vercel. Kept out of api/ so the
// unbundled TypeScript is not shipped as a broken ESM function.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "./frame-api.js";

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleRequest(req, res);
}
