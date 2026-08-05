// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @notice Minimal ERC-7579 account config / module config surfaces used by ERC-8286.
interface IERC7579AccountConfig {
    function accountId() external view returns (string memory accountImplementationId);
    function supportsExecutionMode(bytes32 encodedMode) external view returns (bool supported);
    function supportsModule(uint256 moduleTypeId) external view returns (bool supported);
}

interface IERC7579ModuleConfig {
    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external;
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external;
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool installed);
}
