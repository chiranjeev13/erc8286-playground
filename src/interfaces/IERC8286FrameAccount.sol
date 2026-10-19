// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {
    IERC7579AccountConfig,
    IERC7579ModuleConfig
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @notice ERC-8286 account interface: ERC-7579 config + EIP-8141 verify flow.
interface IERC8286FrameAccount is IERC7579AccountConfig, IERC7579ModuleConfig {
    /// @dev Selects an installed frame validator (module type id 11), masks its approval
    /// mode with the frame's allowed scope, clears the execution bit if SENDER frames
    /// present an unsupported execution mode or, for a contract-dispatched account, if any
    /// SENDER frame resolves to another target, then calls APPROVE.
    /// MUST revert if the executing frame's mode is not VERIFY.
    /// MUST NOT call APPROVE if validation fails (leaving APPROVE_NONE).
    function verify(bytes calldata data) external returns (uint8 approvalMode);

    function supportsApprovalMode(uint8 approvalMode) external view returns (bool);

    /// @dev 0x00 EXECUTION_ROUTE_PROTOCOL: SENDER frames call their targets directly.
    /// 0x01 EXECUTION_ROUTE_CONTRACT: every SENDER frame targets the account, which
    /// dispatches through ERC-7579's execute; `verify` MUST NOT approve execution otherwise.
    function executionRoute() external view returns (uint8);
}
