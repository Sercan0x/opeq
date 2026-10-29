// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {OpeqAccount} from "./OpeqAccount.sol";

contract OpeqFactory {
    event Created(address indexed account, bytes16 pubSeed, bytes16 root);

    function salt(bytes16 pubSeed, bytes16 root) public pure returns (bytes32) {
        return keccak256(abi.encode("opeq/evm/id/v1", pubSeed, root));
    }

    function predict(bytes16 pubSeed, bytes16 root) public view returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(OpeqAccount).creationCode, abi.encode(pubSeed, root)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(pubSeed, root), code)))));
    }

    function create(bytes16 pubSeed, bytes16 root) external returns (address account) {
        account = predict(pubSeed, root);
        if (account.code.length > 0) return account;
        account = address(new OpeqAccount{salt: salt(pubSeed, root)}(pubSeed, root));
        emit Created(account, pubSeed, root);
    }
}
