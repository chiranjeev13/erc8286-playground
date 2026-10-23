// Deploys only the two frame validators, for a change to how they read signatures. The
// account implementation, factory, paymaster and SPHINCS verifier stay where they are.
//
//   npm run deploy:validators:testnet
//
// Accounts are bound to the validator they were created with (it is in their clone code), so
// the playground marks accounts on the previous validators as outdated and new ones use these.
// SPHINCSVERIFIER_ADDRESS must be in the env file: the existing verifier is reused.
import { formatEther, getAddress } from "viem";
import { artifact, connect, saveEnv } from "./lib/connect.js";

const { env, envFile, network, client, account: deployer } = await connect();
const balance = await client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)} ETH`);
if (balance === 0n) throw new Error(`deployer has no funds on ${network}`);
if (!env.SPHINCSVERIFIER_ADDRESS) throw new Error(`SPHINCSVERIFIER_ADDRESS missing from ${envFile}`);
const verifier = getAddress(env.SPHINCSVERIFIER_ADDRESS);

async function deploy(name: string, contract: string, source: string, args: unknown[] = []): Promise<string> {
  const { abi, bytecode } = artifact(contract, source);
  // Explicit gas and fees: estimation on this node reserves the whole 200M block gas limit at
  // the suggested tip, which outruns a deployer's balance; the base fee itself is a few wei.
  const hash = await client.deployContract({ abi, bytecode, args, gas: 10_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  const { contractAddress, gasUsed } = await client.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error(`${contract}: deployment mined without an address`);
  console.log(`${contract} = ${contractAddress}  (gas ${gasUsed}, was ${env[`${name}_ADDRESS`] ?? "unset"})`);
  saveEnv(envFile, `${name}_ADDRESS`, contractAddress);
  return contractAddress;
}

await deploy("ECDSAFRAMEVALIDATOR", "ECDSAFrameValidator", "ECDSAFrameValidator");
await deploy("SPHINCSFRAMEVALIDATOR", "SphincsFrameValidator", "SphincsFrameValidator", [verifier]);
console.log(`\nverifier reused: ${verifier}. Update the same two addresses in the Vercel project's environment.`);
