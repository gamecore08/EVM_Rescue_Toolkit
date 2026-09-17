// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Token ERC-20 sederhana untuk testing (bukan untuk produksi).
contract MockToken {
    string public name = "Mock Rescue Token";
    string public symbol = "MRT";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance kurang");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "saldo kurang");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Simulasi kontrak airdrop/unstake yang MENGHARUSKAN msg.sender adalah
///         wallet pemilik posisi asli (persis kasus nyata yang membuat pola
///         "call dari dalam kontrak" di Rescuer v1 gagal).
contract MockStaking {
    MockToken public rewardToken;
    mapping(address => bool) public hasStaked;
    mapping(address => bool) public claimed;

    constructor(MockToken _rewardToken) {
        rewardToken = _rewardToken;
    }

    function fakeStake(address user) external {
        hasStaked[user] = true;
    }

    /// @dev Sengaja require msg.sender langsung (bukan lewat kontrak perantara),
    ///      supaya test memverifikasi Rescuer v2 (tanpa call dari kontrak) berhasil,
    ///      sementara pola v1 (call dari dalam kontrak) akan revert di sini.
    function claim() external {
        require(hasStaked[msg.sender], "wallet ini belum pernah stake");
        require(!claimed[msg.sender], "sudah pernah klaim");
        claimed[msg.sender] = true;
        rewardToken.mint(msg.sender, 1000 ether);
    }
}
