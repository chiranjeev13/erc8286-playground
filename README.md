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
| `ERC8286FrameAccount` | Compliant account using EIP-8141 `verbatim` opcodes |
| `ECDSAFrameValidator` | Frame validator (module type `11`) with ECDSA over sender-frame digest |
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

There is no factory contract. The [EIP-7997](https://eips.ethereum.org/EIPS/eip-7997)
deterministic-deployment predeploy at `0x4e59…956C` is the factory: its calldata is
`salt(32) || initcode`, it `CREATE2`s that, and it mixes **nothing about the caller** into the
address. So an account's address follows from its creation code and salt alone, and a factory
contract would only be re-deriving what anyone can derive.

[`scripts/lib/accounts.ts`](scripts/lib/accounts.ts) does the deriving:

```
initCode      = initialize(validator, owner, approvalScopes, executionModes) calldata
salt          = keccak256(keccak256(initCode) || index)          # a convention, not a rule
creationCode  = ERC8286AccountProxy creation code || abi.encode(implementation, initCode)
account       = CREATE2(0x4e59…956C, salt, keccak256(creationCode))
```

An account is [`ERC8286AccountProxy`](src/ERC8286AccountProxy.sol) — OpenZeppelin's
`ERC1967Proxy` under a local name, so the creation code is a compiled artifact of this repo and
whatever derives the address agrees byte for byte on the code being deployed. The proxy's
constructor delegatecalls the init code, so the account's configuration is written to the
proxy's storage as it is deployed and is committed by its address: nobody can occupy your
address with a different validator or owner. `index` gives one configuration many accounts.

```bash
npm run create:account
```

`index` picks the account and `fund` is the ETH it starts with — both constants at the top of
[`scripts/create-account.ts`](scripts/create-account.ts), since `hardhat run` forwards no
positional arguments. The implementation is reused from `.env.devnet` whenever one is recorded
there and still has code; one implementation serves every account. The script writes the
account to `ERC8286FRAMEACCOUNT_ADDRESS`, so `npm run send` and `npm run send:batch` then
target it.

Deployment and funding are two transactions. The predeploy `CREATE2`s with the call's value,
and `DELEGATECALL` preserves `callvalue`, so value would reach `initialize` and on to the
module's `onInstall` — non-payable in `IERC7579Module`, and Solidity forbids widening that in
an override, so the install reverts with only `install failed` to show for it. Accounts are
deployed with no value and funded by a plain transfer, which `receive()` accepts.

An account reached through a proxy validates frame transactions normally, which is not
obvious: the `VERIFY` frame delegatecalls twice (proxy → implementation → validator) and reads
the ERC-1967 implementation slot on the way. Both storage reads are on the sender, which is
what the ERC-7562-style validation rules require, and ethrex admits the transaction. It costs
about 6k more gas than a directly deployed account.

### Deploying the sender inside its own transaction

Because the address is caller-independent, the account can be deployed by an EIP-8141 `DEFAULT`
frame that calls the predeploy — EIP-8141 example 1b, the flow that lets an account pay for the
transaction that creates it. [`scripts/send-deploy-and-send.ts`](scripts/send-deploy-and-send.ts)
(`npm run send:deploy`) builds it:

```
frame[0]  DEFAULT, target = 0x4e59…956C, data = salt || creation code   -> CREATE2s the account
frame[1]  VERIFY,  target = empty (resolves to tx.sender), flags 0x03   -> it validates
frame[2]  SENDER,  target = recipient, value = amount
```

ethrex recognises the shape — it reports `prefixShape: "DeploySelfVerify"` — but **this account
is too expensive to deploy there.** Every frame before the first `SENDER` frame shares one gas
budget, `MAX_VERIFY_GAS` = 500,000, and on this devnet:

| | gas |
|---|---|
| empty contract via the predeploy | 213,105 |
| ERC-1167 minimal clone (45 bytes) | 283,383 |
| `ERC8286AccountProxy`, no config written | 690,493 |
| … + `initialize`, 1 mode / 4 modes | 1,132,629 / 1,476,689 |

So no choice of frame gas limits fits: the proxy alone is over budget before a single config
slot is written, and `initialize` adds ~442k more, most of it seven separate storage writes
(`approvalScopes`, one per execution mode, `isValidatorInstalled`, and the module's owner).
Fitting under 500k needs both a leaner proxy — an ERC-1167 clone keeps the implementation in
code and skips the implementation-slot write — and a packed configuration, since a validator
address, the scope bits and a four-bit mode mask fit in a single word. Both are changes to the
account, not to the deployment path.

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
3. `approvalMode = validateFrame(...) & allowedScope`
4. If execution bit set and any presented `SENDER` frame mode is unsupported → clear execution bit
5. If `APPROVE_NONE` → revert (do not `APPROVE`)
6. Else `APPROVE(approvalMode)`

## SENDER frame execution modes

| Constant | callType | execType |
|---|---|---|
| `FRAME_MODE_SINGLE` | `0x02` | `0x01` |
| `FRAME_MODE_SINGLE_ATOMIC` | `0x02` | `0x00` |
| `FRAME_MODE_BATCH` | `0x03` | `0x01` |
| `FRAME_MODE_BATCH_ATOMIC` | `0x03` | `0x00` |
