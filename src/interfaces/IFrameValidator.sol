// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @notice EIP-8141 frame validator (ERC-8286 module type id 11).
/// A module MAY additionally be an ERC-7579 validator (type id 1) and serve both targets.
///
/// Modules are dispatched with DELEGATECALL, so a module runs in the installing account's
/// storage context. This is what keeps a module both shared (one deployment serves every
/// account) and admissible: per-account config lives in the account, so a validation frame
/// only ever reads the sender's storage, which ERC-7562-style validation rules permit.
/// Consequences a module MUST respect:
///  - `address(this)` is the account; `msg.sender` is the frame's caller, NOT the account.
///  - All storage MUST sit under an ERC-7201 namespace derived from the module's identity,
///    or it will collide with the account's own layout and with other modules.
///  - `onInstall` / `onUninstall` are delegatecalled too: they write the account's storage.
///  - A module has full write access to the account. Installing one is granting it control.
interface IFrameValidator is IERC7579Module {
    /// @dev `data` is the VERIFY frame's data with the leading 20-byte validator address
    /// stripped; the account owns that layout, so it is passed rather than introspected.
    /// Everything else the validator needs it MUST read from the frame transaction itself:
    /// frameIndex = TXPARAM(0x0A), allowedScope = FRAMEPARAM(frameIndex, 0x06),
    /// sigHash = TXPARAM(0x08). Values an account supplies can be forged or go stale;
    /// values read from the opcodes cannot.
    /// Returns APPROVE_NONE (0x0) on failure; the account masks with allowedScope regardless.
    function validateFrame(bytes calldata data) external view returns (uint8 approvalMode);
}
