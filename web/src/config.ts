export const CONTRACT = import.meta.env.VITE_CONTRACT ?? "trueque.testnet";
export const USDC_TOKEN = import.meta.env.VITE_USDC ?? "usdc.trueque.testnet";
export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const LIGHT_CLIENT = "btc-client-v4.testnet";
export const NEAR_NETWORK = "testnet" as const;
export const NEAR_RPC = import.meta.env.VITE_NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
export const NEAR_EXPLORER = "https://testnet.nearblocks.io";
export const BTC_NETWORK_LABEL = "Bitcoin testnet";
export const BTC_EXPLORER = "https://mempool.space/testnet";
/** Address and broadcast APIs. */
export const ESPLORAS = ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"];
/** Bitcoin Core RPC used to build SPV proofs (CORS enabled). */
export const BTC_RPC = import.meta.env.VITE_BTC_RPC ?? "https://bitcoin-testnet-rpc.publicnode.com";
export const FAUCET_HELPER = "https://helper.nearprotocol.com/account";
export const REPO_URL = "https://github.com/JafetCHVDev/trueque";
/** The first release, on Bitcoin signet without on chain deposit proofs. */
export const LEGACY_CONTRACT = "market.trueque.testnet";

export const GAS_TAKE = 300_000_000_000_000n;
export const GAS_DEFAULT = 100_000_000_000_000n;
