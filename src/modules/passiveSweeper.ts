import { ethers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleTransaction } from "@flashbots/ethers-provider-bundle";
import { planGas, estimateSponsorAmount, buildTx, encodeFullTokenTransfer, ERC20_ABI } from "../utils/rawSigner";
import { getChainConfig } from "../config/chains";

/**
 * MODE: listen
 * Untuk skenario: kamu TIDAK tahu persis kapan token akan masuk (misal: unstake yang
 * auto-cair di block tertentu, airdrop otomatis, atau reward staking yang menetes).
 * Juga cocok untuk kasus "gas ETH yang kamu kirim ke wallet bocor disweep drainer" -
 * karena di sini gas TIDAK PERNAH dikirim terpisah, selalu 1 bundle dengan transfer.
 *
 * Cara kerja:
 *  1. Buka koneksi WebSocket, subscribe ke setiap block baru (newHeads)
 *  2. Setiap block baru, cek balanceOf(token) milik compromised wallet
 *  3. Begitu saldo > 0, LANGSUNG rakit bundle (sponsor gas + transfer) dan kirim
 *     ke Flashbots untuk beberapa block ke depan sampai berhasil
 *
 * Karena native coin (ETH/BNB/dst) untuk gas ikut disponsori DALAM bundle yang sama
 * dengan tx transfer token, drainer bot tidak akan sempat "curi" gas itu duluan -
 * bundle hanya valid & di-broadcast on-chain jika SEMUA txn di dalamnya sukses sekaligus.
 */

export interface ListenModeParams {
  rpcHttpUrl: string;
  rpcWssUrl: string;
  chainId: number;
  compromisedPrivateKey: string;
  sponsorPrivateKey: string;
  authSignerKey: string;
  safeDestination: string;
  tokenAddress: string; // isi ethers.ZeroAddress untuk pantau NATIVE COIN, bukan token
  flashbotsRelayUrl: string;
  blocksToTry?: number;
  transferGasLimit?: number;
  pollDelayMs?: number; // jeda kecil antar cek, default 0 (setiap block)
}

const NATIVE_SENTINEL = ethers.ZeroAddress;

export async function runListenMode(params: ListenModeParams) {
  const {
    rpcHttpUrl,
    rpcWssUrl,
    chainId,
    compromisedPrivateKey,
    sponsorPrivateKey,
    authSignerKey,
    safeDestination,
    tokenAddress,
    flashbotsRelayUrl,
    blocksToTry = 5,
    transferGasLimit = 65_000,
  } = params;

  const chainCfg = getChainConfig(chainId);
  const isNative = tokenAddress.toLowerCase() === NATIVE_SENTINEL.toLowerCase();

  console.log(`[listen] Jaringan: ${chainCfg.name} | Memantau: ${isNative ? chainCfg.nativeSymbol + " (native)" : tokenAddress}`);

  const httpProvider = new ethers.JsonRpcProvider(rpcHttpUrl);
  const wsProvider = new ethers.WebSocketProvider(rpcWssUrl);

  const compromisedWallet = new ethers.Wallet(compromisedPrivateKey, httpProvider);
  const sponsorWallet = new ethers.Wallet(sponsorPrivateKey, httpProvider);
  const authSigner = new ethers.Wallet(authSignerKey, httpProvider);

  const fbProvider = await FlashbotsBundleProvider.create(httpProvider, authSigner, flashbotsRelayUrl);

  let busy = false; // cegah proses ganda kalau block baru masuk saat masih sweeping

  console.log("[listen] Menunggu block baru... (Ctrl+C untuk berhenti)");

  wsProvider.on("block", async (blockNumber: number) => {
    if (busy) return;
    try {
      let hasBalance = false;
      let nativeBalance = 0n;

      if (isNative) {
        nativeBalance = await httpProvider.getBalance(compromisedWallet.address);
        hasBalance = nativeBalance > 0n;
      } else {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, httpProvider);
        const bal: bigint = await token.balanceOf(compromisedWallet.address);
        hasBalance = bal > 0n;
      }

      if (!hasBalance) return;

      busy = true;
      console.log(`[listen] Saldo terdeteksi di block ${blockNumber}! Menyiapkan bundle rescue...`);

      const gasPlan = await planGas(httpProvider, 2, blocksToTry);
      const nonce = await httpProvider.getTransactionCount(compromisedWallet.address, "latest");
      const bundle: FlashbotsBundleTransaction[] = [];

      if (isNative) {
        // Kasus khusus: menyelamatkan native coin itu sendiri.
        // Sponsor cuma perlu bayar gas 21000 sekali, sisanya (saldo - gas) ditransfer.
        const sponsorAmount = estimateSponsorAmount(gasPlan, [{ gasLimit: 21_000 }]);
        const sponsorTx = await buildTx(sponsorWallet, httpProvider, {
          to: compromisedWallet.address,
          value: sponsorAmount,
          gasLimit: 21_000,
          gasPlan,
          chainId,
        });
        bundle.push({ signer: sponsorWallet, transaction: sponsorTx });

        const sendAmount = nativeBalance; // kirim semua saldo native yg terdeteksi
        const transferTx = await buildTx(compromisedWallet, httpProvider, {
          to: safeDestination,
          value: sendAmount,
          gasLimit: 21_000,
          gasPlan,
          nonceOverride: nonce,
          chainId,
        });
        bundle.push({ signer: compromisedWallet, transaction: transferTx });
      } else {
        const sponsorAmount = estimateSponsorAmount(gasPlan, [{ gasLimit: transferGasLimit }]);
        const sponsorTx = await buildTx(sponsorWallet, httpProvider, {
          to: compromisedWallet.address,
          value: sponsorAmount,
          gasLimit: 21_000,
          gasPlan,
          chainId,
        });
        bundle.push({ signer: sponsorWallet, transaction: sponsorTx });

        const { data: transferData } = await encodeFullTokenTransfer(
          httpProvider,
          tokenAddress,
          compromisedWallet.address,
          safeDestination
        );
        const transferTx = await buildTx(compromisedWallet, httpProvider, {
          to: tokenAddress,
          data: transferData,
          gasLimit: transferGasLimit,
          gasPlan,
          nonceOverride: nonce,
          chainId,
        });
        bundle.push({ signer: compromisedWallet, transaction: transferTx });
      }

      let included = false;
      for (let i = 1; i <= blocksToTry; i++) {
        const targetBlock = blockNumber + i;
        const signedBundle = await fbProvider.signBundle(bundle);
        const submission = await fbProvider.sendRawBundle(signedBundle, targetBlock);
        if ("error" in submission) {
          console.error(`[listen] Gagal kirim bundle ke block ${targetBlock}:`, submission.error.message);
          continue;
        }
        const resolution = await submission.wait();
        if (resolution === 0) {
          console.log(`[listen] BERHASIL diselamatkan di block ${targetBlock}!`);
          included = true;
          break;
        }
      }

      if (!included) {
        console.warn("[listen] Bundle belum masuk, akan mencoba lagi di block berikutnya jika saldo masih ada.");
      }
    } catch (err) {
      console.error("[listen] Error saat memproses block:", err);
    } finally {
      busy = false;
    }
  });

  // Biarkan proses tetap hidup
  await new Promise(() => {});
}
