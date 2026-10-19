// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.21;

import {LibERC8286} from "./lib/LibERC8286.sol";

/// @notice A paymaster that pays for any frame transaction whose pay frame reaches it. No
/// policy, no signature: whoever puts it in a VERIFY frame with allowed scope 0x1 gets their
/// gas paid from its balance. For demos and test networks only; on a real network its
/// balance would be drained within the block.
/// @dev The frame reads no storage, so the public mempool's rules for a non-canonical
/// paymaster are met (it admits one pending transaction per such paymaster at a time).
contract Paymaster {
    /// @dev Only for taking the balance back; immutable, so `pay` touches no storage.
    address public immutable owner;

    event Withdrawn(address indexed to, uint256 amount);

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @dev Must run as the target of a VERIFY frame, or APPROVE would revert anyway.
    modifier onlyVerifyFrame() {
        require(
            LibERC8286.frameModeOf(LibERC8286.currentFrameIndex()) == LibERC8286.MODE_VERIFY,
            "not a VERIFY frame"
        );
        _;
    }

    /// @dev Approves payment for the executing transaction, whatever it is. The frame's
    /// allowed scope must be exactly APPROVE_PAYMENT: this contract never approves execution.
    function pay() external onlyVerifyFrame {
        require(LibERC8286.allowedScope(LibERC8286.currentFrameIndex()) == LibERC8286.APPROVE_PAYMENT, "scope must be 0x1");
        LibERC8286.approveScope(LibERC8286.APPROVE_PAYMENT); // exits the frame
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount);
    }
}
