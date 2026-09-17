import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Script pembantu untuk setup skenario simulasi di Sepolia Testnet.
 *
 * Script ini:
 * 1. Men-deploy MockToken ($MRT) ke Sepolia
 * 2. Men-deploy MockStaking ke Sepolia
 * 3. Mendaftarkan alamat wallet korban (COMPROMISED_PRIVATE_KEY) ke posisi fakeStake
 * 4. Mencetak perintah CLI yang siap langsung dijalankan untuk latihan penyelamatan!
 *
 * Jalankan:
 *   npx hardhat run scripts/deployMockSepolia.ts --network sepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("=== Setup Latihan Sepolia Testnet ===");
  console.log(`Deployer (Sponsor): ${deployer.address}`);

  const compromisedKey = process.env.COMPROMISED_PRIVATE_KEY;
  if (!compromisedKey) {
    throw new Error("COMPROMISED_PRIVATE_KEY belum diisi di .env");
  }
  const compromisedWallet = new ethers.Wallet(compromisedKey);
  console.log(`Victim Wallet    : ${compromisedWallet.address}\n`);

  console.log("1. Men-deploy MockToken...");
  const MockToken = await ethers.getContractFactory("MockToken");
  const token = await MockToken.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`   ✅ MockToken deployed di: ${tokenAddress}`);

  console.log("2. Men-deploy MockStaking...");
  const MockStaking = await ethers.getContractFactory("MockStaking");
  const staking = await MockStaking.deploy(tokenAddress);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(`   ✅ MockStaking deployed di: ${stakingAddress}`);

  console.log("3. Mendaftarkan Victim Wallet ke posisi staking...");
  const tx = await staking.fakeStake(compromisedWallet.address);
  await tx.wait();
  console.log(`   ✅ Victim berhasil didaftarkan (posisi stake aktif, saldo token saat ini = 0)`);

  const iface = new ethers.Interface(["function claim()"]);
  const calldata = iface.encodeFunctionData("claim", []);

  console.log("\n=======================================================");
  console.log("🎉 SETUP SELESAI! Silakan coba latihan simulasi rescue:");
  console.log("=======================================================\n");

  console.log("👉 Perintah Simulasi (Dry-Run):");
  console.log(
    `npm run rescue -- --mode claim --contract ${stakingAddress} --calldata ${calldata} --token ${tokenAddress} --amount 1000 --dry-run\n`
  );

  console.log("👉 Perintah Eksekusi Nyata di Sepolia:");
  console.log(
    `npm run rescue -- --mode claim --contract ${stakingAddress} --calldata ${calldata} --token ${tokenAddress} --amount 1000\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
