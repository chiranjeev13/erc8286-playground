// Deploys the reference contracts to the Hegota frame-transaction devnet.
//
//   npm run deploy
//
// Both deploys are ordinary type-2 transactions: neither contract runs an EIP-8141 opcode
// in its constructor, so no frame-tx tooling is needed here. The opcodes execute later,
// inside a type-0x06 VERIFY frame.
//
// The account is configured with the deployer as its ECDSA signer, and the approval scopes
// and execution modes in scripts/lib/policy.ts. Addresses are written back to .env.devnet.
import { formatEther } from "viem";
import { artifact, connect, saveEnv } from "./lib/connect.js";
import { APPROVAL_SCOPES, EXECUTION_MODES, EXECUTION_MODE_NAMES } from "./lib/policy.js";

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
const owner = deployer.address;
const scopes = APPROVAL_SCOPES;
const modes = EXECUTION_MODES;
const names = EXECUTION_MODE_NAMES;

const account = await deploy("ERC8286FrameAccount", [validator, owner, scopes, modes]);

console.log(`account owner (ECDSA signer) = ${owner}`);
console.log(`approval scopes = 0x${scopes.toString(16)}  execution modes = ${names.join(",")}`);
console.log("\nfund the account before sending a frame transaction -- it pays its own gas:");
console.log(`  cast send ${account} --value 0.05ether --private-key $DEVNET_PRIVATE_KEY --rpc-url ${env.DEVNET_RPC}`);
