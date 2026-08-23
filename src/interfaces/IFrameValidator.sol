// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @notice EIP-8141 frame validator (ERC-8286 module type id 11).
/// A module MAY additionally be an ERC-7579 validator (type id 1) and serve both targets.
///
/// Modules are dispatched with DELEGATECALL and run in the installing account's storage
/// context, including `onInstall` / `onUninstall`. A module MUST therefore:
///  - use `address(this)` as the account; `msg.sender` is the frame's caller, not the account
///  - keep all storage under an ERC-7201 namespace derived from its own identity
///  - be trusted: it has full write access to the account.
interface IFrameValidator is IERC7579Module {
    /// @dev `data` is the validator-specific payload from the VERIFY frame. Everything else
    /// the validator MUST read from the transaction itself: frameIndex = TXPARAM(0x0A),
    /// allowedScope = FRAMEPARAM(frameIndex, 0x06), sigHash = TXPARAM(0x08).
    /// Returns APPROVE_NONE (0x0) on failure; the account masks with allowedScope regardless.
    function validateFrame(bytes calldata data) external view returns (uint8 approvalMode);
}
