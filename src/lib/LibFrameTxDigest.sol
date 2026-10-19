// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {LibERC8286} from "./LibERC8286.sol";

/// @notice The EIP-712 message an owner or sponsor signs to approve a frame transaction:
/// the sender, the nonce, the EIP-8250 key set, and every SENDER frame.
/// @dev Shared by ECDSAFrameValidator and SphincsFrameValidator (domain = the account). A
/// paymaster with a sponsor signature would use it under its own domain, which is why
/// `verifyingContract` is a parameter. The VERIFY frame's own data is left out, since the signature travels
/// inside it and `sig_hash` would make that circular. `sender` binds the signature to one
/// transaction's sender, and the sender's nonce is consumed when payment is approved, so a
/// (sender, nonce) pair is signed over once whether the signer sends or only pays.
/// Every function is `internal` so it inlines into a validator reached by DELEGATECALL.
library LibFrameTxDigest {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ERC-8286 Frame Validator");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant FRAME_TYPEHASH =
        keccak256("Frame(address target,uint256 value,uint256 flags,bytes data)");
    bytes32 private constant FRAMETX_TYPEHASH = keccak256(
        "FrameTx(address sender,uint256 nonce,bytes32 nonceKeysHash,Frame[] frames)Frame(address target,uint256 value,uint256 flags,bytes data)"
    );

    /// @dev The EIP-712 domain separator for `verifyingContract`, as a wallet computes it.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, verifyingContract));
    }

    /// @dev The digest the signer of the executing transaction must have signed, under
    /// `verifyingContract`'s domain. Reads the transaction through EIP-8141 introspection.
    function digest(address verifyingContract) internal view returns (bytes32) {
        uint256 numFrames = LibERC8286.frameCount();
        bytes32[] memory frameHashes = new bytes32[](LibERC8286.senderFrameCount());
        uint256 k;
        for (uint256 i = 0; i < numFrames; i++) {
            if (LibERC8286.frameModeOf(i) != LibERC8286.MODE_SENDER) continue;
            frameHashes[k++] = keccak256(
                abi.encode(
                    FRAME_TYPEHASH,
                    LibERC8286.frameTarget(i),
                    LibERC8286.frameValue(i),
                    LibERC8286.frameFlags(i),
                    keccak256(LibERC8286.frameData(i))
                )
            );
        }
        // nonceKeysHash commits the EIP-8250 key set, so a validator selected from
        // nonce_keys[0] is signed over too.
        bytes32 structHash = keccak256(
            abi.encode(
                FRAMETX_TYPEHASH,
                LibERC8286.txSender(),
                LibERC8286.txNonce(),
                LibERC8286.nonceKeysHash(),
                keccak256(abi.encodePacked(frameHashes))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(verifyingContract), structHash));
    }

    /// @dev `ecrecover` over `digest(verifyingContract)` for a 65-byte r || s || v signature.
    /// Zero for malformed input or a failed recovery.
    function recover(address verifyingContract, bytes calldata signature) internal view returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest(verifyingContract), v, r, s);
    }
}
