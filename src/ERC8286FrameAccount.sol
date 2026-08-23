// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IERC8286FrameAccount} from "./interfaces/IERC8286FrameAccount.sol";
import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";

// IERC7579Module, and the IERC7579AccountConfig / IERC7579ModuleConfig surfaces inherited
// via IERC8286FrameAccount, come from OpenZeppelin's ERC-7579 interfaces
// (@openzeppelin/contracts/interfaces/draft-IERC7579.sol).

contract ERC8286FrameAccount is IERC8286FrameAccount {
    using LibERC8286 for uint256;

    mapping(address => bool) public isValidatorInstalled;

    /// @dev The APPROVE scopes this account will grant, as a bitmask of APPROVE_PAYMENT |
    /// APPROVE_EXECUTION.
    uint8 public approvalScopes;

    /// @dev The SENDERframe shapes this account will authorize, keyed by mode word.
    mapping(bytes32 => bool) public isExecutionModeSupported;

    event ApprovalScopesUpdated(uint8 approvalScopes);
    event ExecutionModeUpdated(bytes32 mode, bool supported);

    modifier onlySelf() {
        require(msg.sender == address(this), "unauthorized");
        _;
    }

    /// @dev Installs the first frame validator and sets the initial policy. Without an
    /// installed validator the account cannot approve anything, so it cannot install one
    /// later: `installModule` is `onlySelf`.
    constructor(
        address validator,
        bytes memory initData,
        uint8 approvalScopes_,
        bytes32[] memory executionModes_
    ) {
        _initialize(validator, initData, approvalScopes_, executionModes_);
    }

    /// @dev The proxy counterpart to the constructor. A proxy runs its implementation's
    /// constructor never -- that ran once, against the implementation's own storage -- so a
    /// cloned account is configured through here, delegatecalled from the proxy's
    /// constructor and therefore writing to the proxy's storage.
    function initialize(
        address validator,
        bytes calldata initData,
        uint8 approvalScopes_,
        bytes32[] calldata executionModes_
    ) external {
        require(approvalScopes == LibERC8286.APPROVE_NONE, "already initialized");
        _initialize(validator, initData, approvalScopes_, executionModes_);
    }

    function _initialize(
        address validator,
        bytes memory initData,
        uint8 approvalScopes_,
        bytes32[] memory executionModes_
    ) internal {
        require(validator != address(0), "validator required");
        require(executionModes_.length != 0, "no modes");
        _setApprovalScopes(approvalScopes_);
        for (uint256 i = 0; i < executionModes_.length; i++) {
            _setExecutionMode(executionModes_[i], true);
        }
        _installValidator(validator, initData);
    }

    /// @dev Sets the APPROVE scopes this account will grant. Dropping APPROVE_EXECUTION is
    /// one-way: reaching this function again would need an execution approval.
    function setApprovalScopes(uint8 approvalScopes_) external onlySelf {
        _setApprovalScopes(approvalScopes_);
    }

    function _setApprovalScopes(uint8 approvalScopes_) internal {
        require(approvalScopes_ != LibERC8286.APPROVE_NONE, "no scopes");
        require(approvalScopes_ & ~LibERC8286.APPROVE_SCOPE_MASK == 0, "invalid scopes");
        approvalScopes = approvalScopes_;
        emit ApprovalScopesUpdated(approvalScopes_);
    }

    /// @dev Adds or removes a SENDER-frame shape. The transaction carrying the change must
    /// itself present a shape the current setting still supports.
    function setExecutionMode(bytes32 mode, bool supported) external onlySelf {
        _setExecutionMode(mode, supported);
    }

    function _setExecutionMode(bytes32 mode, bool supported) internal {
        require(LibERC8286.isFrameMode(mode), "not a frame mode");
        isExecutionModeSupported[mode] = supported;
        emit ExecutionModeUpdated(mode, supported);
    }

    /// @dev The account pays its own gas and SENDER frames spend from its balance, so it
    /// must be able to receive ETH.
    receive() external payable {}

    function verify(bytes calldata data) external override returns (uint8 approvalMode) {
        uint256 frameIndex = LibERC8286.currentFrameIndex();

        // A DEFAULT frame can also reach this code with caller == ENTRY_POINT, so the mode
        // must be checked rather than assumed.
        require(LibERC8286.frameModeOf(frameIndex) == LibERC8286.MODE_VERIFY, "not a VERIFY frame");

        // EIP-8250: the validator is the address in nonce_keys[0], which is part of the
        // signed envelope, so selection is bound to the transaction. The whole VERIFY payload
        // belongs to the validator.
        address validator = LibERC8286.validatorFromNonceKey();
        require(validator != address(0), "no validator in nonce key");
        require(isValidatorInstalled[validator], "validator not installed");

        uint8 allowedScope = LibERC8286.allowedScope(frameIndex);

        // DELEGATECALL: the module runs in this account's storage context. It introspects
        // frameIndex / allowedScope / sigHash itself, so only the payload is passed in.
        (bool ok, bytes memory ret) =
            validator.delegatecall(abi.encodeCall(IFrameValidator.validateFrame, (data)));
        require(ok, "validator reverted");
        approvalMode = abi.decode(ret, (uint8));

        // Mask to the frame's allowance; the account is the final authority.
        uint8 granted = approvalMode & allowedScope;

        // Clear the execution bit if any presented SENDER-frame mode is unsupported.
        if ((granted & LibERC8286.APPROVE_EXECUTION) != 0 && !_senderFramesSupported()) {
            granted &= LibERC8286.APPROVE_PAYMENT;
        }

        require(granted != LibERC8286.APPROVE_NONE, "validation failed");
        require(supportsApprovalMode(granted), "unsupported approval mode");

        LibERC8286.approveScope(granted); // exits the frame
    }

    /// @dev True only for a mode whose bits are all set in `approvalScopes`. APPROVE_NONE is
    /// never supported: EIP-8141 rejects an APPROVE carrying scope 0.
    function supportsApprovalMode(uint8 approvalMode) public view override returns (bool) {
        return approvalMode != LibERC8286.APPROVE_NONE && approvalMode & ~approvalScopes == 0;
    }

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        override
        onlySelf
    {
        require(moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR, "unsupported module type");
        _installValidator(module, initData);
    }

    function _installValidator(address module, bytes memory initData) internal {
        require(!isValidatorInstalled[module], "already installed");
        isValidatorInstalled[module] = true;
        (bool ok,) = module.delegatecall(abi.encodeCall(IERC7579Module.onInstall, (initData)));
        require(ok, "install failed");
        emit ModuleInstalled(LibERC8286.MODULE_TYPE_FRAME_VALIDATOR, module);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        override
        onlySelf
    {
        require(moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR, "unsupported module type");
        require(isValidatorInstalled[module], "not installed");
        isValidatorInstalled[module] = false;
        (bool ok,) = module.delegatecall(abi.encodeCall(IERC7579Module.onUninstall, (deInitData)));
        require(ok, "uninstall failed");
        emit ModuleUninstalled(moduleTypeId, module);
    }

    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata)
        external
        view
        override
        returns (bool)
    {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR && isValidatorInstalled[module];
    }

    function accountId() external pure override returns (string memory) {
        return "erc8286.reference-frame-account.0.1.0";
    }

    // This account has no execute entrypoint, so it reports only the frame execution modes
    // (callType 0x02 / 0x03); ERC-7579's own execute modes are unsupported.
    function supportsExecutionMode(bytes32 encodedMode) public view override returns (bool) {
        return isExecutionModeSupported[encodedMode];
    }

    function supportsModule(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    // Every SENDER frame is checked, because one transaction can present several modes at
    // once. No SENDER frames means nothing to authorize.
    function _senderFramesSupported() internal view returns (bool) {
        uint256 numFrames = LibERC8286.frameCount();
        bool batch = LibERC8286.senderFrameCount() > 1;
        for (uint256 i = 0; i < numFrames; i++) {
            if (LibERC8286.frameModeOf(i) != LibERC8286.MODE_SENDER) continue;
            if (!supportsExecutionMode(LibERC8286.presentedMode(i, batch))) return false;
        }
        return true;
    }
}
