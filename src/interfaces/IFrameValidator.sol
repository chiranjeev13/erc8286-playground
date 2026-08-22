// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @notice EIP-8141 frame validator (ERC-8286 module type id 11).
/// A module MAY additionally be an ERC-7579 validator (type id 1) and serve both targets.
interface IFrameValidator is IERC7579Module {
    /// @dev sigHash = TXPARAM(0x08), frameIndex = TXPARAM(0x0A),
    ///      allowedScope = FRAMEPARAM(frameIndex, 0x06).
    /// Returns APPROVE_NONE (0x0) on failure; the account masks with allowedScope.
    function validateFrame(
        bytes32 sigHash,
        uint256 frameIndex,
        uint8 allowedScope,
        bytes calldata data
    ) external view returns (uint8 approvalMode);
}
