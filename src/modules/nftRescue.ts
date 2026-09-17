import { ethers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import { planGas, estimateSponsorAmount, buildTx } from "../utils/rawSigner";
import { getChainConfig } from "../config/chains";

/**
 * MODE: nft
 * Untuk skenario: wallet bocor menyimpan NFT (ERC-721 atau ERC-1155) yang mau
 * diselamatkan. Tidak seperti ERC-20 yang punya fungsi transfer() sederhana,
 * NFT butuh tahu tokenId (ERC-721) atau tokenId+jumlah (ERC-1155).
 *
 * Bundle berisi 2 transaksi:
 *   1. Sponsor -> Compromised wallet : kirim native coin utk bayar gas
 *   2. Compromised wallet -> NFT transfer : safeTransferFrom ke safe wallet
 *
 * Untuk banyak NFT sekaligus, deploy Rescuer.sol dan pakai rescueERC721Batch /
 * rescueERC1155Batch supaya cukup 1 tx approval + 1 tx batch, bukan N tx terpisah.
 */

const ERC721_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const ERC1155_ABI = [
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

export interface NftRescueParams {
  rpcHttpUrl: string;
  chainId: number;
  compromisedPrivateKey: string;
  sponsorPrivateKey: string;
  authSignerKey: string;
  safeDestination: string;
  nftAddress: string;
  tokenId: string;
  standard: "erc721" | "erc1155";
  amount?: string;
  flashbotsRelayUrl: string;
  targetBlockOffset?: number;
  blocksToTry?: number;
  transferGasLimit?: number;
}

export async function runNftRescue(params: NftRescueParams) {
  const {
    rpcHttpUrl,
    chainId,
    compromisedPrivateKey,
    sponsorPrivateKey,
    authSignerKey,
    safeDestination,
    nftAddress,
    tokenId,
    standard,
    amount = "1",
    flashbotsRelayUrl,
    targetBlockOffset = 1,
    blocksToTry = 5,
    transferGasLimit = 120_000,
  } = params;

  const chainCfg = getChainConfig(chainId);
  console.log(`[nft] Jaringan: ${chainCfg.name} | Standar: ${standard.toUpperCase()} | tokenId: ${tokenId}`);

  const provider = new ethers.JsonRpcProvider(rpcHttpUrl);
  const compromisedWallet = new ethers.Wallet(compromisedPrivateKey, provider);
  const sponsorWallet = new ethers.Wallet(sponsorPrivateKey, provider);
  const authSigner = new ethers.Wallet(authSignerKey, provider);

  const fbProvider = await FlashbotsBundleProvider.create(provider, authSigner, flashbotsRelayUrl);

  if (standard === "erc721") {
    const nft = new ethers.Contract(nftAddress, ERC721_ABI, provider);
    const owner: string = await nft.ownerOf(tokenId);
    if (owner.toLowerCase() !== compromisedWallet.address.toLowerCase()) {
      throw new Error(
        `[nft] tokenId ${tokenId} BUKAN milik wallet ${compromisedWallet.address} (owner saat ini: ${owner}). ` +
          `Kemungkinan sudah disweep, atau tokenId salah.`
      );
    }
  }

  const gasPlan = await planGas(provider, 2, blocksToTry);
  const sponsorAmount = estimateSponsorAmount(gasPlan, [{ gasLimit: transferGasLimit }]);
  console.log(`[nft] Estimasi gas disponsori: ${ethers.formatEther(sponsorAmount)} ${chainCfg.nativeSymbol}`);

  const nonce = await provider.getTransactionCount(compromisedWallet.address, "latest");
  const bundle: FlashbotsBundleTransaction[] = [];

  const sponsorTx = await buildTx(sponsorWallet, provider, {
    to: compromisedWallet.address,
    value: sponsorAmount,
    gasLimit: 21_000,
    gasPlan,
    chainId,
  });
  bundle.push({ signer: sponsorWallet, transaction: sponsorTx });

  let transferData: string;
  if (standard === "erc721") {
    const iface = new ethers.Interface(ERC721_ABI);
    transferData = iface.encodeFunctionData("safeTransferFrom(address,address,uint256)", [
      compromisedWallet.address,
      safeDestination,
      tokenId,
    ]);
  } else {
    const iface = new ethers.Interface(ERC1155_ABI);
    transferData = iface.encodeFunctionData("safeTransferFrom", [
      compromisedWallet.address,
      safeDestination,
      tokenId,
      amount,
      "0x",
    ]);
  }

  const transferTx = await buildTx(compromisedWallet, provider, {
    to: nftAddress,
    data: transferData,
    gasLimit: transferGasLimit,
    gasPlan,
    nonceOverride: nonce,
    chainId,
  });
  bundle.push({ signer: compromisedWallet, transaction: transferTx });

  const currentBlock = await provider.getBlockNumber();
  for (let i = 0; i < blocksToTry; i++) {
    const targetBlock = currentBlock + targetBlockOffset + i;
    const signedBundle = await fbProvider.signBundle(bundle);
    const simulation = await fbProvider.simulate(signedBundle, targetBlock);
    if ("error" in simulation) {
      console.error(`[nft] Simulasi gagal di block ${targetBlock}:`, simulation.error.message);
      continue;
    }
    const submission = await fbProvider.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) {
      console.error(`[nft] Gagal kirim bundle:`, submission.error.message);
      continue;
    }
    const resolution = await submission.wait();
    if (resolution === 0) {
      console.log(`[nft] BERHASIL diselamatkan di block ${targetBlock}!`);
      return { success: true, block: targetBlock };
    }
    console.log(`[nft] Belum masuk di block ${targetBlock}, mencoba block berikutnya...`);
  }

  console.warn("[nft] Bundle tidak masuk dalam batas percobaan.");
  return { success: false };
}
