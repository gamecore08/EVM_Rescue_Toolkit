/**
 * Konfigurasi per-chain.
 *
 * PENTING soal Flashbots: relay resmi Flashbots (relay.flashbots.net) itu
 * BUILT-IN hanya untuk Ethereum Mainnet (dan testnet-nya). Chain lain TIDAK
 * pakai relay Flashbots yang sama - kamu perlu private-tx endpoint versi
 * masing-masing chain. Beberapa alternatif yang umum dipakai (cek dokumentasi
 * resminya masing-masing sebelum pakai, endpoint bisa berubah):
 *
 *  - Ethereum Mainnet : Flashbots Protect / relay.flashbots.net
 *  - Polygon          : Merkle.io, atau bloXroute "Polygon Private Tx"
 *  - BSC              : 48 Club (bloxroute-like), atau BSC "MEV Guard" RPC privat
 *  - Arbitrum / Base   : sequencer sudah cukup cepat & privat by default,
 *                        tapi tetap bisa pakai MEV-Share/Flashbots Protect RPC di Base
 *
 * Di file ini kamu tinggal isi endpoint yang sesuai. Untuk chain non-Ethereum,
 * modul flashbotsClaim.ts & passiveSweeper.ts butuh sedikit penyesuaian bundle
 * provider - lihat komentar "NON_MAINNET_NOTE" di kedua file itu.
 */

export interface ChainConfig {
  chainId: number;
  name: string;
  nativeSymbol: string;
  flashbotsRelay: string | null; // Primary relay
  flashbotsRelays: string[]; // Multi-relay endpoints for maximum block inclusion
  explorer: string;
}

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: "Ethereum Mainnet",
    nativeSymbol: "ETH",
    flashbotsRelay: "https://relay.flashbots.net",
    flashbotsRelays: [
      "https://relay.flashbots.net",
      "https://rpc.titanbuilder.xyz",
      "https://rpc.beaverbuild.org",
      "https://rsync-builder.xyz",
    ],
    explorer: "https://etherscan.io",
  },
  11155111: {
    chainId: 11155111,
    name: "Sepolia Testnet",
    nativeSymbol: "ETH",
    flashbotsRelay: "https://relay-sepolia.flashbots.net",
    flashbotsRelays: [
      "https://relay-sepolia.flashbots.net",
    ],
    explorer: "https://sepolia.etherscan.io",
  },
  137: {
    chainId: 137,
    name: "Polygon",
    nativeSymbol: "MATIC",
    flashbotsRelay: null, // isi manual dengan private RPC provider pilihanmu
    flashbotsRelays: [],
    explorer: "https://polygonscan.com",
  },
  56: {
    chainId: 56,
    name: "BNB Smart Chain",
    nativeSymbol: "BNB",
    flashbotsRelay: null, // isi manual, mis. endpoint 48club
    flashbotsRelays: [],
    explorer: "https://bscscan.com",
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    nativeSymbol: "ETH",
    flashbotsRelay: null,
    flashbotsRelays: [],
    explorer: "https://arbiscan.io",
  },
  8453: {
    chainId: 8453,
    name: "Base",
    nativeSymbol: "ETH",
    flashbotsRelay: "https://rpc.flashbots.net/fast", // cek dokumentasi terbaru Base+Flashbots
    flashbotsRelays: ["https://rpc.flashbots.net/fast"],
    explorer: "https://basescan.org",
  },
};

export function getChainConfig(chainId: number): ChainConfig {
  const cfg = CHAINS[chainId];
  if (!cfg) {
    throw new Error(
      `Chain ${chainId} belum dikonfigurasi di src/config/chains.ts. Tambahkan dulu.`
    );
  }
  return cfg;
}
