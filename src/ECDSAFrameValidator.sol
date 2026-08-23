// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";

contract ECDSAFrameValidator is IFrameValidator {
    // Serves only the EIP-8141 frame flow, not ERC-7579's validateUserOp.

    /// @custom:storage-location erc7201:erc8286.module.ecdsa-frame-validator
    struct Module_Layout {
        address owner;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("erc8286.module.ecdsa-frame-validator")) - 1))
    bytes32 private constant MODULE_SLOT =
        0x27aa2c0bccf1b67327dd8bf7c4c5cb600687106028be01b120c11c42f5ff9d00;

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
        return _layout().owner;
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    function validateFrame(bytes calldata data) external view returns (uint8 approvalMode) {
        if (data.length != 65) return LibERC8286.APPROVE_NONE; // data: r(32) || s(32) || v(1)

        address owner = _layout().owner;
        if (owner == address(0)) return LibERC8286.APPROVE_NONE;

        // Read the executing frame's allowance rather than trusting a supplied value.
        uint8 allowedScope = LibERC8286.allowedScope(LibERC8286.currentFrameIndex());

        bytes32 r = bytes32(data[0:32]);
        bytes32 s = bytes32(data[32:64]);
        uint8 v = uint8(data[64]);

        address signer = ecrecover(_authDigest(), v, r, s);
        if (signer != address(0) && signer == owner) {
            return allowedScope; // account masks this with the frame's allowed scope
        }
        return LibERC8286.APPROVE_NONE;
    }

    // The digest covers chain id, nonce, sender, the nonce-key set, and the SENDER frames --
    // not the VERIFY frame's own data, which TXPARAM(0x08) would make circular.
    function _authDigest() internal view returns (bytes32) {
        uint256 numFrames = LibERC8286.frameCount();
        // nonceKeysHash commits the EIP-8250 key set, so a validator selected from
        // nonce_keys[0] is signed over too.
        bytes memory preimage = abi.encodePacked(
            block.chainid,
            LibERC8286.txNonce(),
            uint256(uint160(LibERC8286.txSender())),
            LibERC8286.nonceKeysHash()
        );

        for (uint256 i = 0; i < numFrames; i++) {
            if (LibERC8286.frameModeOf(i) != LibERC8286.MODE_SENDER) continue;
            // dataLen included so adjacent frames' calldata cannot collide
            uint256 dataLen = LibERC8286.frameDataLength(i);
            preimage = abi.encodePacked(
                preimage,
                uint256(uint160(LibERC8286.frameTarget(i))),
                LibERC8286.frameValue(i),
                LibERC8286.frameFlags(i),
                dataLen,
                LibERC8286.frameData(i)
            );
        }

        return keccak256(preimage);
    }
}
