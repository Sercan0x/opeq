// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {Asserts} from "./Harness.sol";
import {Fixture} from "./Fixture.sol";
import {OpeqAccount} from "../src/OpeqAccount.sol";

contract InteropTest is Asserts {
    OpeqAccount account;
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xCA401);

    function setUp() public {
        vm.warp(Fixture.NOW);
        account = new OpeqAccount(Fixture.PUB_SEED, Fixture.ROOT);
        vm.deal(address(account), 10 ether);
    }

    function _call(bytes memory data) internal returns (bool ok, uint256 used) {
        uint256 g = gasleft();
        (ok,) = address(account).call(data);
        used = g - gasleft();
    }

    function testAccountAddressMatchesFixture() public view {
        assertTrue(address(account) == Fixture.ACCOUNT, "account address the JS digest was bound to");
    }

    function testJsSignedTransferIsAccepted() public {
        (bool ok, uint256 used) = _call(Fixture.CALL1);
        assertTrue(ok, "JS-signed execute accepted");
        emit Gas("JS-signed transfer, 2^17 salts", used);
        emit Gas("JS-signed transfer hash steps", Fixture.STEPS1);
        assertEq(BOB.balance, 1 ether, "bob paid");
        assertEq(account.next(), 1, "counter moved");
    }

    function testJsSignedReplayIsRejected() public {
        (bool ok,) = _call(Fixture.CALL1);
        assertTrue(ok, "first accepted");
        (ok,) = _call(Fixture.CALL1);
        assertTrue(!ok, "replay rejected");
    }

    function testJsMultiCallWithDataIsAccepted() public {
        (bool ok,) = _call(Fixture.CALL2);
        assertTrue(ok, "JS-signed two-call execute accepted");
        assertEq(BOB.balance, 0.25 ether, "bob paid");
        assertEq(CAROL.balance, 0.25 ether, "carol paid");
        assertEq(account.next(), 4, "counter past leaf 3");
    }

    function testJsRekeyThenNewTreeSigns() public {
        (bool ok, uint256 used) = _call(Fixture.CALL3);
        assertTrue(ok, "JS-signed rekey accepted");
        emit Gas("JS-signed rekey, 4096 salts", used);
        assertEq(account.epoch(), 1, "epoch moved");
        assertTrue(account.root() == Fixture.NEXT_ROOT, "new root stored");
        (ok,) = _call(Fixture.CALL4);
        assertTrue(ok, "JS-signed execute from the new tree accepted");
        assertEq(BOB.balance, 1 ether, "bob paid from the new tree");
    }

    function testFlippedByteIsRejected() public {
        bytes memory data = Fixture.CALL1;
        data[data.length - 100] ^= 0x01;
        (bool ok,) = _call(data);
        assertTrue(!ok, "tampered proof rejected");
    }
}
