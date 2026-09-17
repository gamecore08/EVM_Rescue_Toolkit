import { ethers } from "ethers";

/** Standard ABI minimal ERC-20 yang dipakai berulang di seluruh toolkit. */
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export interface GasPlan {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Ambil basefee block saat ini & hitung maxFeePerGas yang aman untuk N block ke depan. */
export async function planGas(
  provider: ethers.JsonRpcProvider,
  priorityGwei = 2,
  blocksAhead = 3
): Promise<GasPlan> {
  const latest = await provider.getBlock("latest");
  const baseFee = latest?.baseFeePerGas ?? ethers.parseUnits("30", "gwei");

  // Basefee EVM bisa naik maksimal 12.5% per block, kita kasih buffer 25%/block
  // biar bundle kita tetap valid walau beberapa block basefee naik terus.
  let projected = baseFee;
  for (let i = 0; i < blocksAhead; i++) {
    projected = (projected * 1125n) / 1000n;
  }

  const maxPriorityFeePerGas = ethers.parseUnits(priorityGwei.toString(), "gwei");
  const maxFeePerGas = projected + maxPriorityFeePerGas;

  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Hitung total native coin yang harus dikirim sponsor -> compromised wallet
 * supaya cukup untuk membayar gas semua tx dari compromised wallet dalam bundle.
 */
export function estimateSponsorAmount(
  gasPlan: GasPlan,
  txs: { gasLimit: ethers.BigNumberish }[]
): bigint {
  let total = 0n;
  for (const tx of txs) {
    total += gasPlan.maxFeePerGas * BigInt(tx.gasLimit.toString());
  }
  // buffer 10% supaya tidak "insufficient funds" kalau basefee melonjak
  return (total * 110n) / 100n;
}

/** Bikin tx EIP-1559 siap-sign dari wallet manapun (sponsor atau compromised). */
export async function buildTx(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  params: {
    to: string;
    data?: string;
    value?: ethers.BigNumberish;
    gasLimit: ethers.BigNumberish;
    gasPlan: GasPlan;
    nonceOverride?: number;
    chainId: number;
  }
): Promise<ethers.TransactionRequest> {
  const nonce =
    params.nonceOverride ?? (await provider.getTransactionCount(wallet.address, "latest"));

  return {
    to: params.to,
    data: params.data ?? "0x",
    value: params.value ?? 0n,
    gasLimit: params.gasLimit,
    maxFeePerGas: params.gasPlan.maxFeePerGas,
    maxPriorityFeePerGas: params.gasPlan.maxPriorityFeePerGas,
    nonce,
    chainId: params.chainId,
    type: 2,
  };
}

/**
 * Encode transfer ERC-20 ke alamat tujuan.
 *
 * PENTING (fix bug "transfer 0 token"): jika token BELUM ada di wallet saat fungsi ini
 * dipanggil (mis. baru akan muncul setelah tx klaim di urutan sebelumnya dalam bundle
 * yang sama), `balanceOf()` di sini akan membaca 0 dan meng-encode transfer(0) yang percuma.
 *
 * Solusi: isi `expectedAmount` manual (dari --amount di CLI, atau hasil query
 * view function di kontrak klaim/staking) supaya jumlah yang di-encode BENAR
 * walau saldo saat ini masih 0. Kalau `expectedAmount` tidak diisi, fungsi ini
 * fallback membaca balanceOf() seperti biasa (aman dipakai untuk mode `listen`,
 * di mana token SUDAH ada di wallet saat fungsi ini dipanggil).
 */
export async function encodeFullTokenTransfer(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  ownerAddress: string,
  toAddress: string,
  expectedAmount?: ethers.BigNumberish
): Promise<{ data: string; amount: bigint }> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  let amount: bigint;

  if (expectedAmount !== undefined) {
    amount = BigInt(expectedAmount.toString());
  } else {
    amount = await token.balanceOf(ownerAddress);
  }

  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData("transfer", [toAddress, amount]);
  return { data, amount };
}

/** Ambil decimals & symbol token untuk keperluan tampilan / parsing --amount yang human-readable. */
export async function getTokenMeta(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string
): Promise<{ decimals: number; symbol: string }> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  try {
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    return { decimals: Number(decimals), symbol };
  } catch {
    // Sebagian token nonstandar tidak punya decimals()/symbol() - fallback aman.
    return { decimals: 18, symbol: "TOKEN" };
  }
}

/** Parse input --amount (string human-readable, mis. "1000" atau "0.5") jadi BigNumber sesuai decimals token. */
export function parseAmount(amountStr: string, decimals: number): bigint {
  return ethers.parseUnits(amountStr, decimals);
}
