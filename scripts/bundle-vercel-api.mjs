import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(root, "site/package.json"))("esbuild");
const outfile = join(root, "api/pg/_handler.cjs");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ["site/server/vercel-handler.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  nodePaths: [join(root, "node_modules")],
  logLevel: "info",
});
