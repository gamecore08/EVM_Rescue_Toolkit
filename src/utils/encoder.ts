import "dotenv/config";
import { ethers } from "ethers";
import inquirer from "inquirer";

/**
 * Helper CLI interaktif untuk menghasilkan CLAIM_CALLDATA tanpa perlu coding manual.
 * Jalankan: npm run encode
 *
 * Mendukung 2 cara:
 *  1. Preset fungsi umum (claim, withdraw, unstake(uint256)) - tinggal isi parameter
 *  2. ABI custom - tempel signature fungsi (mis. "claimTokens(address,uint256)")
 *     lalu isi argumennya satu per satu
 */

const PRESETS: Record<string, string[]> = {
  "claim() - tanpa parameter": [],
  "withdraw() - tanpa parameter": [],
  "unstake(uint256 amount)": ["uint256"],
  "claim(uint256 index, uint256 amount, bytes32[] proof) - merkle airdrop": [
    "uint256",
    "uint256",
    "bytes32[]",
  ],
  "Custom ABI signature...": [],
};

async function main() {
  console.log("=== EVM Rescue Toolkit - Calldata Encoder ===\n");

  const { presetChoice } = await inquirer.prompt([
    {
      type: "list",
      name: "presetChoice",
      message: "Pilih jenis fungsi klaim:",
      choices: Object.keys(PRESETS),
    },
  ]);

  let signature: string;
  let paramTypes: string[];

  if (presetChoice === "Custom ABI signature...") {
    const { customSig } = await inquirer.prompt([
      {
        type: "input",
        name: "customSig",
        message: 'Tempel signature fungsi (mis. "claimTokens(address,uint256)"):',
      },
    ]);
    signature = customSig.trim();
    const match = signature.match(/\(([^)]*)\)/);
    paramTypes = match && match[1].trim() ? match[1].split(",").map((s: string) => s.trim()) : [];
  } else {
    signature = presetChoice.split(" - ")[0].trim();
    paramTypes = PRESETS[presetChoice];
  }

  const values: any[] = [];
  for (let i = 0; i < paramTypes.length; i++) {
    const type = paramTypes[i];
    const { val } = await inquirer.prompt([
      {
        type: "input",
        name: "val",
        message: `Nilai untuk parameter #${i + 1} (${type}):` +
          (type.includes("[]") ? " (pisahkan dengan koma)" : ""),
      },
    ]);

    if (type.endsWith("[]")) {
      values.push(val.split(",").map((s: string) => s.trim()));
    } else if (type.startsWith("uint") || type.startsWith("int")) {
      values.push(val.trim());
    } else {
      values.push(val.trim());
    }
  }

  const iface = new ethers.Interface([`function ${signature}`]);
  const fnName = signature.split("(")[0].trim();
  const calldata = iface.encodeFunctionData(fnName, values);

  console.log("\n=== HASIL ===");
  console.log(`Function signature : ${signature}`);
  console.log(`Function selector  : ${calldata.slice(0, 10)}`);
  console.log(`Calldata lengkap   : ${calldata}`);
  console.log("\nSalin nilai 'Calldata lengkap' di atas ke CLAIM_CALLDATA di .env, atau ke flag --calldata.");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[error]", msg);
  process.exit(1);
});
