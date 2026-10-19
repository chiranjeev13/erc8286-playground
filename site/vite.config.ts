import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { frameApi } from "./server/frame-api";

// The playground's transactions are built, signed and sent by a dev/preview-server route, so the
// throwaway testnet key never reaches the browser.
export default defineConfig({
  plugins: [react(), tailwindcss(), frameApi()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
