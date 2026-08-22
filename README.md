# ERC-8286 Accounts

Reference implementation of [ERC-8286: Modular Accounts for Frame Transactions](https://eips.ethereum.org/EIPS/eip-8286) — the EIP-8141 validation extension for ERC-7579 modular accounts.

## Layout

```
src/
  interfaces/     ERC-8286 interfaces (ERC-7579 surfaces come from @openzeppelin/contracts)
  lib/            Shared constants (approval modes, frame modes, module type 11)
  reference/      Spec reference assets + mockable test harness
SPEC.md           Snapshot of the ERC text
```

### Reference assets (from ethereum/ERCs `assets/erc-8286/`)

| Contract | Role |
|---|---|
| `ERC8286FrameAccount` | Compliant account using EIP-8141 `verbatim` opcodes |
| `ECDSAFrameValidator` | Frame validator (module type `11`) with ECDSA over sender-frame digest |
| `IERC8286FrameAccount` / `IFrameValidator` | Spec interfaces |

### Dependencies

ERC-7579 interfaces (`IERC7579Module`, `IERC7579AccountConfig`, `IERC7579ModuleConfig`, and the
`MODULE_TYPE_*` constants) are imported from OpenZeppelin's `interfaces/draft-IERC7579.sol` rather
than redeclared locally:

```bash
npm install
```

`foundry.toml` remaps `@openzeppelin/contracts/` to `node_modules/@openzeppelin/contracts/`.

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
