// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.27;

import {IFrameValidator} from "./interfaces/IFrameValidator.sol";
import {LibERC8286} from "./lib/LibERC8286.sol";
import {LibFrameTxDigest} from "./lib/LibFrameTxDigest.sol";
import {LibCloneConfig} from "./lib/LibCloneConfig.sol";

interface ISphincsVerifier {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool);
}

/// @notice A hash-based (post-quantum) frame validator. The account approves a frame
/// transaction when it carries a SPHINCS signature, by the account's key, over `sig_hash`:
/// the canonical EIP-8141 signing hash, which commits the whole transaction. Nothing on this
/// path depends on an elliptic curve: forging an approval means breaking keccak256.
///
/// This is the kind of signer EIP-8141 was designed to make possible. The protocol checks
/// no signature of its own for a frame transaction; the account does, in a VERIFY frame,
/// with whatever scheme it installs. Swapping the validator is the whole migration.
///
/// The verifier is RivaLabs' experimental sphincs-g parameter set
/// (n=16 h=20 d=5 a=9 k=19 w=16, keccak256, 6,176-byte signatures), from
/// RivaLabs-Core/Post-Quantum-AA-Infra. It is not standardized SLH-DSA and is unaudited: demo only.
contract SphincsFrameValidator is IFrameValidator {
    /// @custom:storage-location erc7201:erc8286.module.sphincs-frame-validator
    struct Module_Layout {
        bytes32 pkSeed;
        bytes32 pkRoot;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("erc8286.module.sphincs-frame-validator")) - 1)) & ~0xff
    bytes32 private constant MODULE_SLOT =
        0x13be87145d8918acf8bd0fe085758eda945ae7d6045ca14ce964e4eef4fbcf00;

    uint256 private constant LOW_128 = type(uint128).max;
    /// @dev Signature length of the sphincs-g blob: R(16) + 19 FORS trees of 160 + 5 layers of 624.
    /// Kept here rather than imported, since pq/SphincsVerifier.sol compiles with its own
    /// (viaIR) settings and must stay out of this file's compilation job.
    uint256 private constant SPHINCS_V2_SIG_LEN = 6176;

    /// @dev Immutables live in code, so they survive the DELEGATECALL into this module.
    ISphincsVerifier public immutable VERIFIER;
    address private immutable SELF = address(this);

    error InvalidPublicKey();

    constructor(ISphincsVerifier verifier) {
        VERIFIER = verifier;
    }

    /// @dev The key: storage if `onInstall` ever ran, else the 32 bytes the account was cloned
    /// with -- pkSeed's 16 bytes then pkRoot's 16 bytes, packed -- if that configuration
    /// names this validator.
    function _key() private view returns (bytes32 pkSeed, bytes32 pkRoot) {
        Module_Layout storage l = _layout();
        if (l.pkRoot != bytes32(0)) return (l.pkSeed, l.pkRoot);
        bytes memory a = LibCloneConfig.args();
        if (LibCloneConfig.validator(a) != SELF) return (0, 0);
        bytes memory init = LibCloneConfig.initData(a);
        if (init.length < 32) return (0, 0);
        bytes32 packed = bytes32(init);
        return (packed & bytes32(~LOW_128), packed << 128);
    }

    function _layout() private pure returns (Module_Layout storage l) {
        bytes32 slot = MODULE_SLOT;
        assembly {
            l.slot := slot
        }
    }

    /// @dev Rejects a key that is not two 16-byte values in the top half of each word,
    /// which is also what the verifier insists on.
    modifier wellFormedKey(bytes32 pkSeed, bytes32 pkRoot) {
        if (pkRoot == bytes32(0) || uint256(pkSeed) & LOW_128 != 0 || uint256(pkRoot) & LOW_128 != 0) {
            revert InvalidPublicKey();
        }
        _;
    }

    /// @dev `data` is abi.encode(bytes32 pkSeed, bytes32 pkRoot). Writes to the account's storage.
    function onInstall(bytes calldata data) external override {
        require(data.length == 64, "public key required");
        (bytes32 pkSeed, bytes32 pkRoot) = abi.decode(data, (bytes32, bytes32));
        _setKey(pkSeed, pkRoot);
    }

    function onUninstall(bytes calldata) external override {
        delete _layout().pkSeed;
        delete _layout().pkRoot;
    }

    /// @dev Only `address(this)` is meaningful under DELEGATECALL.
    function publicKeyOf(address account) external view returns (bytes32 pkSeed, bytes32 pkRoot) {
        require(account == address(this), "not this account");
        return _key();
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == LibERC8286.MODULE_TYPE_FRAME_VALIDATOR;
    }

    /// @dev The frame a validator reads must target this account. Skipping the body leaves
    /// the named return at zero, i.e. APPROVE_NONE -- a failure, not a revert.
    modifier onlyTargetedFrame() {
        if (!LibERC8286.isTargetedFrame()) return;
        _;
    }

    /// @dev `data` names an `ARBITRARY` signature entry (see `LibFrameTxDigest.witness`)
    /// holding the 6,176-byte SPHINCS signature over `sig_hash`. No typed data: there is no
    /// wallet to show it to, and `sig_hash` already commits everything typed data would.
    function validateFrame(bytes calldata data)
        external
        view
        onlyTargetedFrame
        returns (uint8 approvalMode)
    {
        (bytes32 pkSeed, bytes32 pkRoot) = _key();
        bytes memory sig = LibFrameTxDigest.witness(data);
        if (pkRoot == bytes32(0) || sig.length != SPHINCS_V2_SIG_LEN) return LibERC8286.APPROVE_NONE;

        uint8 allowedScope = LibERC8286.allowedScope(LibERC8286.currentFrameIndex());

        // The verifier reverts on malformed input; that is a failed validation, not a bug.
        try VERIFIER.verify(pkSeed, pkRoot, LibERC8286.sigHash(), sig) returns (bool valid) {
            if (valid) return allowedScope; // account masks this with the frame's allowed scope
        } catch {}
        return LibERC8286.APPROVE_NONE;
    }

    function domainSeparator(address account) public view returns (bytes32) {
        return LibFrameTxDigest.domainSeparator(account);
    }

    function _setKey(bytes32 pkSeed, bytes32 pkRoot) private wellFormedKey(pkSeed, pkRoot) {
        Module_Layout storage l = _layout();
        l.pkSeed = pkSeed;
        l.pkRoot = pkRoot;
    }
}
