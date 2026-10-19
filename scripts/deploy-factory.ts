// Deploys the clone-based account stack: both validators (they read a cloned account's
// configuration from its code, so earlier deployments cannot serve clones), the account
// implementation, the factory, and the common paymaster.
//
//   npm run deploy:factory:testnet
//
// The implementations are configured with the deployer as owner; that configuration lives in
// the implementation's own storage and is never used by a clone.
import { formatEther, getAddress, parseEther } from "viem";
import { artifact, connect, need, saveEnv } from "./lib/connect.js";
import { FRAME_MODES } from "./lib/policy.js";

const { env, envFile, network, client, account: deployer } = await connect();
const balance = await client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address}  balance ${formatEther(balance)} ETH`);
if (balance === 0n) throw new Error(`deployer has no funds on ${network}`);

// Explicit gas: ethrex's estimator simulates with the block gas limit and refuses once the
// deployer's balance is below 200M * gasPrice, long before the funds are actually short.
async function deploy(key: string, contract: string, args: unknown[] = [], gas = 6_000_000n, source = contract): Promise<`0x${string}`> {
  const { abi, bytecode } = artifact(contract, source);
  const hash = await client.deployContract({ abi, bytecode, args, gas });
  const { contractAddress, gasUsed, status } = await client.waitForTransactionReceipt({ hash });
  if (status !== "success") throw new Error(`${contract}: deployment reverted (out of gas at ${gas}?)`);
  if (!contractAddress) throw new Error(`${contract}: deployment mined without an address`);
  console.log(`${contract} = ${contractAddress}  (gas ${gasUsed})`);
  saveEnv(envFile, `${key}_ADDRESS`, contractAddress);
  return getAddress(contractAddress);
}

const verifier = getAddress(need(env, "SPHINCSVERIFIER_ADDRESS", "run deploy:pq first"));
const ecdsa = await deploy("ECDSAFRAMEVALIDATOR", "ECDSAFrameValidator");
await deploy("SPHINCSFRAMEVALIDATOR", "SphincsFrameValidator", [verifier]);
await deploy("ERC8286FRAMEACCOUNT", "ERC8286FrameAccount", [ecdsa, deployer.address, 3, Object.values(FRAME_MODES), 0], 16_000_000n);
await deploy("ERC8286ACCOUNTFACTORY", "ERC8286AccountFactory", [], 3_500_000n);

// The playground's one paymaster. The server never holds a key, so this is the only place it
// is deployed; fund it here and at the faucet later (its address is in the env file).
const paymaster = await deploy("PAYMASTER", "Paymaster", [deployer.address], 1_500_000n);
const fund = await client.sendTransaction({ to: paymaster, value: parseEther("0.05"), gas: 100_000n });
await client.waitForTransactionReceipt({ hash: fund });
console.log(`paymaster funded with 0.05 ETH; top it up at the faucet when the playground says it is low`);
