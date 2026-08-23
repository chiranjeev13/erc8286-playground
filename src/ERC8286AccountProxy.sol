// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice An ERC8286FrameAccount deployed as an ERC-1967 proxy over a shared implementation.
/// @dev Nothing here but OpenZeppelin's proxy under a name of our own. It exists so the
/// account's creation code is a compiled artifact of this repository: the address of an
/// account is `CREATE2(EIP-7997 predeploy, salt, keccak256(creation code))`, so whatever
/// derives that address has to agree, byte for byte, on the code being deployed.
///
/// There is no factory contract. The [EIP-7997](https://eips.ethereum.org/EIPS/eip-7997)
/// deterministic-deployment predeploy at 0x4e59...956C is the factory: it takes
/// `salt(32) || initcode`, CREATE2s it, and mixes nothing about the caller into the address.
/// So an account is deployed either by calling that predeploy or, for an account paying for
/// the transaction that creates it, by an EIP-8141 `DEFAULT` frame that calls it -- and both
/// land on the same address. `scripts/lib/accounts.ts` derives it.
///
/// The constructor delegatecalls `_data`, which is `initialize` calldata, so an account's
/// configuration is written to the proxy's storage as it is deployed and is committed by its
/// address. Value must not be sent: `CREATE2` would pass it to this constructor, DELEGATECALL
/// preserves callvalue, and the module's non-payable `onInstall` would reject it. Fund the
/// account with a plain transfer instead -- before deployment, if it is paying its own way.
contract ERC8286AccountProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory initData)
        ERC1967Proxy(implementation, initData)
    {}
}
