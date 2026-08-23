import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { artifact } from "./connect.js";

/**
 * Account addresses, derived where the chain derives them.
 *
 * There is no factory contract. The EIP-7997 deterministic-deployment predeploy is the
 * factory: its calldata is `salt(32) || initcode`, it CREATE2s that, and it mixes nothing
 * about the caller into the result. An account's address is therefore a function of the code
 * being deployed and the salt, and nothing else -- which is what lets the same account be
 * deployed by an ordinary transaction to the predeploy or by an EIP-8141 `DEFAULT` frame that
 * calls it, and land at the same place either way.
 *
 * https://eips.ethereum.org/EIPS/eip-7997
 */
export const DETERMINISTIC_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/** `initialize(address,bytes,uint8,bytes32[])` on the account. */
const INITIALIZE_ABI = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "validator", type: "address" },
      { name: "initData", type: "bytes" },
      { name: "approvalScopes", type: "uint8" },
      { name: "executionModes", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

export interface AccountConfig {
  /** The frame validator to install, and the account's `nonce_keys[0]`. */
  validator: Address;
  /** The ECDSA signer, which `onInstall` writes into the account's storage. */
  owner: Address;
  /** APPROVE scopes the account will grant: 0x1 payment, 0x2 execution, 0x3 both. */
  scopes: number;
  /** SENDER-frame shapes the account will authorize, as mode words. */
  modes: Hex[];
}

export interface AccountAddressInput extends AccountConfig {
  /** The shared ERC8286FrameAccount whose code the proxy runs. */
  implementation: Address;
  /** One configuration, many accounts. */
  index: bigint;
}

/**
 * The `initialize` calldata. The proxy's constructor delegatecalls this, so the account's
 * configuration is written as it is deployed -- and, because the calldata is part of the
 * proxy's creation code, committed by the account's address.
 */
export function initCode({ validator, owner, scopes, modes }: AccountConfig): Hex {
  return encodeFunctionData({
    abi: INITIALIZE_ABI,
    functionName: "initialize",
    args: [validator, owner, scopes, modes],
  });
}

/**
 * `keccak256(keccak256(initCode) || index)`.
 *
 * A convention, not a rule -- the predeploy accepts any salt. The init code is hashed rather
 * than concatenated so the salt stays fixed-width whatever the execution-mode list looks
 * like, and it is in there at all so that two accounts differing only in configuration
 * cannot be confused for one another even before the creation code is considered.
 */
export function saltFor(init: Hex, index: bigint): Hex {
  return keccak256(concat([keccak256(init), numberToHex(index, { size: 32 })]));
}

/**
 * The proxy's creation code: ERC8286AccountProxy's own, plus its constructor arguments.
 *
 * Read from the compiled artifact, so this agrees byte for byte with what gets deployed --
 * the address depends on the hash of exactly these bytes.
 */
export function proxyCreationCode(implementation: Address, init: Hex): Hex {
  return concat([
    artifact("ERC8286AccountProxy").bytecode,
    encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [implementation, init]),
  ]);
}

/** Everything about an account that follows from its configuration. */
export interface DerivedAccount {
  address: Address;
  /** `initialize` calldata. */
  initCode: Hex;
  salt: Hex;
  /** The proxy creation code the predeploy will run. */
  creationCode: Hex;
  /** What to send the predeploy: `salt || creation code`. Also a DEFAULT frame's data. */
  deployCalldata: Hex;
}

/** Derives an account's address and the bytes that deploy it. */
export function deriveAccount({ implementation, index, ...config }: AccountAddressInput): DerivedAccount {
  const init = initCode(config);
  const salt = saltFor(init, index);
  const creationCode = proxyCreationCode(implementation, init);
  return {
    address: getCreate2Address({ from: DETERMINISTIC_FACTORY, salt, bytecode: creationCode }),
    initCode: init,
    salt,
    creationCode,
    deployCalldata: concat([salt, creationCode]),
  };
}
