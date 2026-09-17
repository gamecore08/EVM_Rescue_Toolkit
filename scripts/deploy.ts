import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const safeDestination = process.env.SAFE_DESTINATION_ADDRESS;
  if (!safeDestination) {
    throw new Error("SAFE_DESTINATION_ADDRESS belum diisi di .env");
  }

  console.log(`Deploying Rescuer.sol dengan safeDestination = ${safeDestination} ...`);

  const Rescuer = await ethers.getContractFactory("Rescuer");
  const rescuer = await Rescuer.deploy(safeDestination);
  await rescuer.waitForDeployment();

  const address = await rescuer.getAddress();
  console.log(`✅ Rescuer.sol berhasil dideploy di: ${address}`);
  console.log(`   Simpan alamat ini - dibutuhkan untuk memanggil rescueERC20/rescueERC721/rescueERC1155 lewat bundle.`);
  console.log(`   Verifikasi (opsional): npx hardhat verify --network <network> ${address} ${safeDestination}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
