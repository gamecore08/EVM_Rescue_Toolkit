import { ethers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import { planGas, estimateSponsorAmount, buildTx } from "../utils/rawSigner";
import { getChainConfig } from "../config/chains";

/**
 * MODE: native
 * Untuk skenario: wallet bocor SAAT INI sudah punya saldo native coin (ETH/BNB/MATIC)
 * yang mau diselamatkan SEKARANG (satu kali tembak), bukan dipantau terus-menerus.
 *
 * Beda dengan `passiveSweeper.ts` (mode `listen`) yang menunggu saldo MUNCUL dulu,
 * modul ini langsung mengecek saldo saat dijalankan dan rescue seketika - cocok
 * dipakai manual saat kamu TAHU ada saldo yang perlu buru-buru diamankan (mis.
 * dapat transfer/refund tak terduga ke wallet bocor).
 *
 * Bundle 2 transaksi:
 *   1. Sponsor -> Compromised wallet : bayar gas (21000 * gasPrice)
 *   2. Compromised wallet -> Safe wallet : transfer (saldo - gas terpakai)
 */

export interface NativeSweepParams {
  rpcHttpUrl: string;
  chainId: number;
  compromisedPrivateKey: string;
  sponsorPrivateKey: string;
  authSignerKey: string;
  safeDestination: string;
  flashbotsRelayUrl: string;
  targetBlockOffset?: number;
  blocksToTry?: number;
}

export async function runNativeSweep(params: NativeSweepParams) {
  const {
    rpcHttpUrl,
    chainId,
    compromisedPrivateKey,
    sponsorPrivateKey,
    authSignerKey,
    safeDestination,
    flashbotsRelayUrl,
    targetBlockOffset = 1,
    blocksToTry = 5,
  } = params;

  const chainCfg = getChainConfig(chainId);
  const provider = new ethers.JsonRpcProvider(rpcHttpUrl);
  const compromisedWallet = new ethers.Wallet(compromisedPrivateKey, provider);
  const sponsorWallet = new ethers.Wallet(sponsorPrivateKey, provider);
  const authSigner = new ethers.Wallet(authSignerKey, provider);

  const balance = await provider.getBalance(compromisedWallet.address);
  console.log(`[native] Saldo saat ini: ${ethers.formatEther(balance)} ${chainCfg.nativeSymbol}`);

  if (balance === 0n) {
    console.warn("[native] Saldo 0. Tidak ada yang bisa diselamatkan. Gunakan --mode listen jika menunggu saldo muncul.");
    return { success: false, reason: "zero-balance" };
  }

  const fbProvider = await FlashbotsBundleProvider.create(provider, authSigner, flashbotsRelayUrl);
  const gasPlan = await planGas(provider, 2, blocksToTry);
  const sponsorAmount = estimateSponsorAmount(gasPlan, [{ gasLimit: 21_000 }]);

  console.log(`[native] Gas disponsori: ${ethers.formatEther(sponsorAmount)} ${chainCfg.nativeSymbol}`);

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

  // Kirim SEMUA saldo yang terdeteksi (gas dibayar dari sponsorAmount, bukan dipotong dari sini)
  const transferTx = await buildTx(compromisedWallet, provider, {
    to: safeDestination,
    value: balance,
    gasLimit: 21_000,
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
      console.error(`[native] Simulasi gagal di block ${targetBlock}:`, simulation.error.message);
      continue;
    }
    const submission = await fbProvider.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) {
      console.error(`[native] Gagal kirim bundle:`, submission.error.message);
      continue;
    }
    const resolution = await submission.wait();
    if (resolution === 0) {
      console.log(`[native] BERHASIL diselamatkan di block ${targetBlock}!`);
      return { success: true, block: targetBlock };
    }
    console.log(`[native] Belum masuk di block ${targetBlock}, mencoba block berikutnya...`);
  }

  console.warn("[native] Bundle tidak masuk dalam batas percobaan.");
  return { success: false };
}
