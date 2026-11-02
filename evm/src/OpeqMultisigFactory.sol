// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {OpeqMultisig} from "./OpeqMultisig.sol";

contract OpeqMultisigFactory {
    event Created(address indexed vault, address indexed creator, address[] owners, uint8 threshold);

    function salt(address creator, address[] calldata owners, uint8 threshold, bytes32 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode("opeq/evm/multisig/v1", creator, owners, threshold, nonce));
    }

    function predict(address creator, address[] calldata owners, uint8 threshold, bytes32 nonce)
        public
        view
        returns (address)
    {
        bytes32 code = keccak256(abi.encodePacked(type(OpeqMultisig).creationCode, abi.encode(owners, threshold)));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(creator, owners, threshold, nonce), code))))
        );
    }

    function create(address[] calldata owners, uint8 threshold, bytes32 nonce) external returns (address vault) {
        vault = address(new OpeqMultisig{salt: salt(msg.sender, owners, threshold, nonce)}(owners, threshold));
        emit Created(vault, msg.sender, owners, threshold);
    }
}
