import "dotenv/config";
import { initSDK, parseEther, formatEther } from "@nadfun/sdk";
import { createServer } from "node:http";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "143");
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS as `0x${string}`;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const GRID_STEP = Number(process.env.GRID_STEP ?? "0.07");
const TRADE_MOE = Number(process.env.TRADE_MOE ?? "190");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");
const SLIPPAGE_PERCENT = Number(process.env.SLIPPAGE_PERCENT ?? "1");
const LIVE = (process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";

if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS is required");
if (LIVE && !PRIVATE_KEY) throw new Error("PRIVATE_KEY is required when LIVE_TRADING_ENABLED=true");

const READ_ONLY_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const sdk = initSDK({
  rpcUrl: RPC_URL,
  privateKey: PRIVATE_KEY ?? READ_ONLY_KEY,
  network: "mainnet"
});
const tradeAmount = parseEther(String(TRADE_MOE));
let anchor: number | null = null;
let pending = false;
let lastPrice: number | null = null;
let lastError: string | null = null;
const PORT = Number(process.env.PORT ?? "8080");

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: LIVE, price: lastPrice, anchor, pending }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOE Grid Bot</title><style>body{font-family:system-ui;background:#111;color:#eee;padding:24px}.card{max-width:680px;margin:auto;background:#1d1d1d;padding:24px;border-radius:16px}b{color:#8ee3a1}code{word-break:break-all}</style></head><body><div class="card"><h2>MOE Grid Bot</h2><p>Status: <b>${LIVE ? "LIVE" : "DRY RUN"}</b></p><p>Price: ${lastPrice ?? "waiting..."} MON/MOE</p><p>Anchor: ${anchor ?? "waiting..."}</p><p>Grid: ${GRID_STEP * 100}%</p><p>Order: ${TRADE_MOE} MOE</p><p>Pending: ${pending}</p><p>Token: <code>${TOKEN_ADDRESS}</code></p><p>Last error: ${lastError ?? "none"}</p><script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`);
}).listen(PORT, "0.0.0.0", () => console.log(`Dashboard listening on :${PORT}`));

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
    if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

    if (side === "SELL") {
      const balance = await sdk.getBalance(TOKEN_ADDRESS);
      if (balance < tradeAmount) throw new Error("Insufficient MOE balance");
      await sdk.simpleSell({ token: TOKEN_ADDRESS, amountIn: tradeAmount, slippagePercent: SLIPPAGE_PERCENT });
    } else {
      const required = await sdk.getAmountIn(TOKEN_ADDRESS, tradeAmount, true);
      await sdk.simpleBuy({ token: TOKEN_ADDRESS, amountIn: required.amount, slippagePercent: SLIPPAGE_PERCENT });
    }

    anchor = await priceMonPerMoe();
    console.log(`FILLED ${side}; new anchor=${anchor}`);
  } finally {
    pending = false;
  }
}

async function main() {
  const actualChainId = Number.parseInt(String(await rpc("eth_chainId")), 16);
  if (actualChainId !== CHAIN_ID || actualChainId !== 143) {
    throw new Error(`Wrong chain: expected 143, got ${actualChainId}`);
  }

  console.log("MOE grid bot started", {
    token: TOKEN_ADDRESS, grid: GRID_STEP, tradeMoe: TRADE_MOE,
    pollMs: POLL_INTERVAL_MS, live: LIVE, signerConfigured: Boolean(PRIVATE_KEY)
  });

  for (;;) {
    try {
      const px = await priceMonPerMoe();
      lastPrice = px;
      lastError = null;
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
      lastError = err instanceof Error ? err.message : String(err);
      console.error("loop error", err);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
