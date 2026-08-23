// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

/// @notice ERC-8286 approval modes, SENDER-frame execution modes, and EIP-8141 frame
/// introspection.
/// @dev All functions are `internal`. The introspection wrappers need an EIP-8141-aware
/// compiler and halt exceptionally outside a type-0x06 frame transaction.
library LibERC8286 {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      APPROVAL MODES                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev No approval scope.
    uint8 internal constant APPROVE_NONE = 0x0;

    /// @dev The account approves paying the transaction's total gas cost.
    uint8 internal constant APPROVE_PAYMENT = 0x1;

    /// @dev Approves later frames acting as `tx.sender`. Requires the frame's resolved
    /// target to be `tx.sender`.
    uint8 internal constant APPROVE_EXECUTION = 0x2;

    /// @dev Both payment and execution.
    uint8 internal constant APPROVE_EXECUTION_AND_PAYMENT = 0x3;

    /// @dev Mask of the two meaningful scope bits.
    uint8 internal constant APPROVE_SCOPE_MASK = 0x3;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        MODULE TYPES                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev ERC-8286 frame validator module type id (TBD in the draft).
    uint256 internal constant MODULE_TYPE_FRAME_VALIDATOR = 11;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        FRAME MODES                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev EIP-8141 frame modes, as returned by `FRAMEPARAM(i, 0x02)`.
    uint256 internal constant MODE_DEFAULT = 0;
    uint256 internal constant MODE_VERIFY = 1;
    uint256 internal constant MODE_SENDER = 2;
    uint256 internal constant MODE_POST_TX = 3;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     EXECUTION MODES                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:°.´:•˚°.*°.˚:*.´+°.•*.+°.•°:´*.•*/

    /// @dev Exactly one SENDER frame.
    bytes1 internal constant CALLTYPE_FRAME_SINGLE = 0x02;

    /// @dev Multiple SENDER frames.
    bytes1 internal constant CALLTYPE_FRAME_BATCH = 0x03;

    /// @dev Revert-all: the frame is an atomic-batch member.
    bytes1 internal constant EXECTYPE_DEFAULT = 0x00;

    /// @dev Try: the frame is not in an atomic batch.
    bytes1 internal constant EXECTYPE_TRY = 0x01;

    /// @dev One standalone SENDER frame.
    bytes32 internal constant FRAME_MODE_SINGLE =
        0x0201000000000000000000000000000000000000000000000000000000000000;

    /// @dev One SENDER frame inside an atomic batch.
    bytes32 internal constant FRAME_MODE_SINGLE_ATOMIC =
        0x0200000000000000000000000000000000000000000000000000000000000000;

    /// @dev Multiple SENDER frames, reverting independently.
    bytes32 internal constant FRAME_MODE_BATCH =
        0x0301000000000000000000000000000000000000000000000000000000000000;

    /// @dev Multiple SENDER frames in an atomic batch.
    bytes32 internal constant FRAME_MODE_BATCH_ATOMIC =
        0x0300000000000000000000000000000000000000000000000000000000000000;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      MODE OPERATIONS                       */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Encodes a mode per ERC-7579's layout: callType in byte 0, execType in byte 1,
    /// every remaining byte zero.
    function encodeFrameMode(bytes1 callType, bytes1 execType)
        internal
        pure
        returns (bytes32 result)
    {
        assembly {
            result := or(shl(248, byte(0, callType)), shl(240, byte(0, execType)))
        }
    }

    /// @dev Returns the call type of the mode.
    function getCallType(bytes32 mode) internal pure returns (bytes1) {
        return bytes1(mode);
    }

    /// @dev Returns the exec type of the mode.
    function getExecType(bytes32 mode) internal pure returns (bytes1) {
        return mode[1];
    }

    /// @dev Whether `mode` is exactly one of the four frame modes. A mode carrying a
    /// modeSelector or modePayload is not.
    function isFrameMode(bytes32 mode) internal pure returns (bool) {
        return mode == FRAME_MODE_SINGLE || mode == FRAME_MODE_SINGLE_ATOMIC
            || mode == FRAME_MODE_BATCH || mode == FRAME_MODE_BATCH_ATOMIC;
    }

    /// @dev The mode for the given (batch, atomic) pair.
    function frameMode(bool batch, bool atomic) internal pure returns (bytes32) {
        if (atomic) return batch ? FRAME_MODE_BATCH_ATOMIC : FRAME_MODE_SINGLE_ATOMIC;
        return batch ? FRAME_MODE_BATCH : FRAME_MODE_SINGLE;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                  TRANSACTION INTROSPECTION                 */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev `TXPARAM(0x01)`: the transaction's nonce.
    function txNonce() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x01)
        }
    }

    /// @dev `TXPARAM(0x02)`: `tx.sender`. Masked, since assembly assignment to an address
    /// does not clear the upper bits.
    function txSender() internal view returns (address result) {
        assembly {
            result := and(txparam(0x02), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @dev `TXPARAM(0x08)`: the canonical signing hash. Commits frame data verbatim, so a
    /// signature carried in frame data cannot sign over it.
    function sigHash() internal view returns (bytes32 result) {
        assembly {
            result := txparam(0x08)
        }
    }

    /// @dev `TXPARAM(0x09)`: the number of frames.
    function frameCount() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x09)
        }
    }

    /// @dev `TXPARAM(0x0A)`: the index of the executing frame.
    function currentFrameIndex() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x0a)
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                  KEYED NONCES (EIP-8250)                   */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev `TXPARAM(0x0C)`: the sender's pre-state legacy nonce.
    function legacyNonce() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x0c)
        }
    }

    /// @dev `TXPARAM(0x0D)`: `len(tx.nonce_keys)`.
    function nonceKeyCount() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x0d)
        }
    }

    /// @dev `TXPARAM(0x0E)`: `keccak256(be32(len) || be32(k0) || ...)` over the key set.
    function nonceKeysHash() internal view returns (bytes32 result) {
        assembly {
            result := txparam(0x0e)
        }
    }

    /// @dev `TXPARAM(0x10)`: `tx.nonce_keys[0]`. Key `0` is the linear nonce; any other key
    /// has its own sequence in the `NONCE_MANAGER` predeploy.
    function nonceKey0() internal view returns (uint256 result) {
        assembly {
            result := txparam(0x10)
        }
    }

    /// @dev The validator address in `nonce_keys[0]`. Zero for key `0`, and for any key with
    /// bits above the low 160.
    function validatorFromNonceKey() internal view returns (address) {
        uint256 key = nonceKey0();
        if (key == 0 || key >> 160 != 0) return address(0);
        return address(uint160(key));
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     FRAME INTROSPECTION                    */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev `FRAMEPARAM(i, 0x00)`: the frame's resolved target (`tx.sender` if empty).
    function frameTarget(uint256 i) internal view returns (address result) {
        assembly {
            result := and(frameparam(i, 0x00), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @dev `FRAMEPARAM(i, 0x02)`: the frame's mode.
    function frameModeOf(uint256 i) internal view returns (uint256 result) {
        assembly {
            result := frameparam(i, 0x02)
        }
    }

    /// @dev `FRAMEPARAM(i, 0x03)`: the frame's flags.
    function frameFlags(uint256 i) internal view returns (uint256 result) {
        assembly {
            result := frameparam(i, 0x03)
        }
    }

    /// @dev `FRAMEPARAM(i, 0x04)`: `len(frame.data)`.
    function frameDataLength(uint256 i) internal view returns (uint256 result) {
        assembly {
            result := frameparam(i, 0x04)
        }
    }

    /// @dev `FRAMEPARAM(i, 0x06)`: the frame's allowed approval scope.
    function allowedScope(uint256 i) internal view returns (uint8) {
        uint256 result;
        assembly {
            result := frameparam(i, 0x06)
        }
        return uint8(result) & APPROVE_SCOPE_MASK;
    }

    /// @dev `FRAMEPARAM(i, 0x07)`: whether the frame carries the atomic-batch flag.
    function atomicBatchFlag(uint256 i) internal view returns (bool result) {
        uint256 flag;
        assembly {
            flag := frameparam(i, 0x07)
        }
        return flag == 1;
    }

    /// @dev `FRAMEPARAM(i, 0x08)`: the frame's value.
    function frameValue(uint256 i) internal view returns (uint256 result) {
        assembly {
            result := frameparam(i, 0x08)
        }
    }

    /// @dev `FRAMEDATACOPY`: the frame's data.
    function frameData(uint256 i) internal view returns (bytes memory data) {
        uint256 len = frameDataLength(i);
        data = new bytes(len);
        assembly ("memory-safe") {
            framedatacopy(add(data, 0x20), 0, len, i)
        }
    }

    /// @dev Whether frame `i` is in an atomic batch: it carries the flag, or frame `i - 1`
    /// does (the group's terminating frame).
    function inAtomicBatch(uint256 i) internal view returns (bool) {
        if (atomicBatchFlag(i)) return true;
        if (i == 0) return false;
        return atomicBatchFlag(i - 1);
    }

    /// @dev The number of SENDER frames in the transaction.
    function senderFrameCount() internal view returns (uint256 count) {
        uint256 n = frameCount();
        for (uint256 i = 0; i < n; i++) {
            if (frameModeOf(i) == MODE_SENDER) count++;
        }
    }

    /// @dev The mode SENDER frame `i` presents. `batch` is `senderFrameCount() > 1`, taken
    /// as a parameter so a caller walking every frame computes it once.
    function presentedMode(uint256 i, bool batch) internal view returns (bytes32) {
        return frameMode(batch, inAtomicBatch(i));
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          APPROVE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev `APPROVE(0, 0, scope)`: commits `scope` and exits the frame. Never returns.
    /// Reverts on `APPROVE_PAYMENT` while `sender_approved` is false.
    function approveScope(uint8 scope) internal {
        assembly {
            approve(0, 0, scope)
        }
    }
}
