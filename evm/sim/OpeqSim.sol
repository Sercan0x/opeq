pragma solidity ^0.8.33;

interface IBalance {
    function balanceOf(address) external view returns (uint256);
}

contract OpeqSim {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    function sim(Call[] calldata calls, address token)
        external
        returns (bool ok, uint256 index, uint256 gasUsed, uint256 before, uint256 afterBal, bytes memory reason)
    {
        before = _bal(token);
        uint256 g = gasleft();
        for (uint256 i = 0; i < calls.length; i++) {
            (bool s, bytes memory r) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!s) return (false, i, g - gasleft(), before, before, r);
        }
        gasUsed = g - gasleft();
        afterBal = _bal(token);
        ok = true;
    }

    function _bal(address token) private view returns (uint256) {
        if (token == address(0)) return address(this).balance;
        (bool s, bytes memory r) = token.staticcall(abi.encodeCall(IBalance.balanceOf, (address(this))));
        return s && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
