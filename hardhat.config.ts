import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { HardhatUserConfig } from "hardhat/config";
import type { HardhatPlugin } from "hardhat/types/plugins";
import type { Compiler, CompilerInput, CompilerOutput } from "hardhat/types/solidity";
import { envFileFor, config as loadEnv } from "./scripts/lib/env.js";

// The reference contracts emit EIP-8141 instructions, which no released solc knows.
// They are compiled with a fork:
//   https://github.com/chiranjeev13/solidity/releases/tag/v0.8.36-eip8141.1
// Point SOLC at it if it is not simply `solc` on PATH.
const SOLC = process.env.SOLC ?? "solc";
const EVM_VERSION = "osaka+eip8141";

function runSolc(input: CompilerInput): Promise<CompilerOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(SOLC, ["--standard-json"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e: Error) =>
      reject(new Error(`could not run '${SOLC}': ${e.message}. See hardhat.config.ts.`)),
    );
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`${SOLC} exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as CompilerOutput);
      } catch {
        reject(new Error(`${SOLC} produced non-JSON output: ${out.slice(0, 400)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// Hardhat validates `solidity.settings.evmVersion` against the EVM versions it knows, and
// "osaka+eip8141" is not one of them. Injecting it here -- into the standard-JSON input, on
// the way to the compiler -- keeps the suffix out of the config while still recording it in
// the build info, so an artifact always says which EVM it was built for.
const eip8141Compiler: Compiler = {
  version: "0.8.36",
  longVersion: "0.8.36-develop-eip8141.1",
  compilerPath: SOLC,
  isSolcJs: false,
  async compile(input: CompilerInput): Promise<CompilerOutput> {
    // Mutated in place, not copied: Hardhat keeps a reference to this input for the build
    // info, so mutating is what makes an artifact record the EVM it was actually built for.
    input.settings = { ...input.settings, evmVersion: EVM_VERSION };
    return runSolc(input);
  },
};

/**
 * Replaces the compiler Hardhat would download with the local fork. `downloadCompilers`
 * becomes a no-op because there is nothing to fetch: version 0.8.36-develop is not on
 * solc-bin, it is a local build.
 *
 * `getCompiler` is marked deprecated upstream ("will soon be removed"), and it is currently
 * the only seam for supplying a custom compiler binary. If a future Hardhat drops it, this
 * plugin is what needs rewriting.
 */
const eip8141SolcPlugin: HardhatPlugin = {
  id: "eip8141-solc",
  hookHandlers: {
    solidity: async () => ({
      default: async () => ({
        downloadCompilers: async () => {},
        getCompiler: async () => eip8141Compiler,
      }),
    }),
  },
};

/** Each devnet keeps its key, RPC, and deployed addresses in its own file. */
function devnetEnv(network: string) {
  const path = envFileFor(network);
  return existsSync(path) ? loadEnv(path) : {};
}
const keys = (env: Record<string, string>) =>
  env.DEVNET_PRIVATE_KEY === undefined ? [] : [env.DEVNET_PRIVATE_KEY];
const hegotaEnv = devnetEnv("hegota");
const bogotaEnv = devnetEnv("bogota");
const testnetEnv = devnetEnv("hegota-testnet");

const config: HardhatUserConfig = {
  plugins: [eip8141SolcPlugin],
  paths: { sources: "src" },
  solidity: {
    compilers: [{ version: "0.8.36", settings: { optimizer: { enabled: true, runs: 200 } } }],
    // The vendored SPHINCS verifier is one large assembly block and only fits the stack
    // through the IR pipeline. It uses no EIP-8141 opcode, so it is the one file built this
    // way; nothing else imports it.
    overrides: {
      "src/pq/SphincsVerifier.sol": { version: "0.8.36", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
    },
  },
  networks: {
    hegota: {
      type: "http",
      chainType: "l1",
      url: hegotaEnv.DEVNET_RPC ?? "https://rpc1.hegota.ethrex.xyz",
      chainId: 3151908,
      accounts: keys(hegotaEnv),
    },
    // ethpandaops' EIP-8141 + EIP-8250 devnet (geth / reth / ethrex). The public RPC is an
    // eRPC proxy that drops non-standard methods, so ethrex_simulateFrameTransaction is
    // unavailable through it.
    bogota: {
      type: "http",
      chainType: "l1",
      url: bogotaEnv.DEVNET_RPC ?? "https://rpc.bogota-devnet-1.ethpandaops.io",
      chainId: 7038851975,
      accounts: keys(bogotaEnv),
    },
    // ethrex's public Hegota testnet. Same wire format and TXPARAM layout as bogota, but
    // NONCE_MANAGER is still at 0x...8250 (see nonceManagerFor), and it serves
    // ethrex_simulateFrameTransaction.
    "hegota-testnet": {
      type: "http",
      chainType: "l1",
      url: testnetEnv.DEVNET_RPC ?? "https://rpc1.privacy.ethrex.xyz",
      chainId: 8141,
      accounts: keys(testnetEnv),
    },
  },
};

export default config;
