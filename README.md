# ERC-8286 Accounts

Reference implementation of [ERC-8286: Modular Accounts for Frame Transactions](https://eips.ethereum.org/EIPS/eip-8286) — the EIP-8141 validation extension for ERC-7579 modular accounts.

## Layout

```
src/
  interfaces/     ERC-8286 interfaces (ERC-7579 surfaces come from @openzeppelin/contracts)
  lib/            LibERC8286: approval modes, frame modes, EIP-8141 introspection
  reference/      Spec reference assets + mockable test harness
SPEC.md           Snapshot of the ERC text
```

### Reference assets (from ethereum/ERCs `assets/erc-8286/`)

| Contract | Role |
|---|---|
| `ERC8286FrameAccount` | The account: both execution routes, chosen at creation; EIP-8141 `verbatim` opcodes |
| `ECDSAFrameValidator` | Frame validator (module type `11`) with ECDSA over sender-frame digest |
| `SphincsFrameValidator` | Post-quantum frame validator: a SPHINCS (hash-based) signature over the same digest |
| `ERC8286AccountFactory` | Creates accounts as clones with their configuration in code; usable from a deploy frame |
| `Paymaster` | Pays for any transaction whose pay frame reaches it; demo only |
| `IERC8286FrameAccount` / `IFrameValidator` | Spec interfaces |

### Building

The reference contracts emit EIP-8141 instructions, which no released `solc` knows. They are
compiled with an experimental fork,
[v0.8.36-eip8141.1](https://github.com/chiranjeev13/solidity/releases/tag/v0.8.36-eip8141.1),
which exposes all seven opcodes as inline-assembly builtins behind an EVM-version suffix:

```bash
# macOS arm64; see the release for Linux amd64
curl -L -o /opt/homebrew/bin/solc \
  https://github.com/chiranjeev13/solidity/releases/download/v0.8.36-eip8141.1/solc-eip8141-macos-arm64
xattr -d com.apple.quarantine /opt/homebrew/bin/solc
chmod +x /opt/homebrew/bin/solc

npm install
npm run compile
```

[`hardhat.config.ts`](hardhat.config.ts) replaces the compiler Hardhat would download with
that binary, via a small inline plugin on the `solidity` hooks, and injects
`evmVersion: "osaka+eip8141"` into the standard-JSON input on the way to `solc` — Hardhat
validates `evmVersion` against the EVM versions it knows, and the suffix is not one of them.
Set `SOLC` if the binary is not `solc` on `PATH`. A stock compiler fails with
`Invalid EVM version requested`.

ERC-7579 interfaces (`IERC7579Module`, `IERC7579AccountConfig`, `IERC7579ModuleConfig`, and
the `MODULE_TYPE_*` constants) come from `@openzeppelin/contracts` rather than being
redeclared locally.

### Module dispatch

Frame validators are dispatched with `DELEGATECALL`, so a module runs in the installing
account's storage context and keeps its per-account config there under an
[ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) namespace. One validator deployment
serves every account.

This is not a style choice. ERC-7562-style validation rules let a validation frame read only
the sender's storage, so a module holding account config in its *own* storage is rejected at
mempool admission (ethrex reports `StorageReadNonSender`) even though the transaction is
consensus-valid. Delegatecall keeps the module shared *and* every validation-time read on the
sender. The cost is that a module has full write access to the account: installing one grants
it control. See [`IFrameValidator`](src/interfaces/IFrameValidator.sol) for the rules a module
must follow.

### LibERC8286

[`src/lib/LibERC8286.sol`](src/lib/LibERC8286.sol) is the counterpart to solady's
`LibERC7579`: approval-mode and frame-mode constants, mode encode/decode, typed wrappers over
the EIP-8141 introspection opcodes (`txparam` / `frameparam` / `framedatacopy` / `approve`),
and the EIP-8250 keyed-nonce accessors.

Every function is `internal` so it inlines. That is load-bearing: a validator module is
reached by `DELEGATECALL` and runs in the account's context, and a library reached by its own
`DELEGATECALL` would break that — besides putting an external call inside a `VERIFY` frame.

The account and the validator hold no inline assembly of their own beyond the ERC-7201 slot
pointer. `presentedModeBits()` in particular reduces the SENDER-frame shape check to one
subset test: `presentedModeBits() & ~executionModes == 0`.

### Validator selection

The account picks its frame validator from `nonce_keys[0]` — the [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250)
keyed nonce, read via `TXPARAM(0x10)`. The key set is part of the signed envelope, so
selection is bound to the transaction: a relayer cannot substitute a different installed
validator. `ECDSAFrameValidator` reinforces this by committing `nonce_keys_hash`
(`TXPARAM(0x0E)`) in its digest, so swapping the validator invalidates the signature.

The digest also commits each SENDER frame's `flags` (`FRAMEPARAM(i, 0x03)`), whose bit 2 is
EIP-8141's `ATOMIC_BATCH_FLAG`. The envelope carries no outer signature, so this digest is
the only thing binding the frames to the owner: leaving the flag out would let anyone holding
the raw transaction regroup the batch, turning an all-or-nothing group into frames that
revert independently (or the reverse). `gas_limit` and the fee fields remain uncommitted.

There is no fallback: a VERIFY frame whose `nonce_keys[0]` does not encode an address is
rejected, and the entire VERIFY payload belongs to the validator.

A keyed nonce has its own sequence in the `NONCE_MANAGER` predeploy (`0x…8250`) at
`keccak256(pad32(sender) || pad32(key))`, independent of the account's linear nonce.

> ERC-8286's Validator Selection section cites `TXPARAM(0x0B)` for `nonce_keys[0]`. That index
> is `len(signatures)` in EIP-8141; EIP-8250 pins `TXPARAM_NONCE_KEY_0 = 0x10`, which is what
> ethrex ships and what this account reads.

### Post-quantum validator

EIP-8141 checks no signature of its own for a frame transaction. The account does, in its
VERIFY frame, with whatever validator it installed. That makes the signature scheme a module
choice rather than a protocol change, and it is the reason the EIP exists in the first place:
a quantum-safe signer has to be deployable before the curve is broken, without a fork.

`SphincsFrameValidator` is that signer. It stores `(pkSeed, pkRoot)` in the account's storage
under its own ERC-7201 slot, and `validateFrame` accepts a 6,176-byte sphincs-g signature
over `LibFrameTxDigest.digest(account)`, the same EIP-712 message the ECDSA validator
recovers against. Nothing on the path touches an elliptic curve; forging an approval means
inverting keccak256. The account does not know which validator it has: `verify()` reads
`nonce_keys[0]`, delegatecalls, masks the result with the frame's allowed scope and approves.

The verifier (`src/pq/SphincsVerifier.sol`) and the JavaScript signer are
[RivaLabs](https://github.com/RivaLabs-Core/Post-Quantum-AA-Infra)' experimental sphincs-g parameter set
(n=16 h=20 d=5 a=9 k=19 w=16, keccak256). It is not
standardized SLH-DSA and is unaudited. It compiles through the IR pipeline alone (a Hardhat
override), since its single assembly block does not fit the legacy stack, and nothing imports it.

Measured on the Hegota testnet: the VERIFY frame uses about 389k gas, under the 500k
`MAX_VERIFY_GAS` mempool cap, and a whole self-paid transfer costs about 608k with the
signature's calldata. Signing takes about 300 ms in JavaScript (`site/src/lib/pq/sphincs.mjs`,
the browser signer from the same demo). The playground creates such accounts from a key
generated in the browser, kept in localStorage: no wallet can hold one yet.

```bash
npm run deploy:pq:testnet   # SphincsVerifier_v2, then SphincsFrameValidator(verifier)
```

An account is created with `initData = abi.encode(pkSeed, pkRoot)`, each a 16-byte value in
the top half of its word. A rogue or tampered signature fails validation (`APPROVE_NONE`, so
`verify()` reverts), which the node reports as `validation prefix frame reverted`.

### Approval scopes

ERC-8286 does not require an account to grant every approval mode. `approvalScopes` is a
bitmask of what this account is willing to approve (`0x1` payment, `0x2` execution, `0x3`
both), set at construction (`APPROVAL_SCOPES` in
[`scripts/lib/policy.ts`](scripts/lib/policy.ts)) and changeable afterwards through
`setApprovalScopes`. `supportsApprovalMode` reports against it, and `verify()`
refuses to `APPROVE` a mode outside it.

Dropping `0x2` is a one-way door: `setApprovalScopes` is `onlySelf`, reachable only through a
SENDER frame executing as the account, which itself requires an `APPROVE_EXECUTION` grant.
Such an account can still pay for other transactions but can never reconfigure itself.

### Execution modes

`isExecutionModeSupported` is a set of SENDER-frame shapes, keyed by the ERC-7579-layout mode
word itself — there is no second representation of a mode. Deploy with
the shapes listed in `EXECUTION_MODE_NAMES`
([`scripts/lib/policy.ts`](scripts/lib/policy.ts)); change it later with
`setExecutionMode(bytes32 mode, bool supported)`.
`supportsExecutionMode` is the mapping lookup, so an unregistered word — an ERC-7579 execute
mode, or a frame mode with a stray payload byte — is simply absent and reports `false`.
These are policy declarations rather than capabilities: the protocol performs batching and
atomicity with no account code, so any account *could* honour all four — this is which ones
it *will*.

`_senderFramesSupported()` walks every SENDER frame and checks the mode it presents, because
one transaction can present several at once: an atomic group alongside an ungrouped frame
presents both `BATCH_ATOMIC` and `BATCH`.

Narrowing them is recoverable, unlike approval scopes, but the transaction carrying the
change must itself present a shape the current setting still supports.

> **Note on clearing the execution bit.** ERC-8286 step 4 says an account that sees an
> unsupported SENDER-frame shape must clear the execution bit, leaving
> `approvalMode & APPROVE_PAYMENT`. In the `self_verify` prefix shape that outcome is
> unreachable: EIP-8141 reverts an `APPROVE(APPROVE_PAYMENT)` while `sender_approved` is
> false, and the mempool requires `self_verify` to call
> `APPROVE(APPROVE_EXECUTION_AND_PAYMENT)` exactly. So a self-paying account that refuses the
> presented shape reverts either way; the degraded payment-only grant is meaningful only for
> a separate paymaster frame in the `only_verify + pay` shape.

### Account deployment

Accounts are EIP-1167 clones of a shared implementation, created by
[`ERC8286AccountFactory`](src/ERC8286AccountFactory.sol), with their initial configuration
appended to their own runtime code (OpenZeppelin's immutable-args layout). Nothing is written
to storage at creation. [`LibCloneConfig`](src/lib/LibCloneConfig.sol) reads it back:

```
args     = validator (20) || approvalScopes (1) || modeBits (1) || executionRoute (1) || initData
             modeBits: bit 0 single, 1 single-atomic, 2 batch, 3 batch-atomic
             executionRoute: 0x00 protocol-dispatched, 0x01 contract-dispatched
             initData: the owner address (ECDSA) or pkSeed || pkRoot, 16 bytes each (SPHINCS)
account  = CREATE2(factory, salt, clone code || args)     # factory.predict(impl, args, salt)
```

The account's getters consult storage first and fall back to the code: `setApprovalScopes`
and `setExecutionMode` write overrides, `installModule` adds validators beside the configured
one. The validators do the same for their key, so `onInstall` never runs for a clone. An
account deployed with its constructor has no code configuration and is written to storage
as before. Why this shape: under EIP-8037 a fresh slot costs 97,920 state gas, a byte of code
1,530, and the deploy prefix below may spend 500,000 in all.

```bash
npm run deploy:factory:testnet   # validators, both implementations, the factory
```

One implementation serves both execution routes. The route is part of the configuration and
fixed for the account's life: on the contract route `execute` opens and `verify` clears the
execution bit unless every SENDER frame targets the account (ERC-8286 verify step 5); on
the protocol route `execute` is closed and the protocol calls the targets itself.

### Deploying the sender inside its own transaction

Since the address is known in advance, the account can be created by an EIP-8141 `DEFAULT`
frame that calls the factory, in the very transaction it then approves and pays for. ethrex
reports the shape as `DeploySelfVerify` or, with a paymaster, `DeployOnlyVerifyPay`:

```
frame[0]  DEFAULT, target = factory, data = createAccount(impl, args, salt)   -> the clone appears
frame[1]  VERIFY,  target = account, flags 0x03 (0x02 with a paymaster)       -> it approves
frame[2]  VERIFY,  target = paymaster, flags 0x01                             -> optional
frame[3]  SENDER,  ...
```

The frames before the first `SENDER` frame share two budgets: 500,000 gas and 500,000 state
gas, both summed over the declared limits. Measured on the Hegota testnet:

| | gas | state gas |
|---|---|---|
| creating any account at all | | 183,600 |
| clone code, 45 bytes | | 68,850 |
| configuration, 42 bytes (ECDSA) / 54 bytes (SPHINCS) | | 64,260 / 82,620 |
| the deploy frame in total | 22,645 | 316,710 / 335,070 |
| keyed nonce slot, in the VERIFY or pay frame | | 97,920 |
| VERIFY, ECDSA / SPHINCS | about 35k / about 402k to 416k | |
| pay frame | 10,012 | |

Every variant fits, with the SPHINCS plus paymaster one the tightest: the playground declares
30k, 455k and 15k for its three prefix frames. A prefunded address is cheaper still, since the
transfer already created the account record and only the code is left to pay for (151,470).
Two things had to give way for this: the storage layout above, and `Create2.deploy`, whose
balance check uses `SELFBALANCE`, an opcode banned in validation frames; the factory runs a
bare `CREATE2` instead.

Mined examples: a wallet account paid by a paymaster (block 464681), a post-quantum account
paid by a paymaster (464691), and a prefunded post-quantum account paying for itself (464690).

### Devnet: sending a frame transaction

`.env.devnet` holds `DEVNET_PRIVATE_KEY`, `DEVNET_RPC`, and the deployed addresses (it is
gitignored). Fund the key from https://faucet.hegota.ethrex.xyz, then:

```bash
npm run deploy            # validator, then the account with it installed by its constructor
npm run send              # simulate a frame transaction
```

[`scripts/send-frame-tx.ts`](scripts/send-frame-tx.ts) builds a type-`0x06` transaction whose
sender is the account:

```
frame[0]  VERIFY (mode 1), target = account, flags 0x03
          data = abi.encodeCall(verify, r(32) || s(32) || v(1))
nonce_keys[0] = the validator address
frame[1]  SENDER (mode 2), target = recipient, value = amount
signatures = []          # authorization is the account's APPROVE, not an outer signature
```

It dry-runs through `ethrex_simulateFrameTransaction` first, since `eth_call` cannot
represent a frame transaction. Constants at the top of the script decide what it does —
`hardhat run` forwards no positional arguments, so they are edited in place: `to` and `amount`,
`submit` to send rather than simulate, `badSig` to corrupt the signature as a negative
control, and `force` to submit despite an invalid prefix. The batch and self-deploying scripts
are configured the same way.

After submitting it re-broadcasts the identical bytes to the devnet's sibling RPCs. Frame-tx
gossip between the nodes is best-effort, so a transaction can otherwise sit in one node's
mempool while another builds blocks without it; re-submitting is idempotent (same hash).

The account must hold ETH before sending: it pays its own gas, since `APPROVE_PAYMENT`
charges the transaction cost to the approving contract's balance.

[`scripts/lib/frametx.ts`](scripts/lib/frametx.ts) is the wire-format encoder, ported from
lambdaclass/ethrex @ `hegota-devnet`. `npm run test:encoder` checks it against that
implementation's golden vector.

### Local testing

`MockableFrameAccount` + `MockECDSAFrameValidator` mirror the verify flow without requiring an EIP-8141 client:

```bash
forge test -vv
```

## Verify flow (spec)

1. Require executing frame mode is `VERIFY`
2. Select installed frame validator (module type `11`)
3. `approvalMode = validateFrame(data) & allowedScope` — the validator reads frame index,
   allowed scope, and frame contents through introspection, never as arguments, and
   confirms the frame targets its account (`LibERC8286.isTargetedFrame`) and binds the
   signature to `tx.sender` in the EIP-712 message, so the account may also be only the payer
4. If execution bit set and any presented `SENDER` frame mode is unsupported → clear execution bit
5. If execution bit set, the account is contract-dispatched, and any `SENDER` frame resolves
   to another target → clear execution bit
6. If `APPROVE_NONE` → revert (do not `APPROVE`)
7. Else `APPROVE(approvalMode)`

## Execution route

`executionRoute()` declares how `SENDER` frames execute: `0x00` protocol-dispatched (frames
call their targets directly) or `0x01` contract-dispatched (every frame targets the account,
which dispatches through ERC-7579's `execute`). This account is protocol-dispatched: it has
no `execute`, so all policy lives in validation. Step 5 is what makes contract dispatch a
guarantee rather than a convention — a subclass that overrides `executionRoute` gets it from
`verify` unchanged.

## SENDER frame execution modes

| Constant | callType | execType |
|---|---|---|
| `FRAME_MODE_SINGLE` | `0x02` | `0x01` |
| `FRAME_MODE_SINGLE_ATOMIC` | `0x02` | `0x00` |
| `FRAME_MODE_BATCH` | `0x03` | `0x01` |
| `FRAME_MODE_BATCH_ATOMIC` | `0x03` | `0x00` |
