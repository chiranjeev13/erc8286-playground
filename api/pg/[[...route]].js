// Vercel serverless entry for every /api/pg/* request. Committed so Vercel finds the function
// before the build runs; the handler itself is bundled into ./_handler.cjs by
// scripts/bundle-vercel-api.mjs from site/server/vercel-handler.ts.
import bundle from "./_handler.cjs";

export default bundle.default;
