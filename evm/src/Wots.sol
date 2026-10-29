// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

library Wots {
    uint256 internal constant N = 16;
    uint256 internal constant CHAINS = 18;
    uint256 internal constant HEIGHT = 10;
    uint256 internal constant LEAVES = 1 << HEIGHT;
    uint256 internal constant SIG_LEN = CHAINS * N;
    uint256 internal constant PROOF_LEN = SIG_LEN + HEIGHT * N;

    uint8 internal constant T_CHAIN = 0;
    uint8 internal constant T_LEAF = 1;
    uint8 internal constant T_NODE = 2;
    uint8 internal constant T_PRF = 3;

    error BadProofLength();

    function adrs(uint8 kind, uint8 a, uint8 b, uint32 idx) internal pure returns (bytes8) {
        return bytes8((uint64(kind) << 56) | (uint64(a) << 48) | (uint64(b) << 40) | uint64(idx));
    }

    function chain(bytes16 pubSeed, uint32 leaf, uint256 c, bytes16 x, uint256 start, uint256 steps)
        internal
        pure
        returns (bytes16 out)
    {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, pubSeed)
            mstore(add(p, 16), shl(192, or(shl(48, and(c, 0xff)), and(leaf, 0xffffffff))))
            mstore(add(p, 24), x)
            let q := add(p, 18)
            let r := add(p, 24)
            let end := add(start, steps)
            let pos := start
            for {} lt(add(pos, 3), end) { pos := add(pos, 4) } {
                mstore8(q, pos)
                mstore(r, keccak256(p, 40))
                mstore8(q, add(pos, 1))
                mstore(r, keccak256(p, 40))
                mstore8(q, add(pos, 2))
                mstore(r, keccak256(p, 40))
                mstore8(q, add(pos, 3))
                mstore(r, keccak256(p, 40))
            }
            for {} lt(pos, end) { pos := add(pos, 1) } {
                mstore8(q, pos)
                mstore(r, keccak256(p, 40))
            }
            out := and(mload(r), not(sub(shl(128, 1), 1)))
        }
    }

    function node(bytes16 pubSeed, uint256 height, uint256 index, bytes16 left, bytes16 right)
        internal
        pure
        returns (bytes16 out)
    {
        bytes8 a = adrs(T_NODE, uint8(height), 0, uint32(index));
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, pubSeed)
            mstore(add(p, 16), a)
            mstore(add(p, 24), left)
            mstore(add(p, 40), right)
            out := and(keccak256(p, 56), not(sub(shl(128, 1), 1)))
        }
    }

    function digits(bytes16 digest) internal pure returns (uint256[CHAINS] memory d) {
        uint256 csum;
        for (uint256 i; i < 16; ++i) {
            uint256 v = uint8(digest[i]);
            d[i] = v;
            csum += 255 - v;
        }
        d[16] = csum >> 8;
        d[17] = csum & 0xff;
    }

    function cost(bytes16 digest) internal pure returns (uint256 total) {
        uint256[CHAINS] memory d = digits(digest);
        for (uint256 i; i < CHAINS; ++i) total += 255 - d[i];
    }

    function leafFromPks(bytes16 pubSeed, uint32 leaf, bytes16[CHAINS] memory pks) internal pure returns (bytes16 out) {
        bytes8 a = adrs(T_LEAF, 0, 0, leaf);
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, pubSeed)
            mstore(add(p, 16), a)
            for { let i := 0 } lt(i, 18) { i := add(i, 1) } {
                mstore(add(add(p, 24), mul(i, 16)), mload(add(pks, mul(i, 32))))
            }
            out := and(keccak256(p, 312), not(sub(shl(128, 1), 1)))
        }
    }

    function rootFromProof(bytes16 pubSeed, uint32 leaf, bytes16 digest, bytes calldata proof)
        internal
        pure
        returns (bytes16 x)
    {
        if (proof.length != PROOF_LEN) revert BadProofLength();
        uint256[CHAINS] memory d = digits(digest);
        bytes16[CHAINS] memory pks;
        for (uint256 i; i < CHAINS; ++i) {
            bytes16 s = bytes16(proof[i * N:i * N + N]);
            pks[i] = chain(pubSeed, leaf, i, s, d[i], 255 - d[i]);
        }
        x = leafFromPks(pubSeed, leaf, pks);
        for (uint256 h; h < HEIGHT; ++h) {
            bytes16 sib = bytes16(proof[SIG_LEN + h * N:SIG_LEN + h * N + N]);
            uint256 idx = uint256(leaf) >> (h + 1);
            if ((leaf >> h) & 1 == 1) x = node(pubSeed, h + 1, idx, sib, x);
            else x = node(pubSeed, h + 1, idx, x, sib);
        }
    }
}
