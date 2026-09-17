// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC721 {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC1155 {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @title Rescuer (v2)
/// @notice Kontrak bantu whitehat untuk memindahkan aset dari wallet yang bocor
///         (`victim`) ke wallet aman (`safeDestination`), dibaca ON-CHAIN & REAL-TIME
///         pada saat eksekusi - bukan diperkirakan sebelumnya. Ini memperbaiki masalah
///         "0-balance bug" di versi v1 (transfer di-encode SEBELUM tx klaim jalan).
///
/// @dev PERBEDAAN PENTING dari v1:
///      v1 memanggil `claimTarget.call(...)` DARI dalam kontrak, sehingga `msg.sender`
///      yang diterima kontrak klaim adalah alamat Rescuer, BUKAN wallet korban.
///      Banyak kontrak staking/airdrop mensyaratkan `msg.sender == pemilik posisi`,
///      jadi pola ini sering GAGAL di dunia nyata.
///
///      v2 TIDAK memanggil kontrak klaim sama sekali. Alur yang benar:
///        1. Wallet korban (EOA) memanggil kontrak klaim LANGSUNG (tx terpisah dalam
///           bundle yang sama) - sehingga msg.sender di kontrak klaim tetap benar.
///        2. Wallet korban memanggil `approve(Rescuer, amount)` pada token ERC-20,
///           atau `setApprovalForAll(Rescuer, true)` untuk NFT (juga tx terpisah).
///        3. Kontrak Rescuer ini dipanggil (oleh siapa saja, boleh sponsor) untuk
///           `transferFrom` SELURUH saldo real-time wallet korban ke safeDestination.
///
///      Karena baru dibaca lewat `balanceOf()` PADA SAAT langkah 3 dieksekusi (setelah
///      langkah 1 sukses di block yang sama), jumlahnya selalu akurat walau token
///      baru muncul akibat proses klaim di tx sebelumnya.
contract Rescuer {
    address public immutable safeDestination;
    address public immutable deployer;

    event RescuedERC20(address indexed token, address indexed victim, uint256 amount);
    event RescuedERC721(address indexed token, address indexed victim, uint256 tokenId);
    event RescuedERC1155(address indexed token, address indexed victim, uint256 id, uint256 amount);

    constructor(address _safeDestination) {
        require(_safeDestination != address(0), "safeDestination=0");
        safeDestination = _safeDestination;
        deployer = msg.sender;
    }

    /// @notice Sapu SEMUA saldo ERC-20 milik `victim` ke safeDestination.
    ///         Syarat: `victim` sudah `approve(address(this), amount>=balance)` sebelumnya
    ///         (biasanya di tx sebelum ini, dalam bundle yang sama).
    function rescueERC20(address token, address victim) public {
        uint256 bal = IERC20(token).balanceOf(victim);
        if (bal > 0) {
            require(IERC20(token).transferFrom(victim, safeDestination, bal), "transferFrom failed");
            emit RescuedERC20(token, victim, bal);
        }
    }

    /// @notice Versi batch: sapu beberapa token ERC-20 sekaligus dalam 1 tx.
    function rescueERC20Batch(address[] calldata tokens, address victim) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            rescueERC20(tokens[i], victim);
        }
    }

    /// @notice Pindahkan satu NFT ERC-721 milik `victim` ke safeDestination.
    ///         Syarat: `victim` sudah `setApprovalForAll(address(this), true)` di kontrak NFT.
    function rescueERC721(address token, address victim, uint256 tokenId) public {
        require(IERC721(token).ownerOf(tokenId) == victim, "victim bukan owner tokenId");
        IERC721(token).safeTransferFrom(victim, safeDestination, tokenId);
        emit RescuedERC721(token, victim, tokenId);
    }

    /// @notice Batch beberapa tokenId ERC-721 (boleh dari kontrak yang sama atau berbeda,
    ///         panjang array harus sama).
    function rescueERC721Batch(
        address[] calldata tokens,
        address victim,
        uint256[] calldata tokenIds
    ) external {
        require(tokens.length == tokenIds.length, "panjang array tidak sama");
        for (uint256 i = 0; i < tokens.length; i++) {
            rescueERC721(tokens[i], victim, tokenIds[i]);
        }
    }

    /// @notice Pindahkan SEMUA saldo ERC-1155 id tertentu milik `victim`.
    ///         Syarat: `victim` sudah `setApprovalForAll(address(this), true)`.
    function rescueERC1155(address token, address victim, uint256 id) public {
        uint256 bal = IERC1155(token).balanceOf(victim, id);
        if (bal > 0) {
            IERC1155(token).safeTransferFrom(victim, safeDestination, id, bal, "");
            emit RescuedERC1155(token, victim, id, bal);
        }
    }

    function rescueERC1155Batch(
        address[] calldata tokens,
        address victim,
        uint256[] calldata ids
    ) external {
        require(tokens.length == ids.length, "panjang array tidak sama");
        for (uint256 i = 0; i < tokens.length; i++) {
            rescueERC1155(tokens[i], victim, ids[i]);
        }
    }

    /// @notice Sapu native coin (ETH/BNB/MATIC) yang nyangkut di kontrak ini (jarang
    ///         kepakai secara langsung - native coin biasanya ditransfer via tx biasa,
    ///         bukan lewat kontrak ini - disediakan untuk jaga-jaga / edge case).
    function sweepNative() external {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = payable(safeDestination).call{value: bal}("");
            require(ok, "native transfer failed");
        }
    }

    receive() external payable {}
}
