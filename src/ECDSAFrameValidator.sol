// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibFrameTxDigest} from "./lib/LibFrameTxDigest.sol";
import {LibCloneConfig} from "./lib/LibCloneConfig.sol";

contract ECDSAFrameValidator is IFrameValidator {
    // Serves only the EIP-8141 frame flow, not ERC-7579's validateUserOp.

    /// @custom:storage-location erc7201:erc8286.module.ecdsa-frame-validator
    struct Module_Layout {
        address owner;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("erc8286.module.ecdsa-frame-validator")) - 1))
    bytes32 private constant MODULE_SLOT =
        0x27aa2c0bccf1b67327dd8bf7c4c5cb600687106028be01b120c11c42f5ff9d00;

    /// @dev This module's own address. An immutable survives DELEGATECALL, where
    /// `address(this)` is the account, so it is how the module recognises a code
    /// configuration addressed to it.
    address private immutable SELF = address(this);

    /// @dev The owner: storage if `onInstall` ever ran, else the 20 bytes the account was
    /// cloned with, provided that configuration names this validator.
    function _owner() private view returns (address) {
        address stored = _layout().owner;
        if (stored != address(0)) return stored;
        bytes memory a = LibCloneConfig.args();
        if (LibCloneConfig.validator(a) != SELF) return address(0);
        bytes memory init = LibCloneConfig.initData(a);
        if (init.length < 20) return address(0);
        return address(bytes20(init));
    }

    function _layout() private pure returns (Module_Layout storage l) {
        bytes32 slot = MODULE_SLOT;
        assembly {
            l.slot := slot
        }
    }

    /// @dev `data` is the owner's 20-byte address. Writes to the account's storage.
    function onInstall(bytes calldata data) external override {
        require(data.length >= 20, "owner required");
        address owner_ = address(bytes20(data[0:20]));
        require(owner_ != address(0), "owner required");
        _layout().owner = owner_;
    }

    function onUninstall(bytes calldata) external override {
        delete _layout().owner;
    }

    /// @dev Only `address(this)` is meaningful under DELEGATECALL.
    function ownerOf(address account) external view returns (address) {
        require(account == address(this), "not this account");
        return _owner();
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    /// @dev The frame a validator reads must target this account, whether the account is the
    /// transaction's sender or only its payer. Skipping the body leaves the named return at
    /// zero, i.e. APPROVE_NONE -- a failure, not a revert, as the spec asks.
    modifier onlyTargetedFrame() {
        if (!LibERC8286.isTargetedFrame()) return;
        _;
    }

    function validateFrame(bytes calldata data)
        external
        view
        onlyTargetedFrame
        returns (uint8 approvalMode)
    {
        address owner = _owner();
        if (owner == address(0)) return LibERC8286.APPROVE_NONE;

        // Read the executing frame's allowance rather than trusting a supplied value.
        uint8 allowedScope = LibERC8286.allowedScope(LibERC8286.currentFrameIndex());

        // The message binds the sender, so a signature given for this account's own
        // transaction cannot be replayed to make it pay for another account's.
        address signer = LibFrameTxDigest.recover(address(this), data);
        if (signer != address(0) && signer == owner) {
            return allowedScope; // account masks this with the frame's allowed scope
        }
        return LibERC8286.APPROVE_NONE;
    }

    /// @dev The EIP-712 domain separator for `account`, as a wallet would compute it.
    function domainSeparator(address account) public view returns (bytes32) {
        return LibFrameTxDigest.domainSeparator(account);
    }
}
