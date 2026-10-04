import "dotenv/config";
import { initSDK, parseEther, formatEther } from "@nadfun/sdk";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "143");
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS as `0x${string}`;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
const GRID_STEP = Number(process.env.GRID_STEP ?? "0.07");
const TRADE_MOE = Number(process.env.TRADE_MOE ?? "190");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");
const SLIPPAGE_PERCENT = Number(process.env.SLIPPAGE_PERCENT ?? "1");
const LIVE = (process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";

if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS is required");
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");

const sdk = initSDK({ rpcUrl: RPC_URL, privateKey: PRIVATE_KEY, network: "mainnet" });
const tradeAmount = parseEther(String(TRADE_MOE));
let anchor: number | null = null;
let pending = false;

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

async function priceMonPerMoe(): Promise<number> {
  const q = await sdk.getAmountOut(TOKEN_ADDRESS, tradeAmount, false);
  const monOut = Number(formatEther(q.amount));
  if (!(monOut > 0)) throw new Error("Invalid sell quote");
  return monOut / TRADE_MOE;
}

async function execute(side: "BUY" | "SELL", triggerPrice: number) {
  if (pending) return;
  pending = true;
  try {
    if (!LIVE) {
      console.log(`DRY RUN ${side} ${TRADE_MOE} MOE @ ~${triggerPrice} MON/MOE`);
      anchor = triggerPrice;
      return;
    }

    if (side === "SELL") {
      const balance = await sdk.getBalance(TOKEN_ADDRESS);
      if (balance < tradeAmount) throw new Error("Insufficient MOE balance");
      await sdk.simpleSell({ token: TOKEN_ADDRESS, amountIn: tradeAmount, slippagePercent: SLIPPAGE_PERCENT });
    } else {
      const required = await sdk.getAmountIn(TOKEN_ADDRESS, tradeAmount, true);
      await sdk.simpleBuy({ token: TOKEN_ADDRESS, amountIn: required.amount, slippagePercent: SLIPPAGE_PERCENT });
    }

    const fillDerivedPrice = await priceMonPerMoe();
    anchor = fillDerivedPrice;
    console.log(`FILLED ${side}; new anchor=${anchor}`);
  } finally {
    pending = false;
  }
}

async function main() {
  const hexChainId = String(await rpc("eth_chainId"));
  const actualChainId = Number.parseInt(hexChainId, 16);
  if (actualChainId !== CHAIN_ID || actualChainId !== 143) {
    throw new Error(`Wrong chain: expected 143, got ${actualChainId}`);
  }

  console.log("MOE grid bot started", { token: TOKEN_ADDRESS, grid: GRID_STEP, tradeMoe: TRADE_MOE, pollMs: POLL_INTERVAL_MS, live: LIVE });

  for (;;) {
    try {
      const px = await priceMonPerMoe();
      if (anchor === null) {
        anchor = px;
        console.log(`Initial anchor=${anchor}`);
      } else {
        const upper = anchor * (1 + GRID_STEP);
        const lower = anchor * (1 - GRID_STEP);
        console.log(`price=${px.toFixed(9)} anchor=${anchor.toFixed(9)} buy<=${lower.toFixed(9)} sell>=${upper.toFixed(9)}`);

        if (!pending && px >= upper) await execute("SELL", px);
        else if (!pending && px <= lower) await execute("BUY", px);
      }
    } catch (err) {
      console.error("loop error", err);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
