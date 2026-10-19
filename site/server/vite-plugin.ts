import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handle } from "./frame-api.js";

export function frameApi(): Plugin {
  type Mw = { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
  const mount = (mw: Mw) => {
    mw.use((req, res, next) => void handle(req, res, next));
  };
  return {
    name: "erc8286-playground-api",
    // Block bodies on purpose: a function returned from these hooks is run as a post-hook.
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
