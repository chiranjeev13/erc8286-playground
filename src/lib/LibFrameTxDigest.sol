// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {LibERC8286} from "./LibERC8286.sol";

/// @notice What a frame validator's owner signs to approve a frame transaction, and where
/// that signature travels.
/// @dev The signature rides in an EIP-8141 `ARBITRARY` signature entry with empty `msg`, and
/// the VERIFY frame's data is only that entry's index. Those bytes are elided from `sig_hash`
/// (`TXPARAM(0x08)`), so the owner signs over `sig_hash`, which commits the whole transaction:
/// every frame verbatim (gas limits included), the fees, the nonce keys and the shape of the
/// signature list. Nothing can be rewrapped around a signature once it is made.
///
/// A hash-based key signs `sig_hash` itself. A wallet will not sign a bare 32-byte hash, so it
/// signs EIP-712 typed data carrying `sig_hash` beside a readable list of the SENDER frames:
/// the frames are for the person approving, `sig_hash` is what binds.
///
/// Shared by ECDSAFrameValidator and SphincsFrameValidator (domain = the account). A paymaster
/// with a sponsor signature would use it under its own domain, which is why
/// `verifyingContract` is a parameter. Every function is `internal` so it inlines into a
/// validator reached by DELEGATECALL.
library LibFrameTxDigest {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ERC-8286 Frame Validator");
    bytes32 private constant VERSION_HASH = keccak256("2");
    bytes32 private constant FRAME_TYPEHASH =
        keccak256("Frame(address target,uint256 value,uint256 flags,bytes data)");
    bytes32 private constant FRAMETX_TYPEHASH = keccak256(
        "FrameTx(address sender,uint256 nonce,bytes32 sigHash,Frame[] frames)Frame(address target,uint256 value,uint256 flags,bytes data)"
    );

    /// @dev The signature a VERIFY frame points at: `data` is `abi.encode(uint256 index)` into
    /// `tx.signatures`, and the entry must be `ARBITRARY`. Empty for anything else.
    function witness(bytes calldata data) internal view returns (bytes memory) {
        if (data.length != 32) return "";
        return LibERC8286.arbitrarySignature(abi.decode(data, (uint256)));
    }

    /// @dev The EIP-712 domain separator for `verifyingContract`, as a wallet computes it.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, verifyingContract));
    }

    /// @dev The typed-data digest a wallet signs for the executing transaction, under
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
        bytes32 structHash = keccak256(
            abi.encode(
                FRAMETX_TYPEHASH,
                LibERC8286.txSender(),
                LibERC8286.txNonce(),
                LibERC8286.sigHash(),
                keccak256(abi.encodePacked(frameHashes))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(verifyingContract), structHash));
    }

    /// @dev `ecrecover` over `digest(verifyingContract)` for a 65-byte r || s || v signature.
    /// Zero for malformed input or a failed recovery.
    function recover(address verifyingContract, bytes memory signature) internal view returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        return ecrecover(digest(verifyingContract), v, r, s);
    }
}
