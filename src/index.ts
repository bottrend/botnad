import "dotenv/config";
import { initSDK, parseEther, formatEther } from "@nadfun/sdk";
import { createServer } from "node:http";
import { createPublicClient, http, formatEther as viemFormatEther } from "viem";
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
const V2_ROUTER = "0x8986C8fD44eb85294A725a7e61AF35E76bA26F91" as const;
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });
const v2QuoteAbi = [{ type: "function", name: "getAmountOut", stateMutability: "view", inputs: [{name:"token",type:"address"},{name:"amountIn",type:"uint256"},{name:"isBuy",type:"bool"}], outputs: [{name:"amountOut",type:"uint256"}] }] as const;
const erc20Abi = [{ type:"function", name:"balanceOf", stateMutability:"view", inputs:[{name:"account",type:"address"}], outputs:[{name:"",type:"uint256"}] }] as const;
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
let realizedPnlMon = 0;
const PORT = Number(process.env.PORT ?? "8080");

createServer((req, res) => {
  const upper = anchor === null ? null : anchor * (1 + GRID_STEP);
  const lower = anchor === null ? null : anchor * (1 - GRID_STEP);
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, live: LIVE, walletAddress, monBalance, moeBalance, price: lastPrice, anchor, lower, upper, pending, buyCount, sellCount, realizedPnlMon, lastError }));
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
  <tr><td>Wallet</td><td>${walletAddress ?? "not configured"}</td></tr>\n  <tr><td>MON Balance</td><td>${monBalance === null ? "waiting..." : monBalance.toFixed(4)} MON</td></tr>\n  <tr><td>MOE Balance</td><td>${moeBalance === null ? "waiting..." : moeBalance.toFixed(4)} MOE</td></tr>\n  <tr><td>Current Price</td><td>${fmt(lastPrice)} MON/MOE</td></tr>
  <tr><td>Anchor</td><td>${fmt(anchor)} MON/MOE</td></tr>
  <tr><td class="buy">BUY ≤</td><td class="buy">${fmt(lower)} MON/MOE</td></tr>
  <tr><td class="sell">SELL ≥</td><td class="sell">${fmt(upper)} MON/MOE</td></tr>
  <tr><td>Grid Step</td><td>${(GRID_STEP*100).toFixed(2)}%</td></tr>
  <tr><td>Order Size</td><td>${TRADE_MOE} MOE</td></tr>
  <tr><td>BUY Count</td><td>${buyCount}</td></tr>
  <tr><td>SELL Count</td><td>${sellCount}</td></tr>
  <tr><td>Realized PnL</td><td>${realizedPnlMon.toFixed(6)} MON</td></tr>
  <tr><td>Last Trade</td><td>${lastTrade}</td></tr>
  <tr><td>Pending</td><td>${pending ? "YES" : "NO"}</td></tr>
  </table><div class="muted">Token: ${TOKEN_ADDRESS}<br>Last error: ${lastError ?? "none"}</div>
  <script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`);
}).listen(PORT, "0.0.0.0", () => console.log(`Dashboard listening on :${PORT}`));

