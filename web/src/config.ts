export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "market.trueque.testnet";
export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const NEAR_NETWORK = "testnet" as const;
export const NEAR_RPC = import.meta.env.VITE_NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
export const NEAR_EXPLORER = "https://testnet.nearblocks.io";
export const BTC_NETWORK_LABEL = "Bitcoin signet";
export const BTC_EXPLORER = "https://mempool.space/signet";
export const ESPLORAS = ["https://blockstream.info/signet/api", "https://mempool.space/signet/api"];
export const FAUCET_HELPER = "https://helper.nearprotocol.com/account";
export const REPO_URL = "https://github.com/JafetCHVDev/trueque";

export const GAS_TAKE = 300_000_000_000_000n;
export const GAS_DEFAULT = 100_000_000_000_000n;
