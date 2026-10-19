// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {IERC8286FrameAccount} from "./interfaces/IERC8286FrameAccount.sol";
import {IERC7579Module} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibCloneConfig} from "./lib/LibCloneConfig.sol";
import {IERC7579Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {ERC7579Utils} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";

// IERC7579Module, and the IERC7579AccountConfig / IERC7579ModuleConfig surfaces inherited
// via IERC8286FrameAccount, come from OpenZeppelin's ERC-7579 interfaces
// (@openzeppelin/contracts/interfaces/draft-IERC7579.sol).

contract ERC8286FrameAccount is IERC8286FrameAccount, IERC7579Execution {
    using LibERC8286 for uint256;

    /// @dev ERC-7579 modes this account's execute accepts on the contract route: single and
    /// batch calls, revert-all.
    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));

    // Configuration lives in two layers. A cloned account carries its initial configuration
    // in its own code (LibCloneConfig) and writes nothing at creation; storage holds whatever
    // was changed since, and wins. An account deployed with its constructor has no code
    // configuration, so its constructor writes storage as any contract would.

    mapping(address => bool) private _installed;
    /// @dev Set when the code-configured validator is uninstalled; it has no storage entry to clear.
    bool private _codeValidatorRemoved;

    /// @dev Storage override of the APPROVE scopes; zero means "as configured in code".
    uint8 private _approvalScopes;

    /// @dev Storage override per mode word: 0 as in code, 1 supported, 2 unsupported.
    mapping(bytes32 => uint8) private _modeOverride;
    uint8 private constant MODE_SUPPORTED = 1;
    uint8 private constant MODE_UNSUPPORTED = 2;

    /// @dev The execution route of an account deployed with its constructor; a clone's is in
    /// its code. Fixed for the account's life: changing it would change what every
    /// validator must check.
    uint8 private _executionRoute;

    function isValidatorInstalled(address module) public view returns (bool) {
        if (_installed[module]) return true;
        return module == LibCloneConfig.validator(LibCloneConfig.args()) && !_codeValidatorRemoved;
    }

    /// @dev The APPROVE scopes this account will grant, as a bitmask of APPROVE_PAYMENT |
    /// APPROVE_EXECUTION.
    function approvalScopes() public view returns (uint8) {
        uint8 s = _approvalScopes;
        return s != 0 ? s : LibCloneConfig.approvalScopes(LibCloneConfig.args());
    }

    /// @dev Whether this account authorizes a SENDER-frame shape.
    function isExecutionModeSupported(bytes32 mode) public view returns (bool) {
        uint8 o = _modeOverride[mode];
        if (o != 0) return o == MODE_SUPPORTED;
        return LibCloneConfig.modeBits(LibCloneConfig.args()) & LibERC8286.modeBit(mode) != 0;
    }

    event ApprovalScopesUpdated(uint8 approvalScopes);
    event ExecutionModeUpdated(bytes32 mode, bool supported);

    modifier onlySelf() {
        require(msg.sender == address(this), "unauthorized");
        _;
    }

    /// @dev A DEFAULT frame can also reach `verify` with caller == ENTRY_POINT, so the mode
    /// must be checked rather than assumed.
    modifier onlyVerifyFrame() {
        require(
            LibERC8286.frameModeOf(LibERC8286.currentFrameIndex()) == LibERC8286.MODE_VERIFY,
            "not a VERIFY frame"
        );
        _;
    }

    /// @dev Configuration always sets a non-empty approval scope, so an empty one means the
    /// account has not been initialized.
    modifier initializer() {
        require(approvalScopes() == LibERC8286.APPROVE_NONE, "already initialized");
        _;
    }

    /// @dev Frame validators are the only module type this account supports.
    modifier onlyFrameValidator(uint256 moduleTypeId) {
        require(moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR, "unsupported module type");
        _;
    }

    /// @dev `execute` exists only on the contract route; on the protocol route the protocol
    /// calls SENDER frames' targets itself and nothing should route through here.
    modifier onlyContractRoute() {
        require(executionRoute() == LibERC8286.EXECUTION_ROUTE_CONTRACT, "protocol-dispatched account");
        _;
    }

    modifier onlyExecuteMode(bytes32 mode) {
        require(_isExecuteMode(mode), "unsupported execution mode");
        _;
    }

    /// @dev Installs the first frame validator and sets the initial policy. Without an
    /// installed validator the account cannot approve anything, so it cannot install one
    /// later: `installModule` is `onlySelf`.
    constructor(
        address validator,
        bytes memory initData,
        uint8 approvalScopes_,
        bytes32[] memory executionModes_,
        uint8 executionRoute_
    ) {
        _initialize(validator, initData, approvalScopes_, executionModes_, executionRoute_);
    }

    /// @dev The proxy counterpart to the constructor. A proxy runs its implementation's
    /// constructor never -- that ran once, against the implementation's own storage -- so a
    /// cloned account is configured through here, delegatecalled from the proxy's
    /// constructor and therefore writing to the proxy's storage.
    function initialize(
        address validator,
        bytes calldata initData,
        uint8 approvalScopes_,
        bytes32[] calldata executionModes_,
        uint8 executionRoute_
    ) external initializer {
        _initialize(validator, initData, approvalScopes_, executionModes_, executionRoute_);
    }

    function _initialize(
        address validator,
        bytes memory initData,
        uint8 approvalScopes_,
        bytes32[] memory executionModes_,
        uint8 executionRoute_
    ) internal {
        require(validator != address(0), "validator required");
        require(executionModes_.length != 0, "no modes");
        require(executionRoute_ <= LibERC8286.EXECUTION_ROUTE_CONTRACT, "unknown execution route");
        _executionRoute = executionRoute_;
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
        _approvalScopes = approvalScopes_;
        emit ApprovalScopesUpdated(approvalScopes_);
    }

    /// @dev Adds or removes a SENDER-frame shape. The transaction carrying the change must
    /// itself present a shape the current setting still supports.
    function setExecutionMode(bytes32 mode, bool supported) external onlySelf {
        _setExecutionMode(mode, supported);
    }

    function _setExecutionMode(bytes32 mode, bool supported) internal {
        require(LibERC8286.isFrameMode(mode), "not a frame mode");
        _modeOverride[mode] = supported ? MODE_SUPPORTED : MODE_UNSUPPORTED;
        emit ExecutionModeUpdated(mode, supported);
    }

    /// @dev The account pays its own gas and SENDER frames spend from its balance, so it
    /// must be able to receive ETH.
    receive() external payable {}

    function verify(bytes calldata data)
        external
        override
        onlyVerifyFrame
        returns (uint8 approvalMode)
    {
        uint256 frameIndex = LibERC8286.currentFrameIndex();

        // EIP-8250: the validator is the address in nonce_keys[0], which is part of the
        // signed envelope, so selection is bound to the transaction. The whole VERIFY payload
        // belongs to the validator.
        address validator = LibERC8286.validatorFromNonceKey();
        require(validator != address(0), "no validator in nonce key");
        require(isValidatorInstalled(validator), "validator not installed");

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

        // ERC-8286 verify step 5: a contract-dispatched account approves execution only if
        // every SENDER frame resolves to itself, so that every operation passes through its
        // execute. One frame pointed elsewhere would run as tx.sender past the account's
        // logic, with the authority the approval grants to the whole transaction.
        if (
            (granted & LibERC8286.APPROVE_EXECUTION) != 0
                && executionRoute() == LibERC8286.EXECUTION_ROUTE_CONTRACT
                && !LibERC8286.allSenderFramesTargetSelf()
        ) {
            granted &= LibERC8286.APPROVE_PAYMENT;
        }

        require(granted != LibERC8286.APPROVE_NONE, "validation failed");
        require(supportsApprovalMode(granted), "unsupported approval mode");

        LibERC8286.approveScope(granted); // exits the frame
    }

    /// @dev True only for a mode whose bits are all set in `approvalScopes`. APPROVE_NONE is
    /// never supported: EIP-8141 rejects an APPROVE carrying scope 0.
    function supportsApprovalMode(uint8 approvalMode) public view override returns (bool) {
        return approvalMode != LibERC8286.APPROVE_NONE && approvalMode & ~approvalScopes() == 0;
    }

    /// @dev Chosen at creation. Protocol-dispatched (0x00): SENDER frames call their targets
    /// directly and `execute` is closed. Contract-dispatched (0x01): every SENDER frame must
    /// target this account and call `execute`, which `verify` enforces.
    function executionRoute() public view override returns (uint8) {
        if (LibCloneConfig.isClone()) return LibCloneConfig.executionRoute(LibCloneConfig.args());
        return _executionRoute;
    }

    /// @dev The contract route's entrypoint. A SENDER frame targeting this account arrives as a
    /// self-call, so `onlySelf` is the whole authorization: the VERIFY frame already approved
    /// execution for exactly this transaction's SENDER frames.
    function execute(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        override
        onlySelf
        onlyContractRoute
        onlyExecuteMode(mode)
    {
        if (mode == MODE_SINGLE) ERC7579Utils.execSingle(executionCalldata, ERC7579Utils.EXECTYPE_DEFAULT);
        else ERC7579Utils.execBatch(executionCalldata, ERC7579Utils.EXECTYPE_DEFAULT);
    }

    /// @dev No executor modules are supported.
    function executeFromExecutor(bytes32, bytes calldata) external payable override returns (bytes[] memory) {
        revert("no executor modules");
    }

    function _isExecuteMode(bytes32 mode) internal pure returns (bool) {
        return mode == MODE_SINGLE || mode == MODE_BATCH;
    }

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        override
        onlySelf
        onlyFrameValidator(moduleTypeId)
    {
        _installValidator(module, initData);
    }

    function _installValidator(address module, bytes memory initData) internal {
        require(!isValidatorInstalled(module), "already installed");
        _installed[module] = true;
        (bool ok,) = module.delegatecall(abi.encodeCall(IERC7579Module.onInstall, (initData)));
        require(ok, "install failed");
        emit ModuleInstalled(LibERC8286.MODULE_TYPE_FRAME_VALIDATOR, module);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        override
        onlySelf
        onlyFrameValidator(moduleTypeId)
    {
        require(isValidatorInstalled(module), "not installed");
        if (_installed[module]) _installed[module] = false;
        else _codeValidatorRemoved = true; // the code-configured validator
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
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR && isValidatorInstalled(module);
    }

    function accountId() external pure override returns (string memory) {
        return "erc8286.reference-frame-account.0.4.0";
    }

    // Two kinds of query (ERC-8286 "Execution"): the frame execution modes (callType 0x02 /
    // 0x03) say which SENDER-frame shapes the account authorizes at validation time; ERC-7579's
    // own execute modes say what `execute` can process, which is only something on the
    // contract route.
    function supportsExecutionMode(bytes32 encodedMode) public view override returns (bool) {
        if (_isExecuteMode(encodedMode)) return executionRoute() == LibERC8286.EXECUTION_ROUTE_CONTRACT;
        return isExecutionModeSupported(encodedMode);
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
