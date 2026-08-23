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
and the `validator(20) || data` VERIFY-payload convention.

Every function is `internal` so it inlines. That is load-bearing: a validator module is
reached by `DELEGATECALL` and runs in the account's context, and a library reached by its own
`DELEGATECALL` would break that — besides putting an external call inside a `VERIFY` frame.

The account and the validator hold no inline assembly of their own beyond the ERC-7201 slot
pointer. `presentedModeBits()` in particular reduces the SENDER-frame shape check to one
subset test: `presentedModeBits() & ~executionModes == 0`.

### Approval scopes

ERC-8286 does not require an account to grant every approval mode. `approvalScopes` is a
bitmask of what this account is willing to approve (`0x1` payment, `0x2` execution, `0x3`
both), set at construction (`APPROVAL_SCOPES` when deploying) and changeable afterwards
through `setApprovalScopes`. `supportsApprovalMode` reports against it, and `verify()`
refuses to `APPROVE` a mode outside it.

Dropping `0x2` is a one-way door: `setApprovalScopes` is `onlySelf`, reachable only through a
SENDER frame executing as the account, which itself requires an `APPROVE_EXECUTION` grant.
Such an account can still pay for other transactions but can never reconfigure itself.

### Execution modes

`executionModes` is the matching bitmask for SENDER-frame shapes — `0x1` single, `0x2`
single-atomic, `0x4` batch, `0x8` batch-atomic (`EXECUTION_MODES` when deploying, then
`setExecutionModes`). `supportsExecutionMode` reports against it. These are policy
declarations rather than capabilities: the protocol performs batching and atomicity with no
account code, so any account *could* honour all four — this is which ones it *will*.

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

### Devnet: sending a frame transaction

`.env.devnet` holds `DEVNET_PRIVATE_KEY`, `DEVNET_RPC`, and the deployed addresses (it is
gitignored). Fund the key from https://faucet.hegota.ethrex.xyz, then:

```bash
npm run deploy            # validator, then the account with it installed by its constructor
npm run send              # simulate a frame transaction
SUBMIT=1 npm run send     # ...and submit it
```

[`scripts/send-frame-tx.ts`](scripts/send-frame-tx.ts) builds a type-`0x06` transaction whose
sender is the account:

```
frame[0]  VERIFY (mode 1), target = account, flags 0x03
          data = abi.encodeCall(verify, validator(20) || r(32) || s(32) || v(1))
frame[1]  SENDER (mode 2), target = recipient, value = amount
signatures = []          # authorization is the account's APPROVE, not an outer signature
```

It dry-runs through `ethrex_simulateFrameTransaction` first, since `eth_call` cannot
represent a frame transaction. Environment variables configure it (`hardhat run` forwards no
positional arguments): `TO`, `AMOUNT`, `SUBMIT=1`, `BAD_SIG=1` to corrupt the signature as a
negative control, `FORCE=1` to submit despite an invalid prefix.

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
