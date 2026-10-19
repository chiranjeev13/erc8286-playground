// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Creates ERC-8286 accounts as EIP-1167 clones with their configuration appended to
/// their code (see LibCloneConfig). Nothing is written to storage at creation, which is what
/// lets an account be deployed by the first frame of the transaction it then approves and
/// pays for: 252,450 state gas for the clone plus 1,530 per configuration byte, inside the
/// 500,000 that an EIP-8141 deploy prefix may spend.
///
/// The address depends on the implementation, the configuration and the salt, and on this
/// factory, so it is known before anything is deployed and can be funded in advance.
contract ERC8286AccountFactory {
    event AccountCreated(address indexed account, address indexed implementation, bytes args, bytes32 salt);

    uint256 private constant HEADER_LEN = 23;

    /// @dev The whole configuration is committed by the address, and `args` is also what the
    /// account will read back, so a malformed configuration simply produces an unusable account.
    modifier wellFormed(address implementation, bytes calldata args) {
        require(implementation.code.length != 0, "no implementation");
        require(args.length >= HEADER_LEN, "config too short");
        require(address(bytes20(args[0:20])) != address(0), "validator required");
        require(uint8(args[20]) != 0, "no scopes");
        require(uint8(args[22]) <= 1, "unknown execution route");
        _;
    }

    /// @dev The same bytes OpenZeppelin's `cloneDeterministicWithImmutableArgs` deploys, so
    /// `predict` agrees with it. Deployed here with a bare CREATE2 rather than through
    /// `Create2.deploy`, whose balance check uses SELFBALANCE: this runs in an EIP-8141
    /// deploy frame, part of the validation prefix, where that opcode is banned.
    function createAccount(address implementation, bytes calldata args, bytes32 salt)
        external
        wellFormed(implementation, args)
        returns (address account)
    {
        bytes memory code = abi.encodePacked(
            hex"61",
            uint16(args.length + 0x2d),
            hex"3d81600a3d39f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            args
        );
        assembly ("memory-safe") {
            account := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(account != address(0), "create2 failed");
        emit AccountCreated(account, implementation, args, salt);
    }

    function predict(address implementation, bytes calldata args, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, args, salt);
    }
}
