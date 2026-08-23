// Deploys the reference contracts to the Hegota frame-transaction devnet.
//
//   npm run deploy
//
// Both deploys are ordinary type-2 transactions: neither contract runs an EIP-8141 opcode
// in its constructor, so no frame-tx tooling is needed here. The opcodes execute later,
// inside a type-0x06 VERIFY frame.
//
// ACCOUNT_OWNER overrides the ECDSA signer the account is configured with (default: the
// deployer). Addresses are written back to .env.devnet.
import { formatEther } from "viem";
import { artifact, connect, saveEnv } from "./lib/connect.js";

const { env, client, account: deployer } = await connect();

const balance = await client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)} ETH`);
if (balance === 0n) {
  throw new Error("deployer has no funds -- claim from https://faucet.hegota.ethrex.xyz");
}

async function deploy(name: string, args: unknown[] = []): Promise<string> {
  const { abi, bytecode } = artifact(name);
  const hash = await client.deployContract({ abi, bytecode, args });
  const { contractAddress } = await client.waitForTransactionReceipt({ hash });
  if (contractAddress === undefined || contractAddress === null) {
    throw new Error(`${name}: deployment mined without an address`);
  }
  console.log(`${name} = ${contractAddress}`);
  saveEnv(`${name.toUpperCase()}_ADDRESS`, contractAddress);
  return contractAddress;
}

// The validator holds no state of its own: it is delegatecalled and keeps per-account
// config in the account, so one deployment serves every account.
const validator = await deploy("ECDSAFrameValidator");

// The account installs its first validator in its constructor -- `installModule` is
// onlySelf, and reaching it needs an execution approval that only an installed validator
// can grant, so a validator-less account would be permanently inert. initData is the
// owner's address, which onInstall writes into this account's storage.
const owner = process.env.ACCOUNT_OWNER ?? env.ACCOUNT_OWNER ?? deployer.address;

// Which APPROVE scopes the account will grant: 0x1 payment, 0x2 execution, 0x3 both.
// Dropping 0x2 is a one-way door -- setApprovalScopes is reachable only through a SENDER
// frame, which needs an execution approval.
const scopes = Number(process.env.APPROVAL_SCOPES ?? env.APPROVAL_SCOPES ?? 3);
if (![1, 2, 3].includes(scopes)) {
  throw new Error(`APPROVAL_SCOPES must be 1, 2, or 3 (got ${scopes})`);
}

// Which SENDER-frame shapes the account will authorize, as the ERC-7579-layout mode words
// themselves. Policy declarations, not capabilities -- the protocol does the batching, so
// this is what the account is willing to approve.
const FRAME_MODES: Record<string, string> = {
  single: `0x0201${"00".repeat(30)}`,
  "single-atomic": `0x0200${"00".repeat(30)}`,
  batch: `0x0301${"00".repeat(30)}`,
  "batch-atomic": `0x0300${"00".repeat(30)}`,
};

const requested = (process.env.EXECUTION_MODES ?? env.EXECUTION_MODES ?? "all")
  .split(",")
  .map((m) => m.trim())
  .filter((m) => m !== "");
const names = requested.length === 1 && requested[0] === "all" ? Object.keys(FRAME_MODES) : requested;
for (const name of names) {
  if (FRAME_MODES[name] === undefined) {
    throw new Error(
      `EXECUTION_MODES: unknown mode "${name}". Use "all" or a comma-separated list of: ` +
        Object.keys(FRAME_MODES).join(", "),
    );
  }
}
const modes = names.map((n) => FRAME_MODES[n]!);

const account = await deploy("ERC8286FrameAccount", [validator, owner, scopes, modes]);

console.log(`account owner (ECDSA signer) = ${owner}`);
console.log(`approval scopes = 0x${scopes.toString(16)}  execution modes = ${names.join(",")}`);
console.log("\nfund the account before sending a frame transaction -- it pays its own gas:");
console.log(`  cast send ${account} --value 0.05ether --private-key $DEVNET_PRIVATE_KEY --rpc-url ${env.DEVNET_RPC}`);
