// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice An account's initial configuration, read from its own bytecode.
///
/// Under EIP-8037 a fresh storage slot costs 97,920 state gas and an EIP-8141 deploy prefix
/// may spend 500,000 in total, nonce slot included. Creating any account costs 183,600 before
/// a single byte is written, so an account that deploys itself inside its first transaction
/// can afford at most one slot of initialization -- not enough for a validator, an owner, the
/// scopes and the modes. Code bytes cost 1,530 each, so the configuration goes there instead:
/// the account is an EIP-1167 clone with the configuration appended to its runtime code
/// (OpenZeppelin's immutable-args layout), and nothing is written to storage at creation.
///
/// Layout of the appended bytes:
///   validator (20) || approvalScopes (1) || modeBits (1) || executionRoute (1) || initData
///
/// modeBits: bit 0 single, bit 1 single-atomic, bit 2 batch, bit 3 batch-atomic.
/// executionRoute: 0x00 protocol-dispatched, 0x01 contract-dispatched (ERC-8286 "Execution").
/// initData is the validator's, any length.
///
/// Settings changed later are written to storage and take precedence; the code is the default.
/// An account deployed with its constructor (no clone) has no such bytes and behaves as before.
library LibCloneConfig {
    uint256 private constant CLONE_PREFIX_LEN = 10;
    bytes10 private constant CLONE_PREFIX = hex"363d3d373d3d3d363d73";
    uint256 private constant CLONE_CODE_LEN = 0x2d;
    uint256 private constant HEADER_LEN = 23;

    /// @dev Whether `address(this)` is an immutable-args clone carrying a configuration.
    function isClone() internal view returns (bool) {
        address self = address(this);
        uint256 size;
        assembly {
            size := extcodesize(self)
        }
        if (size < CLONE_CODE_LEN + HEADER_LEN) return false;
        bytes10 prefix;
        assembly {
            let p := mload(0x40)
            extcodecopy(self, p, 0, CLONE_PREFIX_LEN)
            prefix := mload(p)
        }
        return prefix == CLONE_PREFIX;
    }

    /// @dev The appended bytes, empty for a non-clone.
    function args() internal view returns (bytes memory) {
        if (!isClone()) return "";
        return Clones.fetchCloneArgs(address(this));
    }

    /// @dev Encodes a configuration as the factory expects it.
    function encode(address validator_, uint8 approvalScopes_, uint8 modeBits_, uint8 executionRoute_, bytes memory initData_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(validator_, approvalScopes_, modeBits_, executionRoute_, initData_);
    }

    function validator(bytes memory a) internal pure returns (address v) {
        if (a.length < HEADER_LEN) return address(0);
        assembly {
            v := shr(96, mload(add(a, 0x20)))
        }
    }

    function approvalScopes(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[20]);
    }

    function modeBits(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[21]);
    }

    function executionRoute(bytes memory a) internal pure returns (uint8) {
        return a.length < HEADER_LEN ? 0 : uint8(a[22]);
    }

    /// @dev The validator's share of the configuration: what `onInstall` would have received.
    function initData(bytes memory a) internal pure returns (bytes memory out) {
        if (a.length <= HEADER_LEN) return "";
        out = new bytes(a.length - HEADER_LEN);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = a[HEADER_LEN + i];
        }
    }
}
