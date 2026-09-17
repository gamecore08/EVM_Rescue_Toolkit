import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Konfigurasi Hardhat untuk compile, test, dan deploy Rescuer.sol.
 * Pakai SPONSOR_PRIVATE_KEY (bukan compromised key!) untuk deploy,
 * karena kontrak ini cukup dideploy sekali oleh wallet bersih.
 */
const SPONSOR_PRIVATE_KEY = process.env.SPONSOR_PRIVATE_KEY || "";
const RPC_HTTP_URL = process.env.RPC_HTTP_URL || "";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {}, // untuk unit test lokal (in-memory chain)
    mainnet: {
      url: RPC_HTTP_URL,
      accounts: SPONSOR_PRIVATE_KEY ? [SPONSOR_PRIVATE_KEY] : [],
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: SPONSOR_PRIVATE_KEY ? [SPONSOR_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
};

export default config;
