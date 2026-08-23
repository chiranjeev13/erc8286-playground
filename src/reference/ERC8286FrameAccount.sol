// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IFrameValidator} from "../interfaces/IFrameValidator.sol";
import {IERC8286FrameAccount} from "../interfaces/IERC8286FrameAccount.sol";
import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {LibERC8286} from "../lib/LibERC8286.sol";

// IERC7579Module, and the IERC7579AccountConfig / IERC7579ModuleConfig surfaces inherited
// via IERC8286FrameAccount, come from OpenZeppelin's ERC-7579 interfaces
// (@openzeppelin/contracts/interfaces/draft-IERC7579.sol).

contract ERC8286FrameAccount is IERC8286FrameAccount {
    using LibERC8286 for uint256;

    mapping(address => bool) public isValidatorInstalled;

    /// @dev The APPROVE scopes this account is willing to grant, as a bitmask of
    /// LibERC8286.APPROVE_PAYMENT | LibERC8286.APPROVE_EXECUTION. ERC-8286 does not require an account to grant
    /// every mode: an account that should never sponsor another transaction's gas can drop
    /// LibERC8286.APPROVE_PAYMENT, and one that should only ever pay can drop LibERC8286.APPROVE_EXECUTION.
    uint8 public approvalScopes;

    /// @dev The SENDER-frame shapes this account is willing to authorize, as a bitmask of
    /// LibERC8286's `FRAME_MODE_*_BIT` values. These are policy declarations, not
    /// capabilities: the protocol performs batching and atomicity with no account code, so
    /// every account could honour all four -- this is which ones it will.
    uint8 public executionModes;

    event ApprovalScopesUpdated(uint8 approvalScopes);
    event ExecutionModesUpdated(uint8 executionModes);

    modifier onlySelf() {
        require(msg.sender == address(this), "unauthorized");
        _;
    }

    /// @dev Installs the account's first frame validator.
    /// Bootstrapping is otherwise impossible: `installModule` is `onlySelf`, reaching it needs a
    /// SENDER frame executing as `tx.sender`, that needs execution approval, and `verify()` rejects
    /// an uninstalled validator. Without this an account is permanently inert.
    constructor(
        address validator,
        bytes memory initData,
        uint8 approvalScopes_,
        uint8 executionModes_
    ) {
        require(validator != address(0), "validator required");
        _setApprovalScopes(approvalScopes_);
        _setExecutionModes(executionModes_);
        _installValidator(validator, initData);
    }

    /// @dev Narrowing or widening what this account will approve.
    ///
    /// Reachable only through a SENDER frame executing as this account, which itself needs
    /// an LibERC8286.APPROVE_EXECUTION grant -- so dropping the execution bit is a ONE-WAY door: the
    /// account can still pay for transactions, but can never change this setting again.
    function setApprovalScopes(uint8 approvalScopes_) external onlySelf {
        _setApprovalScopes(approvalScopes_);
    }

    function _setApprovalScopes(uint8 approvalScopes_) internal {
        require(approvalScopes_ != LibERC8286.APPROVE_NONE, "no scopes");
        require(approvalScopes_ & ~LibERC8286.APPROVE_SCOPE_MASK == 0, "invalid scopes");
        approvalScopes = approvalScopes_;
        emit ApprovalScopesUpdated(approvalScopes_);
    }

    /// @dev Narrowing or widening the SENDER-frame shapes this account will authorize.
    ///
    /// Reachable only through a SENDER frame executing as this account, so the transaction
    /// carrying the change must itself present a shape the CURRENT setting still supports.
    /// Narrowing to a shape you cannot construct strands the setting.
    function setExecutionModes(uint8 executionModes_) external onlySelf {
        _setExecutionModes(executionModes_);
    }

    function _setExecutionModes(uint8 executionModes_) internal {
        require(executionModes_ != 0, "no modes");
        require(executionModes_ & ~LibERC8286.FRAME_MODE_BITS_MASK == 0, "invalid modes");
        executionModes = executionModes_;
        emit ExecutionModesUpdated(executionModes_);
    }

    /// @dev An account funds its own execution: LibERC8286.APPROVE_PAYMENT charges the tx cost to this
    /// contract's balance, and SENDER frames spend from it. Without this it cannot be funded
    /// by a plain transfer.
    receive() external payable {}

    function verify(bytes calldata data) external override returns (uint8 approvalMode) {
        uint256 frameIndex = LibERC8286.currentFrameIndex();

        // Only a VERIFY frame runs under STATICCALL protection and invalidates the whole
        // transaction on revert. A DEFAULT frame can also reach this code with
        // caller == ENTRY_POINT, so the mode MUST be checked rather than assumed.
        require(LibERC8286.frameModeOf(frameIndex) == LibERC8286.MODE_VERIFY, "not a VERIFY frame");

        (address validator, bytes calldata validatorData) = LibERC8286.decodeValidator(data);
        require(isValidatorInstalled[validator], "validator not installed");

        uint8 allowedScope = LibERC8286.allowedScope(frameIndex);

        // Modules are DELEGATECALLed: the module runs in this account's storage context, so
        // its per-account config lives here and a validation frame reads only the sender's
        // storage. The module reads frameIndex / allowedScope / sigHash from the transaction
        // itself; only the frame-data payload, whose layout is this account's convention, is
        // passed in. See IFrameValidator for what this requires of a module.
        (bool ok, bytes memory ret) =
            validator.delegatecall(abi.encodeCall(IFrameValidator.validateFrame, (validatorData)));
        require(ok, "validator reverted");
        approvalMode = abi.decode(ret, (uint8));

        // Mask to the frame's allowance; the account is the final authority.
        uint8 granted = approvalMode & allowedScope;

        // If execution is approved, every presented SENDER-frame mode must be supported;
        // otherwise clear the execution bit, leaving payment (if any) intact.
        if ((granted & LibERC8286.APPROVE_EXECUTION) != 0 && !_senderFramesSupported()) {
            granted &= LibERC8286.APPROVE_PAYMENT;
        }

        require(granted != LibERC8286.APPROVE_NONE, "validation failed");
        require(supportsApprovalMode(granted), "unsupported approval mode");

        LibERC8286.approveScope(granted); // exits the frame
    }

    /// @dev True only for a mode whose bits are all enabled in `approvalScopes`.
    /// LibERC8286.APPROVE_NONE is never supported: it is not a grantable mode, and EIP-8141 rejects an
    /// APPROVE carrying scope 0.
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

    // This reference account is protocol-dispatched only: it defines no execute entrypoint,
    // so supportsExecutionMode declares which SENDER-frame shapes its validators are willing
    // to authorize, using the frame execution modes (callType 0x02 / 0x03). ERC-7579 execute
    // modes (callType 0x00 / 0x01) report unsupported because there is no execute to process
    // them.
    function supportsExecutionMode(bytes32 encodedMode) public view override returns (bool) {
        uint8 bit = LibERC8286.modeBit(encodedMode);
        return bit != 0 && bit & executionModes != 0;
    }

    function supportsModule(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    // Every mode the transaction's SENDER frames present must be one this account will
    // authorize. `presentedModeBits` returns them as a bitmask, so the whole check is one
    // subset test; it returns zero when there are no SENDER frames, nothing to authorize.
    function _senderFramesSupported() internal view returns (bool) {
        return LibERC8286.presentedModeBits() & ~executionModes == 0;
    }
}
