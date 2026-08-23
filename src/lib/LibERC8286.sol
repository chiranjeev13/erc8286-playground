// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

/// @notice Library for handling ERC-8286 approval modes, SENDER-frame execution modes, and
/// EIP-8141 frame introspection.
/// @dev Every function is `internal`, so it inlines into the caller. That matters here: a
/// validator module is reached by `DELEGATECALL` and runs inside the account's context, and
/// a library reached by `DELEGATECALL` of its own would break that. It also keeps the
/// introspection opcodes out of an external call during a `VERIFY` frame.
///
/// The introspection wrappers require a compiler that knows the EIP-8141 instructions, and
/// they halt exceptionally outside a type-0x06 frame transaction.
library LibERC8286 {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Cannot decode the VERIFY frame's validator payload.
    error DecodingError();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      APPROVAL MODES                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev No approval scope.
    uint8 internal constant APPROVE_NONE = 0x0;

    /// @dev The account approves paying the transaction's total gas cost.
    uint8 internal constant APPROVE_PAYMENT = 0x1;

    /// @dev The account approves subsequent frames acting on its behalf as `sender`.
    /// Only valid when the frame's resolved target is `tx.sender`.
    uint8 internal constant APPROVE_EXECUTION = 0x2;

    /// @dev Both payment and execution.
    uint8 internal constant APPROVE_EXECUTION_AND_PAYMENT = 0x3;

    /// @dev Mask of the two meaningful scope bits.
    uint8 internal constant APPROVE_SCOPE_MASK = 0x3;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        MODULE TYPES                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev ERC-8286 frame validator. Distinct from ERC-7579's `validateUserOp` validators
    /// (type id 1); a module may be both. Value TBD in the draft.
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

    /// @dev Exactly one SENDER frame. Extends ERC-7579's callType encoding.
    bytes1 internal constant CALLTYPE_FRAME_SINGLE = 0x02;

    /// @dev Multiple SENDER frames. Extends ERC-7579's callType encoding.
    bytes1 internal constant CALLTYPE_FRAME_BATCH = 0x03;

    /// @dev Revert-all: the frame belongs to an atomic-batch group.
    bytes1 internal constant EXECTYPE_DEFAULT = 0x00;

    /// @dev Try: the frame is not part of an atomic batch.
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

    /// @dev One bit per frame mode, so a *set* of modes fits in a single word.
    ///
    /// These are not the modes themselves: `FRAME_MODE_SINGLE` is the normative bytes32 that
    /// `supportsExecutionMode` accepts, while `FRAME_MODE_SINGLE_BIT` is this library's
    /// one-bit stand-in for it. Same shape, different representation, and only the bytes32
    /// form appears in the standard -- the bits are an implementation convenience for
    /// storing and comparing sets (see `presentedModeBits`).
    uint8 internal constant FRAME_MODE_SINGLE_BIT = 0x1;
    uint8 internal constant FRAME_MODE_SINGLE_ATOMIC_BIT = 0x2;
    uint8 internal constant FRAME_MODE_BATCH_BIT = 0x4;
    uint8 internal constant FRAME_MODE_BATCH_ATOMIC_BIT = 0x8;
    uint8 internal constant FRAME_MODE_BITS_MASK = 0xF;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      MODE OPERATIONS                       */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Encodes a frame mode per ERC-7579's mode layout: callType in byte 0, execType in
    /// byte 1, every remaining byte zero. Frame modes carry no selector or payload.
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

    /// @dev Returns the single bit identifying `mode`, or zero if `mode` is not one of the
    /// four frame modes.
    ///
    /// Compared as whole words, not callType and execType byte by byte: the layout reserves
    /// every remaining byte as zero, so a mode carrying a modeSelector or modePayload is a
    /// different mode. ERC-7579's own execute modes also return zero.
    function modeBit(bytes32 mode) internal pure returns (uint8) {
        if (mode == FRAME_MODE_SINGLE) return FRAME_MODE_SINGLE_BIT;
        if (mode == FRAME_MODE_SINGLE_ATOMIC) return FRAME_MODE_SINGLE_ATOMIC_BIT;
        if (mode == FRAME_MODE_BATCH) return FRAME_MODE_BATCH_BIT;
        if (mode == FRAME_MODE_BATCH_ATOMIC) return FRAME_MODE_BATCH_ATOMIC_BIT;
        return 0;
    }

    /// @dev Whether `mode` is one of the four frame modes.
    function isFrameMode(bytes32 mode) internal pure returns (bool) {
        return modeBit(mode) != 0;
    }

    /// @dev The mode a SENDER frame presents, given whether the transaction has more than
    /// one SENDER frame and whether this frame belongs to an atomic batch.
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

    /// @dev `TXPARAM(0x02)`: `tx.sender`.
    /// @dev Masked: assigning a full word to an address-typed variable in assembly does not
    /// clear the upper bits, and those bits would otherwise flow into anything that hashes
    /// or compares the result.
    function txSender() internal view returns (address result) {
        assembly {
            result := and(txparam(0x02), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @dev `TXPARAM(0x08)`: the canonical transaction signing hash.
    ///
    /// This hash commits the frame data verbatim, so a signature carried *in* frame data
    /// cannot sign over it -- that construction is a circular fixed point.
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

    /// @dev Whether frame `i` belongs to an atomic batch: it carries the flag itself (a
    /// member at positions i..j-1 of a group), or the preceding frame does (the terminating
    /// frame j of the group).
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

    /// @dev The set of modes the transaction's SENDER frames present, as a bitmask of
    /// FRAME_MODE_SINGLE_BIT | FRAME_MODE_SINGLE_ATOMIC_BIT | FRAME_MODE_BATCH_BIT | FRAME_MODE_BATCH_ATOMIC_BIT.
    ///
    /// A transaction can present several modes at once -- an atomic group alongside an
    /// ungrouped frame presents both BATCH_ATOMIC and BATCH -- so every SENDER frame
    /// contributes. Returns zero when there are no SENDER frames, i.e. nothing to authorize.
    ///
    /// An account supports the transaction's SENDER frames when
    /// `presentedModeBits() & ~supportedModes == 0`.
    function presentedModeBits() internal view returns (uint8 bits) {
        uint256 n = frameCount();
        bool batch = senderFrameCount() > 1;
        for (uint256 i = 0; i < n; i++) {
            if (frameModeOf(i) != MODE_SENDER) continue;
            bits |= modeBit(frameMode(batch, inAtomicBatch(i)));
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          APPROVE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev `APPROVE(0, 0, scope)`: commits `scope` and exits the frame successfully.
    ///
    /// Never returns. Note EIP-8141 reverts an `APPROVE_PAYMENT` while `sender_approved` is
    /// false: payment cannot precede the sender's execution approval.
    function approveScope(uint8 scope) internal {
        assembly {
            approve(0, 0, scope)
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                     VALIDATOR PAYLOAD                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Splits a VERIFY frame's payload into the selected validator and the
    /// validator-specific remainder: `validator(20) || data`.
    ///
    /// ERC-8286 does not dictate validator selection; this is the convention this reference
    /// account uses. Reverts if there is no room for an address.
    function decodeValidator(bytes calldata payload)
        internal
        pure
        returns (address validator, bytes calldata data)
    {
        if (payload.length < 20) revert DecodingError();
        validator = address(bytes20(payload[0:20]));
        data = payload[20:];
    }

    /// @dev Encodes a VERIFY frame payload: `validator(20) || data`.
    function encodeValidator(address validator, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(bytes20(validator), data);
    }
}
