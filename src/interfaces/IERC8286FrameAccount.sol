// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IERC7579AccountConfig, IERC7579ModuleConfig} from "../interfaces/IERC7579Account.sol";

/// @notice ERC-8286 account interface: ERC-7579 config + EIP-8141 verify flow.
interface IERC8286FrameAccount is IERC7579AccountConfig, IERC7579ModuleConfig {
    /// @dev Selects an installed frame validator (module type id 11), masks its approval
    /// mode with the frame's allowed scope, clears the execution bit if SENDER frames
    /// present an unsupported execution mode, then calls APPROVE.
    /// MUST revert if the executing frame's mode is not VERIFY.
    /// MUST NOT call APPROVE if validation fails (leaving APPROVE_NONE).
    function verify(bytes calldata data) external returns (uint8 approvalMode);

    function supportsApprovalMode(uint8 approvalMode) external view returns (bool);
}
