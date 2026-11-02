// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {Asserts, MockToken} from "./Harness.sol";
import {Signer} from "./Signer.sol";
import {OpeqAccount} from "../src/OpeqAccount.sol";
import {OpeqFactory} from "../src/OpeqFactory.sol";
import {OpeqMultisig} from "../src/OpeqMultisig.sol";
import {OpeqMultisigFactory} from "../src/OpeqMultisigFactory.sol";

contract OpeqMultisigTest is Asserts {
    OpeqFactory factory;
    OpeqMultisigFactory msFactory;
    OpeqAccount[3] acc;
    Signer[3] keys;
    uint32[3] nextLeaf;
    OpeqMultisig vault;
    address bob = address(0xB0B);
    bytes16 constant RND = bytes16(keccak256("rnd"));

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new OpeqFactory();
        msFactory = new OpeqMultisigFactory();
        for (uint256 i; i < 3; ++i) {
            Signer id = new Signer(keccak256(abi.encode("words", i)), bytes16(keccak256(abi.encode("seed", i))), 1);
            acc[i] = OpeqAccount(payable(factory.create(id.pubSeed(), id.root())));
            keys[i] = new Signer(keccak256(abi.encode("chain", i)), bytes16(keccak256(abi.encode("chain seed", i))), 8);
            uint64 deadline = uint64(block.timestamp + 600);
            bytes16 digest = acc[i].rekeyDigest(keys[i].pubSeed(), keys[i].root(), 0, deadline, 0, RND);
            acc[i].rekey(keys[i].pubSeed(), keys[i].root(), 0, deadline, 0, RND, id.sign(0, digest));
            vm.deal(address(acc[i]), 1 ether);
        }
        address[] memory owners = _owners();
        _as(0, address(msFactory), abi.encodeCall(OpeqMultisigFactory.create, (owners, 2, bytes32(0))), "create 2-of-3 vault");
        vault = OpeqMultisig(payable(msFactory.predict(address(acc[0]), owners, 2, bytes32(0))));
        assertTrue(address(vault).code.length > 0, "vault deployed at predicted address");
        vm.deal(address(vault), 5 ether);
    }

    function _owners() internal view returns (address[] memory o) {
        o = new address[](3);
        for (uint256 i; i < 3; ++i) o[i] = address(acc[i]);
    }

    function digestOf(OpeqAccount a, OpeqAccount.Call[] calldata calls, uint32 leaf, uint64 deadline)
        external
        view
        returns (bytes16)
    {
        return a.execDigest(calls, leaf, deadline, 0, RND);
    }

    function _as(uint256 who, address to, bytes memory data, string memory label) internal {
        OpeqAccount.Call[] memory calls = new OpeqAccount.Call[](1);
        calls[0] = OpeqAccount.Call({to: to, value: 0, data: data});
        uint32 leaf = nextLeaf[who]++;
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = keys[who].sign(leaf, this.digestOf(acc[who], calls, leaf, deadline));
        uint256 g = gasleft();
        acc[who].execute(calls, leaf, deadline, 0, RND, proof);
        if (bytes(label).length > 0) emit Gas(label, g - gasleft());
    }

    function _try(uint256 who, address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        OpeqAccount.Call[] memory calls = new OpeqAccount.Call[](1);
        calls[0] = OpeqAccount.Call({to: to, value: 0, data: data});
        uint32 leaf = nextLeaf[who];
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = keys[who].sign(leaf, this.digestOf(acc[who], calls, leaf, deadline));
        (ok, ret) = address(acc[who]).call(abi.encodeCall(OpeqAccount.execute, (calls, leaf, deadline, 0, RND, proof)));
    }

    function _pay(address to, uint256 amount) internal pure returns (OpeqMultisig.Call[] memory c) {
        c = new OpeqMultisig.Call[](1);
        c[0] = OpeqMultisig.Call({to: to, value: amount, data: ""});
    }

    function _propose(uint256 who, OpeqMultisig.Call[] memory c) internal returns (uint256 id) {
        id = vault.proposalCount();
        _as(who, address(vault), abi.encodeCall(OpeqMultisig.propose, (c, uint64(block.timestamp + 1 days))), "propose");
    }

    function _innerError(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4 + 32 * 3) return bytes4(0);
        bytes memory inner;
        assembly {
            inner := add(ret, 100)
        }
        if (inner.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(inner, 32))
        }
    }

    function testVaultSetup() public view {
        assertEq(vault.threshold(), 2, "threshold");
        assertEq(vault.getOwners().length, 3, "owners");
        for (uint256 i; i < 3; ++i) assertTrue(vault.isOwner(address(acc[i])), "owner registered");
        assertTrue(address(acc[0]).codehash == vault.ACCOUNT_CODEHASH(), "owner code is an OPEQ account");
    }

    function testTwoOfThreePays() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (, , uint256 n, bool live) = vault.getProposal(id);
        assertEq(n, 1, "proposer approval counts");
        assertTrue(live, "live after propose");
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "approve");
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))), "execute 1 ETH transfer");
        assertEq(bob.balance, 1 ether, "bob paid");
        assertEq(address(vault).balance, 4 ether, "vault debited");
        (OpeqMultisig.Proposal memory p, , , bool live2) = vault.getProposal(id);
        assertTrue(p.executed && !live2, "marked executed");
    }

    function testOneApprovalIsNotEnough() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (bool ok, bytes memory ret) = _try(0, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotEnoughApprovals.selector, "needs two approvals");
        assertEq(bob.balance, 0, "nothing paid");
    }

    function testExecuteTwiceFails() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))), "");
        (bool ok, bytes memory ret) = _try(2, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotLive.selector, "replay refused");
        assertEq(bob.balance, 1 ether, "paid once");
    }

    function testCallsMustMatchProposal() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 5 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.CallsMismatch.selector, "different calls refused");
    }

    function testOutsidersAndEoasAreRefused() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        vm.prank(bob);
        vm.expectRevert(OpeqMultisig.NotOwner.selector);
        vault.approve(id);
        vm.prank(bob);
        vm.expectRevert(OpeqMultisig.NotOwner.selector);
        vault.propose(_pay(bob, 1 ether), uint64(block.timestamp + 1 days));
        vm.expectRevert(OpeqMultisig.NotSelf.selector);
        vault.setThreshold(1);
    }

    function testOwnersMustBeOpeqAccounts() public {
        address[] memory o = _owners();
        o[2] = bob;
        vm.expectRevert(abi.encodeWithSelector(OpeqMultisig.NotOpeqAccount.selector, bob));
        new OpeqMultisig(o, 2);
        o[2] = address(vault);
        vm.expectRevert(abi.encodeWithSelector(OpeqMultisig.NotOpeqAccount.selector, address(vault)));
        new OpeqMultisig(o, 2);
        o = _owners();
        o[2] = o[0];
        vm.expectRevert(abi.encodeWithSelector(OpeqMultisig.DuplicateOwner.selector, o[0]));
        new OpeqMultisig(o, 2);
        vm.expectRevert(OpeqMultisig.BadThreshold.selector);
        new OpeqMultisig(_owners(), 4);
        vm.expectRevert(OpeqMultisig.BadThreshold.selector);
        new OpeqMultisig(_owners(), 0);
        vm.expectRevert(OpeqMultisig.BadOwnerCount.selector);
        new OpeqMultisig(new address[](0), 1);
    }

    function testRevokeDropsApproval() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.revoke, (id)), "revoke");
        assertEq(vault.approvalCount(id), 1, "back to one");
        (bool ok, bytes memory ret) = _try(0, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotEnoughApprovals.selector, "revoked approval does not count");
    }

    function testProposerCanCancel() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.cancel, (id)));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotProposer.selector, "only the proposer cancels");
        _as(0, address(vault), abi.encodeCall(OpeqMultisig.cancel, (id)), "cancel");
        (ok, ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotLive.selector, "cancelled proposal is dead");
    }

    function testExpiredProposalIsDead() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        vm.warp(block.timestamp + 1 days + 1);
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotLive.selector, "expired");
        (ok, ret) = _try(0, address(vault), abi.encodeCall(OpeqMultisig.propose, (_pay(bob, 1), uint64(block.timestamp + 31 days))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.BadExpiry.selector, "lifetime capped at 30 days");
    }

    function testOwnerChangeKillsPendingProposals() public {
        uint256 pay = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (pay)), "");
        address[] memory two = new address[](2);
        two[0] = address(acc[0]);
        two[1] = address(acc[1]);
        OpeqMultisig.Call[] memory c = new OpeqMultisig.Call[](1);
        c[0] = OpeqMultisig.Call({to: address(vault), value: 0, data: abi.encodeCall(OpeqMultisig.setOwners, (two, 2))});
        uint256 change = _propose(0, c);
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (change)), "");
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (change, c)), "execute owner change");
        assertTrue(!vault.isOwner(address(acc[2])), "owner removed");
        assertEq(vault.getOwners().length, 2, "two owners left");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (pay, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotLive.selector, "approvals from the old owner set are void");
        (ok, ret) = _try(2, address(vault), abi.encodeCall(OpeqMultisig.propose, (_pay(bob, 1), uint64(block.timestamp + 1 days))));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.NotOwner.selector, "removed owner locked out");
    }

    function testRevertedCallLeavesProposalExecutable() public {
        OpeqMultisig.Call[] memory c = _pay(bob, 50 ether);
        uint256 id = _propose(0, c);
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, c)));
        assertTrue(!ok && _innerError(ret) == OpeqMultisig.CallFailed.selector, "call fails without funds");
        (OpeqMultisig.Proposal memory p, , , bool live) = vault.getProposal(id);
        assertTrue(!p.executed && live, "still pending after a failed run");
        vm.deal(address(vault), 60 ether);
        _as(1, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, c)), "");
        assertEq(bob.balance, 50 ether, "paid once funded");
    }

    function testTokenTransfer() public {
        MockToken t = new MockToken();
        t.mint(address(vault), 1000);
        OpeqMultisig.Call[] memory c = new OpeqMultisig.Call[](1);
        c[0] = OpeqMultisig.Call({to: address(t), value: 0, data: abi.encodeCall(MockToken.transfer, (bob, 400))});
        uint256 id = _propose(2, c);
        _as(0, address(vault), abi.encodeCall(OpeqMultisig.approve, (id)), "");
        _as(0, address(vault), abi.encodeCall(OpeqMultisig.execute, (id, c)), "execute token transfer");
        assertEq(t.balanceOf(bob), 400, "token sent");
    }

    function testFrontRunCreateCannotTakeAddress() public {
        address[] memory owners = _owners();
        address want = msFactory.predict(address(acc[1]), owners, 2, bytes32(uint256(7)));
        vm.prank(bob);
        address got = msFactory.create(owners, 2, bytes32(uint256(7)));
        assertTrue(got != want, "a different creator lands on a different address");
    }
}
