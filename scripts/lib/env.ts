import { readFileSync } from "node:fs";

export type Env = Record<string, string>;

/** Reads a KEY=value file (.env.devnet) without pulling in a dotenv dependency. */
export function config(path = ".env.devnet"): Env {
  const env: Env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    env[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return env;
}
