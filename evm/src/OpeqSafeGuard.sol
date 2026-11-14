// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

interface ISafe {
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce_
    ) external view returns (bytes32);
    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory, address);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
    function isOwner(address owner) external view returns (bool);
}

interface IGuard {
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address msgSender
    ) external;
    function checkAfterExecution(bytes32 txHash, bool success) external;
}

contract OpeqSafeGuard is IGuard {
    address internal constant SENTINEL = address(0x1);
    uint256 internal constant FALLBACK_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    uint256 public constant MIN_DELAY = 7 days;
    uint256 public constant MAX_DELAY = 90 days;
    uint256 public constant MAX_APPROVERS = 16;
    uint256 public constant MAX_RECOVERIES = 16;
    uint256 public constant RECOVERY_WINDOW = 30 days;
    bytes32 public constant ACCOUNT_CODEHASH = 0xffa907784a55292e0e842dd77da1d1dde5437208024a1be7e16b36ddbb3119cd;

    struct Config {
        uint8 required;
        uint32 delay;
    }

    mapping(address => Config) public config;
    mapping(address => address[]) internal approverList;
    mapping(address => mapping(address => bool)) public isApprover;
    mapping(address => uint256) public epoch;
    mapping(address => mapping(uint256 => mapping(bytes32 => mapping(address => bool)))) internal approvedAt;
    mapping(address => mapping(address => bytes32)) public ownerRequest;
    mapping(address => mapping(bytes32 => uint256)) public recoveryAt;
    mapping(address => bytes32[]) internal recoveryList;

    event Configured(address indexed safe, address[] approvers, uint8 required, uint32 delay);
    event Approved(address indexed safe, bytes32 indexed safeTxHash, address indexed approver);
    event RecoveryRequested(address indexed safe, bytes32 indexed safeTxHash, address owner, uint256 readyAt);
    event RecoveryCancelled(address indexed safe, bytes32 indexed safeTxHash, address approver);

    error NotConfigured();
    error BadConfig();
    error NotApprover();
    error NotOwner();
    error NotApproved(bytes32 safeTxHash);
    error ModuleEnabled();
    error FallbackHandlerSet();
    error TooManyRecoveries();
    error NotOpeqAccount(address approver);

    function configure(address[] calldata approvers, uint8 required, uint32 delay) external {
        address safe = msg.sender;
        uint256 n = approvers.length;
        if (n == 0 || n > MAX_APPROVERS || required == 0 || required > n) revert BadConfig();
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert BadConfig();
        _checkSafe(safe);
        address[] storage old = approverList[safe];
        for (uint256 i = 0; i < old.length; i++) isApprover[safe][old[i]] = false;
        delete approverList[safe];
        for (uint256 i = 0; i < n; i++) {
            address a = approvers[i];
            if (a == address(0) || a == safe || isApprover[safe][a]) revert BadConfig();
            if (a.codehash != ACCOUNT_CODEHASH) revert NotOpeqAccount(a);
            isApprover[safe][a] = true;
            approverList[safe].push(a);
        }
        config[safe] = Config(required, delay);
        epoch[safe] += 1;
        emit Configured(safe, approvers, required, delay);
    }

    function approverSet(address safe) external view returns (address[] memory) {
        return approverList[safe];
    }

    function approve(address safe, bytes32 safeTxHash) external {
        if (!isApprover[safe][msg.sender]) revert NotApprover();
        approvedAt[safe][epoch[safe]][safeTxHash][msg.sender] = true;
        emit Approved(safe, safeTxHash, msg.sender);
    }

    function approved(address safe, bytes32 safeTxHash, address approver) external view returns (bool) {
        return approvedAt[safe][epoch[safe]][safeTxHash][approver];
    }

    function approvalCount(address safe, bytes32 safeTxHash) public view returns (uint256 count) {
        address[] storage list = approverList[safe];
        for (uint256 i = 0; i < list.length; i++) {
            if (approvedAt[safe][epoch[safe]][safeTxHash][list[i]]) count++;
        }
    }

    function requestRecovery(address safe, bytes32 safeTxHash) external {
        Config memory c = config[safe];
        if (c.required == 0) revert NotConfigured();
        if (!ISafe(safe).isOwner(msg.sender)) revert NotOwner();
        _pruneRecoveries(safe);
        if (recoveryAt[safe][safeTxHash] != 0) return;
        bytes32 prev = ownerRequest[safe][msg.sender];
        if (prev != bytes32(0) && recoveryAt[safe][prev] != 0) _dropRecovery(safe, prev);
        ownerRequest[safe][msg.sender] = safeTxHash;
        if (recoveryList[safe].length >= MAX_RECOVERIES) revert TooManyRecoveries();
        uint256 readyAt = block.timestamp + c.delay;
        recoveryAt[safe][safeTxHash] = readyAt;
        recoveryList[safe].push(safeTxHash);
        emit RecoveryRequested(safe, safeTxHash, msg.sender, readyAt);
    }

    function cancelRecovery(address safe, bytes32 safeTxHash) external {
        if (!isApprover[safe][msg.sender]) revert NotApprover();
        if (recoveryAt[safe][safeTxHash] == 0) return;
        _dropRecovery(safe, safeTxHash);
        emit RecoveryCancelled(safe, safeTxHash, msg.sender);
    }

    function pendingRecoveries(address safe) external view returns (bytes32[] memory hashes, uint256[] memory readyAt) {
        hashes = recoveryList[safe];
        readyAt = new uint256[](hashes.length);
        for (uint256 i = 0; i < hashes.length; i++) readyAt[i] = recoveryAt[safe][hashes[i]];
    }

    function _pruneRecoveries(address safe) internal {
        bytes32[] storage list = recoveryList[safe];
        uint256 i = 0;
        while (i < list.length) {
            bytes32 h = list[i];
            if (block.timestamp > recoveryAt[safe][h] + RECOVERY_WINDOW) {
                delete recoveryAt[safe][h];
                list[i] = list[list.length - 1];
                list.pop();
            } else {
                i++;
            }
        }
    }

    function _dropRecovery(address safe, bytes32 safeTxHash) internal {
        delete recoveryAt[safe][safeTxHash];
        bytes32[] storage list = recoveryList[safe];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == safeTxHash) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata,
        address
    ) external override {
        address safe = msg.sender;
        Config memory c = config[safe];
        if (c.required == 0) return;
        bytes32 h = ISafe(safe).getTransactionHash(
            to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, ISafe(safe).nonce() - 1
        );
        uint256 t = recoveryAt[safe][h];
        if (approvalCount(safe, h) >= c.required) {
            if (t != 0) _dropRecovery(safe, h);
            return;
        }
        if (t != 0 && block.timestamp >= t && block.timestamp <= t + RECOVERY_WINDOW) {
            _dropRecovery(safe, h);
            return;
        }
        revert NotApproved(h);
    }

    function checkAfterExecution(bytes32, bool) external view override {
        if (config[msg.sender].required != 0) _checkSafe(msg.sender);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == type(IGuard).interfaceId;
    }

    function _checkSafe(address safe) internal view {
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, 1);
        if (modules.length != 0) revert ModuleEnabled();
        address handler = abi.decode(ISafe(safe).getStorageAt(FALLBACK_SLOT, 1), (address));
        if (handler != address(0)) revert FallbackHandlerSet();
    }
}
