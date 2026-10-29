// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {Wots} from "../src/Wots.sol";

contract Signer {
    bytes32 public immutable skSeed;
    bytes16 public immutable pubSeed;
    uint256 public immutable realLeaves;
    bytes16 public root;
    bytes16[] internal leaves;

    constructor(bytes32 skSeed_, bytes16 pubSeed_, uint256 realLeaves_) {
        skSeed = skSeed_;
        pubSeed = pubSeed_;
        realLeaves = realLeaves_;
        for (uint256 i; i < Wots.LEAVES; ++i) {
            if (i < realLeaves_) leaves.push(leafPk(uint32(i)));
            else leaves.push(bytes16(keccak256(abi.encode("filler", skSeed_, i))));
        }
        bytes16[] memory level = leaves;
        for (uint256 h; h < Wots.HEIGHT; ++h) {
            bytes16[] memory up = new bytes16[](level.length / 2);
            for (uint256 i; i < up.length; ++i) up[i] = Wots.node(pubSeed_, h + 1, i, level[2 * i], level[2 * i + 1]);
            level = up;
        }
        root = level[0];
    }

    function secret(uint32 leaf, uint256 c) public view returns (bytes16) {
        return bytes16(keccak256(abi.encodePacked(skSeed, Wots.adrs(Wots.T_PRF, uint8(c), 0, leaf))));
    }

    function leafPk(uint32 leaf) public view returns (bytes16) {
        bytes16[18] memory pks;
        for (uint256 c; c < Wots.CHAINS; ++c) pks[c] = Wots.chain(pubSeed, leaf, c, secret(leaf, c), 0, 255);
        return Wots.leafFromPks(pubSeed, leaf, pks);
    }

    function path(uint32 leaf) public view returns (bytes memory out) {
        bytes16[] memory level = leaves;
        uint256 idx = leaf;
        for (uint256 h; h < Wots.HEIGHT; ++h) {
            out = bytes.concat(out, level[idx ^ 1]);
            bytes16[] memory up = new bytes16[](level.length / 2);
            for (uint256 i; i < up.length; ++i) up[i] = Wots.node(pubSeed, h + 1, i, level[2 * i], level[2 * i + 1]);
            level = up;
            idx >>= 1;
        }
    }

    function sign(uint32 leaf, bytes16 digest) public view returns (bytes memory proof) {
        require(leaf < realLeaves, "leaf has no secret in this test tree");
        uint256[18] memory d = Wots.digits(digest);
        for (uint256 c; c < Wots.CHAINS; ++c) proof = bytes.concat(proof, Wots.chain(pubSeed, leaf, c, secret(leaf, c), 0, d[c]));
        proof = bytes.concat(proof, path(leaf));
    }
}
