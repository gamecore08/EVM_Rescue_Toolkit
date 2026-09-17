import { ethers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import {
  planGas,
  estimateSponsorAmount,
  buildTx,
  encodeFullTokenTransfer,
  getTokenMeta,
  parseAmount,
} from "../utils/rawSigner";
import { getChainConfig } from "../config/chains";

/**
 * MODE: claim
 * Untuk skenario: unstake yang baru unlock, klaim airdrop manual, klaim vesting, dll -
 * di mana wallet bocor harus MEMANGGIL sebuah fungsi kontrak dulu sebelum dana keluar.
 *
 * Bundle berisi 3 transaksi atomik:
 *   1. Sponsor -> Compromised wallet : kirim native coin utk bayar gas tx 2 & 3
 *   2. Compromised wallet -> Claim contract : panggil fungsi klaim/unstake
 *   3. Compromised wallet -> Token transfer : kirim token hasil klaim ke safe wallet
 *
 * === FIX PENTING (v2) ===
 * Di versi awal, jumlah token pada TX 3 dihitung dari `balanceOf()` SEBELUM bundle
 * dieksekusi - padahal token baru MUNCUL setelah TX 2 (klaim) berhasil. Akibatnya
 * dibaca 0 dan TX 3 mengirim 0 token (gas terbuang percuma, token asli tertinggal
 * di wallet korban dan rawan disapu drainer bot).
 *
 * Sekarang wajib isi salah satu:
 *   --amount <angka>   jumlah token yang diharapkan (human-readable, mis. "1000"),
 *                       dipakai kalau kamu SUDAH TAHU persis nominalnya (mis. airdrop
 *                       fixed amount, atau hasil query view function kontrak klaim)
 *   --all              pakai balanceOf() apa adanya (HANYA aman kalau token sudah
 *                       ada di wallet SAAT INI, artinya --contract/--calldata TIDAK diisi)
 *
 * Kalau nominal hasil klaim baru diketahui SETELAH eksekusi (tidak bisa dihitung
 * di depan), gunakan Rescuer.sol v2 (`rescueERC20`) yang membaca balance on-chain
 * secara real-time - lihat docs/PANDUAN_ID.md bagian "Kapan pakai Rescuer.sol".
 */

export interface ClaimModeParams {
  rpcHttpUrl: string;
  chainId: number;
  compromisedPrivateKey: string;
  sponsorPrivateKey: string;
  authSignerKey: string;
  safeDestination: string;
  tokenAddress: string;
  claimContractAddress?: string;
  claimCalldata?: string;
  flashbotsRelayUrl: string;
  targetBlockOffset?: number;
  blocksToTry?: number;
  claimGasLimit?: number;
  transferGasLimit?: number;
  amountHuman?: string; // dari --amount
  useAll?: boolean; // dari --all
  dryRun?: boolean; // dari --dry-run: hanya simulasi, tidak broadcast
}

export async function runClaimMode(params: ClaimModeParams) {
  const {
    rpcHttpUrl,
    chainId,
    compromisedPrivateKey,
    sponsorPrivateKey,
    authSignerKey,
    safeDestination,
    tokenAddress,
    claimContractAddress,
    claimCalldata,
    flashbotsRelayUrl,
    targetBlockOffset = 1,
    blocksToTry = 5,
    claimGasLimit = 250_000,
    transferGasLimit = 65_000,
    amountHuman,
    useAll = false,
    dryRun = false,
  } = params;

  const chainCfg = getChainConfig(chainId);
  console.log(`[claim] Jaringan: ${chainCfg.name}${dryRun ? " (DRY-RUN, tidak akan broadcast)" : ""}`);

  const provider = new ethers.JsonRpcProvider(rpcHttpUrl);
  const compromisedWallet = new ethers.Wallet(compromisedPrivateKey, provider);
  const sponsorWallet = new ethers.Wallet(sponsorPrivateKey, provider);
  const authSigner = new ethers.Wallet(authSignerKey, provider);

  const fbProvider = await FlashbotsBundleProvider.create(provider, authSigner, flashbotsRelayUrl);

  const hasClaimStep = !!claimContractAddress && !!claimCalldata;

  // --- Validasi wajib: cegah bug 0-balance terulang ---
  if (hasClaimStep && !amountHuman && !useAll) {
    throw new Error(
      "[claim] Kontrak klaim diisi tapi --amount tidak diisi dan --all tidak dipakai.\n" +
        "  Kalau token baru muncul SETELAH klaim, kamu WAJIB isi --amount <jumlah> supaya\n" +
        "  transfer tidak mengirim 0 token. Kalau nominalnya baru diketahui setelah eksekusi\n" +
        "  (tidak bisa dihitung di depan), pakai Rescuer.sol (lihat docs/PANDUAN_ID.md)."
    );
  }

  const gasPlan = await planGas(provider, 2, blocksToTry);

  const sponsorAmount = estimateSponsorAmount(gasPlan, [
    ...(hasClaimStep ? [{ gasLimit: claimGasLimit }] : []),
    { gasLimit: transferGasLimit },
  ]);

  console.log(
    `[claim] Estimasi gas yang disponsori: ${ethers.formatEther(sponsorAmount)} ${chainCfg.nativeSymbol}`
  );

  const compromisedNonceStart = await provider.getTransactionCount(compromisedWallet.address, "latest");

  const bundle: FlashbotsBundleTransaction[] = [];

  // TX 1: sponsor -> compromised (kirim gas)
  const sponsorTx = await buildTx(sponsorWallet, provider, {
    to: compromisedWallet.address,
    value: sponsorAmount,
    gasLimit: 21_000,
    gasPlan,
    chainId,
  });
  bundle.push({ signer: sponsorWallet, transaction: sponsorTx });

  let nextNonce = compromisedNonceStart;

  // TX 2 (opsional): compromised -> claim contract
  if (hasClaimStep) {
    const claimTx = await buildTx(compromisedWallet, provider, {
      to: claimContractAddress!,
      data: claimCalldata!,
      gasLimit: claimGasLimit,
      gasPlan,
      nonceOverride: nextNonce,
      chainId,
    });
    bundle.push({ signer: compromisedWallet, transaction: claimTx });
    nextNonce += 1;
  }

  // TX 3: compromised -> transfer token ke safe wallet
  let expectedAmountRaw: bigint | undefined;
  if (amountHuman) {
    const { decimals, symbol } = await getTokenMeta(provider, tokenAddress);
    expectedAmountRaw = parseAmount(amountHuman, decimals);
    console.log(`[claim] Menggunakan --amount = ${amountHuman} ${symbol} (${expectedAmountRaw.toString()} raw units)`);
  }

  const { data: transferData, amount } = await encodeFullTokenTransfer(
    provider,
    tokenAddress,
    compromisedWallet.address,
    safeDestination,
    expectedAmountRaw
  );

  if (amount === 0n) {
    throw new Error(
      "[claim] Jumlah yang akan ditransfer = 0. Batalkan sebelum broadcast sia-sia.\n" +
        "  Isi --amount dengan nominal yang benar, atau pastikan --all hanya dipakai saat\n" +
        "  token SUDAH ada di wallet saat ini."
    );
  }

  console.log(`[claim] Jumlah yang akan ditransfer: ${amount.toString()} raw units`);

  const transferTx = await buildTx(compromisedWallet, provider, {
    to: tokenAddress,
    data: transferData,
    gasLimit: transferGasLimit,
    gasPlan,
    nonceOverride: nextNonce,
    chainId,
  });
  bundle.push({ signer: compromisedWallet, transaction: transferTx });

  const currentBlock = await provider.getBlockNumber();

  if (dryRun) {
    const targetBlock = currentBlock + targetBlockOffset;
    const signedBundle = await fbProvider.signBundle(bundle);
    const simulation = await fbProvider.simulate(signedBundle, targetBlock);
    if ("error" in simulation) {
      console.error(`[claim][dry-run] Simulasi GAGAL:`, simulation.error.message);
      return { success: false, dryRun: true };
    }
    console.log(`[claim][dry-run] Simulasi SUKSES untuk block ${targetBlock}. Tidak ada yang di-broadcast.`);
    console.log(`[claim][dry-run] Detail:`, JSON.stringify(simulation, null, 2));
    return { success: true, dryRun: true, simulation };
  }

  // Kirim bundle ke beberapa block berturut-turut sampai berhasil masuk
  for (let i = 0; i < blocksToTry; i++) {
    const targetBlock = currentBlock + targetBlockOffset + i;
    const signedBundle = await fbProvider.signBundle(bundle);
    const simulation = await fbProvider.simulate(signedBundle, targetBlock);

    if ("error" in simulation) {
      console.error(`[claim] Simulasi gagal di block ${targetBlock}:`, simulation.error.message);
      continue;
    }
    console.log(`[claim] Simulasi sukses untuk block ${targetBlock}. Mengirim bundle...`);

    const submission = await fbProvider.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) {
      console.error(`[claim] Gagal kirim bundle:`, submission.error.message);
      continue;
    }

    const resolution = await submission.wait();
    if (resolution === 0 /* BundleIncluded */) {
      console.log(`[claim] BERHASIL! Bundle masuk di block ${targetBlock}.`);
      return { success: true, block: targetBlock };
    } else {
      console.log(`[claim] Belum masuk di block ${targetBlock}, coba block berikutnya...`);
    }
  }

  console.warn("[claim] Bundle tidak masuk dalam batas percobaan. Coba lagi dengan blocksToTry lebih besar / priority gas lebih tinggi.");
  return { success: false };
}
