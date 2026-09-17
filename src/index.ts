import "dotenv/config";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runClaimMode } from "./modules/flashbotsClaim";
import { runListenMode } from "./modules/passiveSweeper";
import { runNftRescue } from "./modules/nftRescue";
import { runNativeSweep } from "./modules/nativeSweeper";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("mode", {
      choices: ["claim", "listen", "nft", "native"] as const,
      demandOption: true,
      describe:
        "claim  = kirim bundle sekali (unstake/klaim airdrop manual yang butuh dipanggil)\n" +
        "listen = pantau terus & auto-sweep begitu saldo token/native muncul\n" +
        "nft    = selamatkan 1 NFT ERC-721/1155 (butuh --nft, --tokenId, --standard)\n" +
        "native = selamatkan saldo native coin (ETH/BNB/dst) yang SUDAH ADA sekarang, sekali tembak",
    })
    .option("token", {
      type: "string",
      describe: "Alamat token ERC-20 target (mode claim/listen). Untuk native di mode listen, isi address(0).",
      default: process.env.TARGET_TOKEN_ADDRESS,
    })
    .option("contract", {
      type: "string",
      describe: "Alamat kontrak klaim (opsional, mode claim)",
      default: process.env.CLAIM_CONTRACT_ADDRESS,
    })
    .option("calldata", {
      type: "string",
      describe: "Calldata terenkode untuk fungsi klaim (opsional, mode claim). Bisa digenerate via `npm run encode`.",
      default: process.env.CLAIM_CALLDATA,
    })
    .option("amount", {
      type: "string",
      describe:
        "Mode claim: jumlah token yang diharapkan (human-readable, mis. \"1000\"). " +
        "WAJIB diisi (atau pakai --all) kalau --contract diisi, supaya tidak mengirim 0 token.",
    })
    .option("all", {
      type: "boolean",
      default: false,
      describe: "Mode claim: pakai balanceOf() apa adanya (hanya aman jika token SUDAH ada di wallet saat ini).",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Mode claim: hanya simulasi (fbProvider.simulate), tidak broadcast beneran.",
    })
    .option("nft", {
      type: "string",
      describe: "Alamat kontrak NFT (mode nft)",
    })
    .option("tokenId", {
      type: "string",
      describe: "Token ID NFT yang mau diselamatkan (mode nft)",
    })
    .option("standard", {
      choices: ["erc721", "erc1155"] as const,
      default: "erc721" as const,
      describe: "Standar NFT (mode nft)",
    })
    .option("nftAmount", {
      type: "string",
      default: "1",
      describe: "Jumlah untuk ERC-1155 (mode nft, default 1)",
    })
    .option("blocks", {
      type: "number",
      describe: "Jumlah block yang dicoba sebelum menyerah",
      default: Number(process.env.BLOCKS_TO_TRY ?? 5),
    })
    .strict()
    .help().argv;

  const required = [
    "RPC_HTTP_URL",
    "CHAIN_ID",
    "COMPROMISED_PRIVATE_KEY",
    "SPONSOR_PRIVATE_KEY",
    "FLASHBOTS_AUTH_SIGNER_KEY",
    "SAFE_DESTINATION_ADDRESS",
    "FLASHBOTS_RELAY_URL",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`[error] Env var ${key} belum diisi. Cek file .env kamu (contoh: .env.example).`);
      process.exit(1);
    }
  }

  const common = {
    rpcHttpUrl: process.env.RPC_HTTP_URL!,
    chainId: Number(process.env.CHAIN_ID),
    compromisedPrivateKey: process.env.COMPROMISED_PRIVATE_KEY!,
    sponsorPrivateKey: process.env.SPONSOR_PRIVATE_KEY!,
    authSignerKey: process.env.FLASHBOTS_AUTH_SIGNER_KEY!,
    safeDestination: process.env.SAFE_DESTINATION_ADDRESS!,
    flashbotsRelayUrl: process.env.FLASHBOTS_RELAY_URL!,
    blocksToTry: argv.blocks,
  };

  if (argv.mode === "claim") {
    if (!argv.token) {
      console.error("[error] --token wajib diisi untuk mode claim.");
      process.exit(1);
    }
    await runClaimMode({
      ...common,
      tokenAddress: argv.token,
      claimContractAddress: argv.contract,
      claimCalldata: argv.calldata,
      amountHuman: argv.amount,
      useAll: argv.all,
      dryRun: argv["dry-run"],
    });
    process.exit(0);
  }

  if (argv.mode === "listen") {
    if (!process.env.RPC_WSS_URL) {
      console.error("[error] RPC_WSS_URL wajib diisi untuk mode listen (butuh WebSocket).");
      process.exit(1);
    }
    if (!argv.token) {
      console.error("[error] --token wajib diisi untuk mode listen (isi address(0) untuk native coin).");
      process.exit(1);
    }
    await runListenMode({
      ...common,
      rpcWssUrl: process.env.RPC_WSS_URL!,
      tokenAddress: argv.token,
    });
    return; // listen mode berjalan terus (blocking), tidak exit otomatis
  }

  if (argv.mode === "nft") {
    if (!argv.nft || !argv.tokenId) {
      console.error("[error] --nft dan --tokenId wajib diisi untuk mode nft.");
      process.exit(1);
    }
    await runNftRescue({
      ...common,
      nftAddress: argv.nft,
      tokenId: argv.tokenId,
      standard: argv.standard,
      amount: argv.nftAmount,
    });
    process.exit(0);
  }

  if (argv.mode === "native") {
    await runNativeSweep(common);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
