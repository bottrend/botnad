import "dotenv/config";
import { parseUnits } from "viem";
import { createServer } from "node:http";
import { createPublicClient, http, formatEther as viemFormatEther, formatUnits } from "viem";
import { monad } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL ?? "https://rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "143");
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS as `0x${string}`;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const PRIVATE_KEY = RAW_PRIVATE_KEY ? (RAW_PRIVATE_KEY.startsWith("0x") ? RAW_PRIVATE_KEY : `0x${RAW_PRIVATE_KEY}`) as `0x${string}` : undefined;
const GRID_STEP = Number(process.env.GRID_STEP ?? "0.07");
const TRADE_MOE = Number(process.env.TRADE_MOE ?? "190");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");
const SLIPPAGE_PERCENT = Number(process.env.SLIPPAGE_PERCENT ?? "1");
const MIN_ROUNDTRIP_MARGIN = Number(process.env.MIN_ROUNDTRIP_MARGIN ?? "0.0025");
const LIVE = (process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";

if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS is required");
if (LIVE && !PRIVATE_KEY) throw new Error("PRIVATE_KEY is required when LIVE_TRADING_ENABLED=true");

let tokenDecimals = 18;
let tradeAmount = parseUnits(String(TRADE_MOE), tokenDecimals);
const V2_ROUTER = "0x8986C8fD44eb85294A725a7e61AF35E76bA26F91" as const;
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });
const v2QuoteAbi = [{ type: "function", name: "getAmountOut", stateMutability: "view", inputs: [{name:"token",type:"address"},{name:"amountIn",type:"uint256"},{name:"isBuy",type:"bool"}], outputs: [{name:"amountOut",type:"uint256"}] }] as const;
const erc20Abi = [
  { type:"function", name:"balanceOf", stateMutability:"view", inputs:[{name:"account",type:"address"}], outputs:[{name:"",type:"uint256"}] },
  { type:"function", name:"decimals", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint8"}] }
] as const;
const walletAddress = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY).address : null;
let monBalance: number | null = null;
let moeBalance: number | null = null;
let anchor: number | null = null;
let pending = false;
let lastPrice: number | null = null;
let lastError: string | null = null;
let buyCount = 0;
let sellCount = 0;
let lastTrade = "None";
let initialMon: number | null = null;
let initialMoe: number | null = null;
let totalTrades = 0;
let guard: string | null = null;
let started: string | null = null;
type LastTrade = { side: "BUY"|"SELL"; triggerPrice: number; fillPrice: number; txHash?: string; time: string };
let lastTradeInfo: LastTrade | null = null;
const PORT = Number(process.env.PORT ?? "8080");

createServer((req, res) => {
  const upper = anchor === null ? null : anchor * (1 + GRID_STEP);
  const lower = anchor === null ? null : anchor * (1 - GRID_STEP);
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    const totalMon = lastPrice !== null && monBalance !== null && moeBalance !== null ? monBalance + moeBalance * lastPrice : null;
    const initialTotalMon = lastPrice !== null && initialMon !== null && initialMoe !== null ? initialMon + initialMoe * lastPrice : null;
    const pnlMon = totalMon !== null && initialTotalMon !== null ? totalMon - initialTotalMon : null;
    res.end(JSON.stringify({ ok: true, live: LIVE, walletAddress, monBalance, moeBalance, price: lastPrice, anchor, lower, upper, pending, buyCount, sellCount, totalTrades, totalMon, pnlMon, guard, started, lastTradeInfo, lastError }));
    return;
  }
  const fmt = (v: number | null) => v === null ? "waiting..." : v.toFixed(9);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOE Grid Bot</title><style>
  body{font-family:system-ui;background:#101010;color:#eee;margin:0;padding:18px}.card{max-width:760px;margin:auto;background:#1d1d1d;padding:22px;border-radius:16px}
  h2{margin-top:0}.status{font-weight:700;color:#8ee3a1}table{width:100%;border-collapse:collapse;margin-top:14px}td{padding:10px 6px;border-bottom:1px solid #333}td:last-child{text-align:right;font-weight:600;word-break:break-word}
  .buy{color:#72d98b}.sell{color:#ff8b8b}.muted{color:#aaa;font-size:13px;margin-top:18px;word-break:break-all}</style></head><body><div class="card">
  <h2>MOE Grid Bot</h2><table>
  <tr><td>Status</td><td class="status">${LIVE ? "LIVE" : "DRY RUN"}</td></tr>
  <tr><td>Wallet</td><td>${walletAddress ?? "not configured"}</td></tr>\n  <tr><td>MON Balance</td><td>${monBalance === null ? "waiting..." : Number(monBalance).toFixed(4)} MON</td></tr>\n  <tr><td>MOE Balance</td><td>${moeBalance === null ? "waiting..." : Number(moeBalance).toFixed(4)} MOE</td></tr>\n  <tr><td>Current Price</td><td>${fmt(lastPrice)} MON/MOE</td></tr>
  <tr><td>Anchor</td><td>${fmt(anchor)} MON/MOE</td></tr>
  <tr><td class="buy">BUY ≤</td><td class="buy">${fmt(lower)} MON/MOE</td></tr>
  <tr><td class="sell">SELL ≥</td><td class="sell">${fmt(upper)} MON/MOE</td></tr>
  <tr><td>Grid Step</td><td>${(GRID_STEP*100).toFixed(2)}%</td></tr>
  <tr><td>Order Size</td><td>${TRADE_MOE} MOE</td></tr>
  <tr><td>Total Value</td><td>${lastPrice !== null && monBalance !== null && moeBalance !== null ? (monBalance + moeBalance * lastPrice).toFixed(4) : "waiting..."} MON</td></tr>\n  <tr><td>BUY Count</td><td>${buyCount}</td></tr>
  <tr><td>SELL Count</td><td>${sellCount}</td></tr>\n  <tr><td>Total Orders</td><td>${totalTrades}</td></tr>
  <tr><td>PnL vs Start</td><td>${lastPrice !== null && monBalance !== null && moeBalance !== null && initialMon !== null && initialMoe !== null ? ((monBalance + moeBalance*lastPrice) - (initialMon + initialMoe*lastPrice)).toFixed(6) : "waiting..."} MON</td></tr>
  <tr><td>Last Trade</td><td>${lastTrade}</td></tr>
  <tr><td>Pending</td><td>${pending ? "YES" : "NO"}</td></tr>
  </table><div class="muted">Token: ${TOKEN_ADDRESS}<br>Started: ${started ?? "waiting..."}<br>Guard: ${guard ?? "none"}<br>Last error: ${lastError ?? "none"}</div>
  <script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`);
}).listen(PORT, "0.0.0.0", () => console.log(`Dashboard listening on :${PORT}`));


async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const data = await res.json() as { result?: unknown; error?: unknown };
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function priceMonPerMoe(): Promise<number> {
  const amountOut = await publicClient.readContract({ address: V2_ROUTER, abi: v2QuoteAbi, functionName: "getAmountOut", args: [TOKEN_ADDRESS, tradeAmount, false] });
  const monOut = Number(viemFormatEther(amountOut));
  if (!(monOut > 0)) throw new Error("Invalid V2 sell quote");
  return monOut / TRADE_MOE;
}

async function refreshBalances() {
  if (!walletAddress) return;
  const [native, token] = await Promise.all([
    publicClient.getBalance({ address: walletAddress }),
    publicClient.readContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] })
  ]);
  monBalance = Number(viemFormatEther(native));
  moeBalance = Number(formatUnits(token, tokenDecimals));
}

async function requiredMonForBuy(): Promise<number> {
  const oneMoeInMon = await priceMonPerMoe();
  return TRADE_MOE * oneMoeInMon * (1 + SLIPPAGE_PERCENT / 100);
}

async function executeDry(side: "BUY" | "SELL", triggerPrice: number): Promise<boolean> {
  if (pending) return false;
  const prev = lastTradeInfo;
  if (prev) {
    if (side === "BUY" && prev.side === "BUY" && triggerPrice >= prev.fillPrice) { guard = "BUY blocked: not below previous BUY"; return false; }
    if (side === "SELL" && prev.side === "SELL" && triggerPrice <= prev.fillPrice) { guard = "SELL blocked: not above previous SELL"; return false; }
    if (side === "BUY" && prev.side === "SELL" && triggerPrice >= prev.fillPrice * (1 - MIN_ROUNDTRIP_MARGIN)) { guard = "BUY blocked: round-trip margin"; return false; }
    if (side === "SELL" && prev.side === "BUY" && triggerPrice <= prev.fillPrice * (1 + MIN_ROUNDTRIP_MARGIN)) { guard = "SELL blocked: round-trip margin"; return false; }
  }
  if (side === "SELL" && (moeBalance ?? 0) < TRADE_MOE) { guard = "SELL blocked: insufficient MOE"; return false; }
  if (side === "BUY") {
    const needMon = await requiredMonForBuy();
    if ((monBalance ?? 0) < needMon) { guard = `BUY blocked: insufficient MON (need ~${needMon.toFixed(4)})`; return false; }
  }
  pending = true; guard = null;
  try {
    if (LIVE) throw new Error("LIVE execution remains locked until NadFun V2 transaction routing is enabled");
    if (side === "BUY") buyCount++; else sellCount++;
    totalTrades++;
    const fillPrice = triggerPrice;
    lastTrade = `${side} ${TRADE_MOE} MOE @ ~${fillPrice.toFixed(9)}`;
    lastTradeInfo = { side, triggerPrice, fillPrice, time: new Date().toISOString() };
    anchor = fillPrice;
    console.log(`DRY RUN ${lastTrade}`);
    return true;
  } finally { pending = false; }
}

async function main() {
  tokenDecimals = Number(await publicClient.readContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: "decimals" }));
  tradeAmount = parseUnits(String(TRADE_MOE), tokenDecimals);
  const actualChainId = Number.parseInt(String(await rpc("eth_chainId")), 16);
  if (actualChainId !== CHAIN_ID || actualChainId !== 143) throw new Error(`Wrong chain: expected 143, got ${actualChainId}`);
  console.log("MOE grid bot started", { token: TOKEN_ADDRESS, grid: GRID_STEP, tradeMoe: TRADE_MOE, pollMs: POLL_INTERVAL_MS, live: LIVE, wallet: walletAddress });
  for (;;) {
    try {
      await refreshBalances();
      const px = await priceMonPerMoe();
      lastPrice = px; lastError = null;
      if (anchor === null) { anchor = px; initialMon = monBalance; initialMoe = moeBalance; started = new Date().toISOString(); console.log(`Initial anchor=${anchor}`); }
      else {
        while (!pending && anchor !== null && px >= anchor * (1 + GRID_STEP)) {
          const level = anchor * (1 + GRID_STEP);
          if (!(await executeDry("SELL", level))) break;
        }
        while (!pending && anchor !== null && px <= anchor * (1 - GRID_STEP)) {
          const level = anchor * (1 - GRID_STEP);
          if (!(await executeDry("BUY", level))) break;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("loop error", lastError);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
main().catch(err => { console.error(err); process.exit(1); });
