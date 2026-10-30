// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {Wots} from "./Wots.sol";

contract OpeqAccount {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    bytes32 public constant TAG_EXEC = keccak256("opeq/evm/exec/v1");
    bytes32 public constant TAG_REKEY = keccak256("opeq/evm/rekey/v1");
    uint32 public constant REKEY_RESERVE = 16;
    uint32 public constant EXEC_LIMIT = uint32(Wots.LEAVES) - REKEY_RESERVE;
    uint256 public constant MAX_AHEAD = 1 hours;

    bytes16 public pubSeed;
    bytes16 public root;
    uint32 public next;
    uint32 public epoch;

    event Executed(uint32 indexed epoch, uint32 leaf, bytes16 digest);
    event Rekeyed(uint32 indexed epoch, bytes16 pubSeed, bytes16 root);

    error Expired();
    error TooFarAhead();
    error LeafUsed();
    error LeafOutOfRange();
    error BadSignature();
    error SameRoot();
    error NeedsRekey();
    error CallFailed(uint256 index, bytes reason);

    constructor(bytes16 pubSeed_, bytes16 root_) {
        pubSeed = pubSeed_;
        root = root_;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x150b7a02 || id == 0x4e2312e0;
    }

    function execDigest(Call[] calldata calls, uint32 leaf, uint64 deadline, uint32 salt, bytes16 rnd)
        public
        view
        returns (bytes16)
    {
        return bytes16(
            keccak256(
                abi.encode(rnd, TAG_EXEC, block.chainid, address(this), epoch, leaf, deadline, keccak256(abi.encode(calls)), salt)
            )
        );
    }

    function rekeyDigest(bytes16 newPubSeed, bytes16 newRoot, uint32 leaf, uint64 deadline, uint32 salt, bytes16 rnd)
        public
        view
        returns (bytes16)
    {
        return bytes16(
            keccak256(abi.encode(rnd, TAG_REKEY, block.chainid, address(this), epoch, leaf, deadline, newPubSeed, newRoot, salt))
        );
    }

    function execute(
        Call[] calldata calls,
        uint32 leaf,
        uint64 deadline,
        uint32 salt,
        bytes16 rnd,
        bytes calldata proof
    ) external {
        if (epoch == 0) revert NeedsRekey();
        _window(deadline);
        if (leaf < next) revert LeafUsed();
        if (leaf >= EXEC_LIMIT) revert LeafOutOfRange();
        bytes16 digest = execDigest(calls, leaf, deadline, salt, rnd);
        if (Wots.rootFromProof(pubSeed, leaf, digest, proof) != root) revert BadSignature();
        next = leaf + 1;
        emit Executed(epoch, leaf, digest);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    function rekey(
        bytes16 newPubSeed,
        bytes16 newRoot,
        uint32 leaf,
        uint64 deadline,
        uint32 salt,
        bytes16 rnd,
        bytes calldata proof
    ) external {
        if (epoch != 0) _window(deadline);
        if (leaf < next) revert LeafUsed();
        if (leaf >= Wots.LEAVES) revert LeafOutOfRange();
        if (newRoot == root) revert SameRoot();
        bytes16 digest = rekeyDigest(newPubSeed, newRoot, leaf, deadline, salt, rnd);
        if (Wots.rootFromProof(pubSeed, leaf, digest, proof) != root) revert BadSignature();
        pubSeed = newPubSeed;
        root = newRoot;
        next = 0;
        epoch += 1;
        emit Rekeyed(epoch, newPubSeed, newRoot);
    }

    function _window(uint64 deadline) private view {
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_AHEAD) revert TooFarAhead();
    }
}
