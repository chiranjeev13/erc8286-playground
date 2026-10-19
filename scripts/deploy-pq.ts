// Deploys the post-quantum signing path: the SPHINCS verifier and the frame validator
// that uses it.
//
//   npm run deploy:pq            # hegota
//   npm run deploy:pq:testnet    # hegota testnet
//
// Both are ordinary type-2 transactions. The validator is delegatecalled by accounts and
// keeps each account's public key in that account's storage, so one deployment serves all.
// Accounts are created afterwards with initData = abi.encode(pkSeed, pkRoot).
import { formatEther } from "viem";
import { artifact, connect, saveEnv } from "./lib/connect.js";

const { envFile, network, client, account: deployer } = await connect();

const balance = await client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)} ETH`);
if (balance === 0n) throw new Error(`deployer has no funds on ${network}`);

async function deploy(name: string, contract: string, source: string, args: unknown[] = []): Promise<string> {
  const { abi, bytecode } = artifact(contract, source);
  const hash = await client.deployContract({ abi, bytecode, args });
  const { contractAddress, gasUsed } = await client.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error(`${contract}: deployment mined without an address`);
  console.log(`${contract} = ${contractAddress}  (gas ${gasUsed})`);
  saveEnv(envFile, `${name}_ADDRESS`, contractAddress);
  return contractAddress;
}

const verifier = await deploy("SPHINCSVERIFIER", "SphincsVerifier_v2", "pq/SphincsVerifier");
await deploy("SPHINCSFRAMEVALIDATOR", "SphincsFrameValidator", "SphincsFrameValidator", [verifier]);
