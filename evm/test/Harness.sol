// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface Vm {
    function deal(address, uint256) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
}

contract Asserts {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    error AssertFailed(string what, uint256 got, uint256 want);
    error AssertTrueFailed(string what);

    event Gas(string label, uint256 gas);

    function assertEq(uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) revert AssertFailed(what, got, want);
    }

    function assertTrue(bool cond, string memory what) internal pure {
        if (!cond) revert AssertTrueFailed(what);
    }
}

contract MockToken {
    uint8 public constant decimals = 6;
    string public constant symbol = "MOCK";
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
