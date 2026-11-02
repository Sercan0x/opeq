// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import {OpeqAccount} from "./OpeqAccount.sol";

contract OpeqMultisig {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    struct Proposal {
        bytes32 callsHash;
        address proposer;
        uint64 expires;
        uint32 config;
        bool executed;
        bool cancelled;
    }

    uint256 public constant MAX_OWNERS = 10;
    uint256 public constant MAX_LIFETIME = 30 days;
    bytes32 public constant ACCOUNT_CODEHASH = keccak256(type(OpeqAccount).runtimeCode);

    address[] internal owners;
    mapping(address => bool) public isOwner;
    uint8 public threshold;
    uint32 public config;

    Proposal[] internal proposals;
    mapping(uint256 => bytes) internal encodedCalls;
    mapping(uint256 => mapping(address => bool)) public approved;

    event Proposed(uint256 indexed id, address indexed proposer, bytes32 callsHash, uint64 expires);
    event Approved(uint256 indexed id, address indexed owner);
    event Revoked(uint256 indexed id, address indexed owner);
    event Cancelled(uint256 indexed id);
    event Executed(uint256 indexed id);
    event OwnersChanged(uint32 indexed config, address[] owners, uint8 threshold);

    error NotOwner();
    error NotSelf();
    error NotOpeqAccount(address owner);
    error DuplicateOwner(address owner);
    error BadOwnerCount();
    error BadThreshold();
    error UnknownProposal();
    error NotLive();
    error BadExpiry();
    error AlreadyApproved();
    error NotApproved();
    error NotProposer();
    error NotEnoughApprovals(uint256 have, uint256 need);
    error CallsMismatch();
    error CallFailed(uint256 index, bytes reason);

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(address[] memory owners_, uint8 threshold_) {
        _setOwners(owners_, threshold_);
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

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 id)
        external
        view
        returns (Proposal memory p, bytes memory calls, uint256 approvals, bool live)
    {
        if (id >= proposals.length) revert UnknownProposal();
        p = proposals[id];
        calls = encodedCalls[id];
        approvals = approvalCount(id);
        live = _live(p);
    }

    function approvalCount(uint256 id) public view returns (uint256 n) {
        for (uint256 i; i < owners.length; ++i) if (approved[id][owners[i]]) ++n;
    }

    function propose(Call[] calldata calls, uint64 expires) external onlyOwner returns (uint256 id) {
        if (expires <= block.timestamp || expires > block.timestamp + MAX_LIFETIME) revert BadExpiry();
        bytes memory enc = abi.encode(calls);
        id = proposals.length;
        proposals.push(
            Proposal({
                callsHash: keccak256(enc),
                proposer: msg.sender,
                expires: expires,
                config: config,
                executed: false,
                cancelled: false
            })
        );
        encodedCalls[id] = enc;
        approved[id][msg.sender] = true;
        emit Proposed(id, msg.sender, keccak256(enc), expires);
        emit Approved(id, msg.sender);
    }

    function approve(uint256 id) external onlyOwner {
        Proposal storage p = _get(id);
        if (!_live(p)) revert NotLive();
        if (approved[id][msg.sender]) revert AlreadyApproved();
        approved[id][msg.sender] = true;
        emit Approved(id, msg.sender);
    }

    function revoke(uint256 id) external onlyOwner {
        Proposal storage p = _get(id);
        if (!_live(p)) revert NotLive();
        if (!approved[id][msg.sender]) revert NotApproved();
        approved[id][msg.sender] = false;
        emit Revoked(id, msg.sender);
    }

    function cancel(uint256 id) external onlyOwner {
        Proposal storage p = _get(id);
        if (!_live(p)) revert NotLive();
        if (p.proposer != msg.sender) revert NotProposer();
        p.cancelled = true;
        emit Cancelled(id);
    }

    function execute(uint256 id, Call[] calldata calls) external onlyOwner {
        Proposal storage p = _get(id);
        if (!_live(p)) revert NotLive();
        if (keccak256(abi.encode(calls)) != p.callsHash) revert CallsMismatch();
        uint256 have = approvalCount(id);
        if (have < threshold) revert NotEnoughApprovals(have, threshold);
        p.executed = true;
        emit Executed(id);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    function setOwners(address[] calldata owners_, uint8 threshold_) external onlySelf {
        for (uint256 i; i < owners.length; ++i) isOwner[owners[i]] = false;
        delete owners;
        _setOwners(owners_, threshold_);
    }

    function setThreshold(uint8 threshold_) external onlySelf {
        if (threshold_ == 0 || threshold_ > owners.length) revert BadThreshold();
        threshold = threshold_;
        config += 1;
        emit OwnersChanged(config, owners, threshold_);
    }

    function _setOwners(address[] memory owners_, uint8 threshold_) private {
        if (owners_.length == 0 || owners_.length > MAX_OWNERS) revert BadOwnerCount();
        if (threshold_ == 0 || threshold_ > owners_.length) revert BadThreshold();
        for (uint256 i; i < owners_.length; ++i) {
            address o = owners_[i];
            if (o.codehash != ACCOUNT_CODEHASH) revert NotOpeqAccount(o);
            if (isOwner[o]) revert DuplicateOwner(o);
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
        config += 1;
        emit OwnersChanged(config, owners_, threshold_);
    }

    function _get(uint256 id) private view returns (Proposal storage) {
        if (id >= proposals.length) revert UnknownProposal();
        return proposals[id];
    }

    function _live(Proposal memory p) private view returns (bool) {
        return !p.executed && !p.cancelled && p.config == config && block.timestamp <= p.expires;
    }
}
