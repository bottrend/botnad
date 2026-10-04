import "dotenv/config";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "143");
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? "";
const GRID_STEP = Number(process.env.GRID_STEP ?? "0.07");
const TRADE_MOE = Number(process.env.TRADE_MOE ?? "190");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");
const LIVE = (process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data = await res.json() as { result?: unknown; error?: unknown };
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function main() {
  if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS is required");
  const hexChainId = String(await rpc("eth_chainId"));
  const actualChainId = Number.parseInt(hexChainId, 16);
  if (actualChainId !== CHAIN_ID) {
    throw new Error(`Wrong chain: expected ${CHAIN_ID}, got ${actualChainId}`);
  }

  console.log("botnad config loaded");
  console.log({ chainId: actualChainId, token: TOKEN_ADDRESS, gridStep: GRID_STEP, tradeMoe: TRADE_MOE, pollMs: POLL_INTERVAL_MS, live: LIVE });
  if (LIVE) {
    console.warn("LIVE_TRADING_ENABLED=true, but transaction execution is not enabled in this bootstrap.");
  }

  for (;;) {
    const block = await rpc("eth_blockNumber");
    console.log(`RPC OK block=${block} live=${LIVE}`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
