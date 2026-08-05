// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @notice Minimal ERC-7579 module lifecycle surface used by ERC-8286.
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}
