#!/usr/bin/env node

// src/engine/types.ts
var LAMPORTS_PER_SOL = 1e9;
var WSOL_MINT = "So11111111111111111111111111111111111111112";
var STABLE_MINTS = /* @__PURE__ */ new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  // USDT
]);

// src/engine/extract.ts
var MIN_TRADE_LAMPORTS = 1e4;
function keyAt(tx, i) {
  const k = tx.transaction.message.accountKeys[i];
  return typeof k === "string" ? k : k.pubkey;
}
function rawAmount(b) {
  return b ? BigInt(b.uiTokenAmount.amount) : 0n;
}
function toUi(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}
function extract(tx, wallet) {
  const signature = tx.transaction.signatures[0];
  const meta = tx.meta;
  if (!meta) return { kind: "skip", reason: "no-meta" };
  if (meta.err) return { kind: "skip", reason: "failed" };
  const keys = tx.transaction.message.accountKeys;
  let walletIdx = -1;
  for (let i = 0; i < keys.length; i++) if (keyAt(tx, i) === wallet) {
    walletIdx = i;
    break;
  }
  if (walletIdx < 0) return { kind: "skip", reason: "wallet-not-in-tx" };
  const isFeePayer = walletIdx === 0;
  let lamports = meta.postBalances[walletIdx] - meta.preBalances[walletIdx];
  const pre = (meta.preTokenBalances ?? []).filter((b) => b.owner === wallet);
  const post = (meta.postTokenBalances ?? []).filter((b) => b.owner === wallet);
  const accounts = new Set([...pre, ...post].map((b) => b.accountIndex));
  const mintDelta = /* @__PURE__ */ new Map();
  for (const idx of accounts) {
    const a = pre.find((b2) => b2.accountIndex === idx);
    const b = post.find((x) => x.accountIndex === idx);
    const mint2 = (a ?? b).mint;
    const decimals = (a ?? b).uiTokenAmount.decimals;
    if (isFeePayer && !a && b) lamports += meta.postBalances[idx];
    if (isFeePayer && a && !b) lamports -= meta.preBalances[idx];
    const delta = rawAmount(b) - rawAmount(a);
    if (mint2 === WSOL_MINT) {
      lamports += Number(delta);
      continue;
    }
    if (delta === 0n) continue;
    const cur = mintDelta.get(mint2);
    mintDelta.set(mint2, { raw: (cur?.raw ?? 0n) + delta, decimals });
  }
  for (const [m, d2] of mintDelta) if (d2.raw === 0n) mintDelta.delete(m);
  if (mintDelta.size === 0) return { kind: "skip", reason: "no-token-change" };
  if ([...mintDelta.keys()].some((m) => STABLE_MINTS.has(m))) return { kind: "skip", reason: "stable-swap" };
  if (mintDelta.size > 1) return { kind: "skip", reason: "multi-token" };
  const [mint, d] = [...mintDelta.entries()][0];
  const tokenAmount = toUi(d.raw < 0n ? -d.raw : d.raw, d.decimals);
  const time = tx.blockTime ?? 0;
  const exFee = isFeePayer ? lamports + meta.fee : lamports;
  if (Math.abs(exFee) < MIN_TRADE_LAMPORTS) {
    return { kind: "transfer", transfer: { signature, time, mint, tokenAmount: d.raw > 0n ? tokenAmount : -tokenAmount } };
  }
  if (d.raw > 0n && lamports < 0) {
    return { kind: "trade", trade: { signature, time, side: "buy", mint, tokenAmount, lamports: -lamports } };
  }
  if (d.raw < 0n && lamports > 0) {
    return { kind: "trade", trade: { signature, time, side: "sell", mint, tokenAmount, lamports } };
  }
  return { kind: "skip", reason: "same-direction" };
}

// src/engine/pnl.ts
var CLOSED_RATIO = 0.99;
function buildPositions(trades) {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const byMint = /* @__PURE__ */ new Map();
  for (const t of sorted) {
    let entry = byMint.get(t.mint);
    if (!entry) {
      entry = { pos: emptyPosition(t.mint, t.time), lots: [] };
      byMint.set(t.mint, entry);
    }
    const { pos, lots } = entry;
    if (t.side === "buy") {
      if (pos.buys === 0) pos.firstBuy = t.time;
      pos.buys++;
      pos.boughtTokens += t.tokenAmount;
      pos.costLamports += t.lamports;
      lots.push({ tokens: t.tokenAmount, lamports: t.lamports });
      continue;
    }
    pos.sells++;
    let left = t.tokenAmount;
    let matched = 0;
    let matchedCost = 0;
    while (left > 1e-12 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.tokens, left);
      const cost = lot.lamports * (take / lot.tokens);
      lot.tokens -= take;
      lot.lamports -= cost;
      left -= take;
      matched += take;
      matchedCost += cost;
      if (lot.tokens <= 1e-12) lots.shift();
    }
    if (matched > 0) {
      const proceeds = t.lamports * (matched / t.tokenAmount);
      pos.soldTokens += matched;
      pos.matchedCostLamports += matchedCost;
      pos.proceedsLamports += proceeds;
      pos.lastSell = t.time;
    }
    pos.unmatchedSoldTokens += left > 1e-12 ? left : 0;
  }
  const out = [];
  for (const { pos, lots } of byMint.values()) {
    if (pos.buys === 0) continue;
    pos.remainingTokens = lots.reduce((s, l) => s + l.tokens, 0);
    pos.realizedLamports = pos.proceedsLamports - pos.matchedCostLamports;
    pos.closed = pos.soldTokens >= pos.boughtTokens * CLOSED_RATIO;
    pos.holdSeconds = pos.closed && pos.lastSell !== null ? pos.lastSell - pos.firstBuy : null;
    out.push(pos);
  }
  return out;
}
function emptyPosition(mint, time) {
  return {
    mint,
    firstBuy: time,
    lastSell: null,
    buys: 0,
    sells: 0,
    boughtTokens: 0,
    soldTokens: 0,
    costLamports: 0,
    matchedCostLamports: 0,
    proceedsLamports: 0,
    unmatchedSoldTokens: 0,
    remainingTokens: 0,
    realizedLamports: 0,
    closed: false,
    holdSeconds: null
  };
}

// src/engine/stats.ts
var HOLD_EDGES = [
  ["under 1 min", 60],
  ["1\u20135 min", 300],
  ["5\u201330 min", 1800],
  ["30 min\u20132 h", 7200],
  ["2\u201324 h", 86400],
  ["over 1 day", Infinity]
];
var SIZE_EDGES = [
  ["under 0.1 SOL", 0.1],
  ["0.1\u20130.5 SOL", 0.5],
  ["0.5\u20132 SOL", 2],
  ["over 2 SOL", Infinity]
];
var sol = (l) => l / LAMPORTS_PER_SOL;
var pnlOf = (p) => sol(p.realizedLamports);
function bucketize(positions, key, labels) {
  const map = new Map(labels.map((l) => [l, { label: l, count: 0, wins: 0, pnlSol: 0 }]));
  for (const p of positions) {
    const b = map.get(key(p));
    if (!b) continue;
    b.count++;
    if (p.realizedLamports > 0) b.wins++;
    b.pnlSol += pnlOf(p);
  }
  return [...map.values()];
}
var edgeLabel = (edges, v) => edges.find(([, max]) => v < max)[0];
function computeStats(positions) {
  const closed = positions.filter((p) => p.closed);
  const wins = closed.filter((p) => p.realizedLamports > 0);
  const grossWin = wins.reduce((s, p) => s + pnlOf(p), 0);
  const grossLoss = -closed.filter((p) => p.realizedLamports < 0).reduce((s, p) => s + pnlOf(p), 0);
  const realizedSol = positions.reduce((s, p) => s + pnlOf(p), 0);
  const investedSol = closed.reduce((s, p) => s + sol(p.costLamports), 0);
  const holds = closed.map((p) => p.holdSeconds).sort((a, b) => a - b);
  const ranked = [...positions].filter((p) => p.soldTokens > 0).sort((a, b) => b.realizedLamports - a.realizedLamports);
  const times = positions.flatMap((p) => [p.firstBuy, p.lastSell ?? p.firstBuy]);
  return {
    tokensTraded: positions.length,
    closedPositions: closed.length,
    openPositions: positions.length - closed.length,
    wins: wins.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    realizedSol,
    investedSol,
    roi: investedSol > 0 ? realizedSol / investedSol : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    medianHoldSec: holds.length ? holds[Math.floor(holds.length / 2)] : null,
    best: ranked.length ? { mint: ranked[0].mint, pnlSol: pnlOf(ranked[0]) } : null,
    worst: ranked.length ? { mint: ranked.at(-1).mint, pnlSol: pnlOf(ranked.at(-1)) } : null,
    quickFlipRate: closed.length ? closed.filter((p) => p.holdSeconds < 60).length / closed.length : 0,
    holdBuckets: bucketize(closed, (p) => edgeLabel(HOLD_EDGES, p.holdSeconds), HOLD_EDGES.map(([l]) => l)),
    hourBuckets: bucketize(
      closed,
      (p) => String(new Date(p.firstBuy * 1e3).getUTCHours()),
      Array.from({ length: 24 }, (_, h) => String(h))
    ),
    sizeBuckets: bucketize(closed, (p) => edgeLabel(SIZE_EDGES, sol(p.costLamports)), SIZE_EDGES.map(([l]) => l)),
    firstTime: times.length ? Math.min(...times) : null,
    lastTime: times.length ? Math.max(...times) : null
  };
}
var MIN_CLOSED_FOR_GRADE = 5;
var clamp01 = (x) => Math.max(0, Math.min(1, x));
function score(s) {
  if (s.closedPositions < MIN_CLOSED_FOR_GRADE) return null;
  const pf = s.profitFactor === Infinity ? 1 : clamp01(s.profitFactor / 2);
  const wr = clamp01(s.winRate / 0.6);
  const roi = clamp01((s.roi + 0.3) / 0.6);
  return Math.round(40 * pf + 40 * roi + 20 * wr);
}
function grade(s) {
  const v = score(s);
  if (v === null) return "Unranked";
  if (v >= 90) return "S";
  if (v >= 78) return "A";
  if (v >= 64) return "B";
  if (v >= 50) return "C";
  if (v >= 35) return "D";
  return "F";
}
var letter = (v) => v >= 0.85 ? "A" : v >= 0.7 ? "B" : v >= 0.55 ? "C" : v >= 0.4 ? "D" : "F";
function subjects(s) {
  const flips = s.holdBuckets[0];
  const usedSizes = s.sizeBuckets.filter((b) => b.count);
  const biggest = usedSizes.at(-1);
  const bagShare = s.tokensTraded ? s.openPositions / s.tokensTraded : 0;
  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor : 3;
  return [
    { name: "Entries", grade: letter(s.winRate / 0.5), note: `${Math.round(s.winRate * 100)}% of trades closed green` },
    { name: "Exits", grade: letter(pf / 2), note: `wins are ${pf.toFixed(2)}\xD7 the size of losses` },
    {
      name: "Patience",
      grade: letter(flips.count && flips.pnlSol < 0 ? 1 - s.quickFlipRate : 0.8),
      note: `${Math.round(s.quickFlipRate * 100)}% of exits inside a minute`
    },
    {
      name: "Sizing",
      grade: letter(biggest && biggest.pnlSol < 0 && usedSizes.length > 1 ? 0.35 : 0.8),
      note: biggest ? `biggest entries (${biggest.label}) ${biggest.pnlSol >= 0 ? "made" : "lost"} ${Math.abs(biggest.pnlSol).toFixed(2)} SOL` : "no sized trades yet"
    },
    { name: "Bag control", grade: letter(1 - bagShare * 1.5), note: `${s.openPositions} of ${s.tokensTraded} tokens still held` }
  ];
}
function rulebook(s) {
  const rules = [];
  const worst = (bs) => bs.filter((b) => b.count >= 3).sort((a, b) => a.pnlSol - b.pnlSol)[0];
  const best = (bs) => bs.filter((b) => b.count >= 3).sort((a, b) => b.pnlSol - a.pnlSol)[0];
  const wh = worst(s.holdBuckets);
  const bh = best(s.holdBuckets);
  if (wh && wh.pnlSol < 0) rules.push(`Stop holding ${wh.label}. You lost ${fmt(-wh.pnlSol)} SOL over ${wh.count} trades there.`);
  if (bh && bh.pnlSol > 0 && bh !== wh) rules.push(`Your money is made holding ${bh.label} (+${fmt(bh.pnlSol)} SOL). Build every trade around it.`);
  const ws = worst(s.sizeBuckets);
  if (ws && ws.pnlSol < 0) rules.push(`Cap your size: ${ws.label} entries lost ${fmt(-ws.pnlSol)} SOL.`);
  const hours = s.hourBuckets.filter((b) => b.count >= 3 && b.pnlSol < 0).sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 2);
  for (const h of hours) rules.push(`Hour ${h.label}:00 UTC is your worst slot (${fmt(h.pnlSol)} SOL). Stay off the charts then.`);
  const flips = s.holdBuckets[0];
  if (s.quickFlipRate > 0.4 && flips.pnlSol < 0 && wh?.label !== flips.label) rules.push("Over 40% of your exits happen inside a minute and most lose. Stop panic-selling the first red candle.");
  if (s.openPositions > s.closedPositions) rules.push(`You are still holding ${s.openPositions} bags. Set an exit before you buy, not after.`);
  if (s.profitFactor > 0 && s.profitFactor < 1 && s.winRate >= 0.5) rules.push("You win often but your losers are bigger than your winners. Cut losses faster than you take profit.");
  if (s.winRate < 0.25 && s.realizedSol > 0) rules.push("You are a sniper: a few big winners pay for many small losers. Never cut a runner early, that is where all your profit lives.");
  return rules;
}
var fmt = (x) => Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);

// src/engine/index.ts
function analyze(wallet, txs) {
  const trades = [];
  const skipped = {};
  let transfers = 0;
  for (const tx of txs) {
    const r = extract(tx, wallet);
    if (r.kind === "trade") trades.push(r.trade);
    else if (r.kind === "transfer") transfers++;
    else skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
  }
  const positions = buildPositions(trades);
  const stats = computeStats(positions);
  return {
    wallet,
    txAnalyzed: txs.length,
    trades: trades.length,
    transfersIgnored: transfers,
    skipped,
    positions,
    stats,
    score: score(stats),
    grade: grade(stats),
    rules: rulebook(stats)
  };
}

// src/engine/rpc.ts
var rpcId = 0;
async function rpcCall(url, method, params, attempt = 0) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`${method}: HTTP ${res.status} after retries`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
    return rpcCall(url, method, params, attempt + 1);
  }
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
async function fetchSignatures(url, wallet, maxTx) {
  const out = [];
  let before;
  while (out.length < maxTx) {
    const page = await rpcCall(url, "getSignaturesForAddress", [
      wallet,
      { limit: Math.min(1e3, maxTx - out.length + 50), ...before ? { before } : {} }
    ]);
    if (!page.length) break;
    for (const s of page) if (!s.err) out.push(s);
    before = page.at(-1).signature;
    if (page.length < 1e3) break;
  }
  return out.slice(0, maxTx);
}
async function fetchWalletTxs(url, wallet, opts = {}) {
  const sigs = await fetchSignatures(url, wallet, opts.maxTx ?? 300);
  const txs = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < sigs.length) {
      const s = sigs[next++];
      const tx = await rpcCall(url, "getTransaction", [
        s.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }
      ]);
      if (tx) txs.push(tx);
      opts.onProgress?.(++done, sigs.length);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return txs;
}

// src/web/roast.ts
var pick = (xs, seed) => xs[Math.abs(Math.floor(seed)) % xs.length];
function roast(s, g, seed) {
  const lines = [];
  if (g === "Unranked") return "Not enough closed trades to judge you. Suspiciously careful.";
  if (s.quickFlipRate > 0.7) lines.push(
    "Holds a coin for less time than it takes to read its name.",
    "Your average hold time is shorter than a pump.fun livestream intro.",
    "Buys the top, sells the first wick. A true artist."
  );
  if (s.winRate < 0.2) lines.push(
    `Wins ${Math.round(s.winRate * 100)}% of the time. A coin flip would like a word.`,
    "You are the exit liquidity everyone is grateful for."
  );
  if (s.realizedSol < -5) lines.push(
    `Down ${Math.abs(s.realizedSol).toFixed(1)} SOL. Deployers send their thanks.`,
    "Single-handedly funding the dev wallet economy."
  );
  if (s.openPositions > s.closedPositions) lines.push("More bags than an airport carousel.");
  if (s.realizedSol > 5 && s.winRate < 0.3) lines.push("Loses all day, then one runner pays for everything. Pure sniper energy.");
  if (s.realizedSol > 10) lines.push("Actually profitable. Either skilled or the devs owe you a favor.");
  if (g === "S" || g === "A") lines.push("Annoyingly good. Teach the rest of the trenches.", "This wallet has a plan. Rare sight.");
  if (g === "D" || g === "F") lines.push("Trading like the chart owes you money.", "Every rug pull has a hero. Sometimes it is you.");
  if (!lines.length) lines.push("Perfectly average. The trenches salute your mediocrity.", "Not great, not terrible. Very 3.6 roentgen.");
  return pick(lines, seed);
}

// mcp/src/server.ts
var SITE = "https://trench-report.trenchreport.workers.dev";
var RPC = process.env.SOLANA_RPC_URL ?? "https://solana-rpc.publicnode.com";
var VERSION = "0.2.0";
var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
var TOOLS = [{
  name: "grade_wallet",
  title: "Grade a Solana wallet",
  description: "Grades how a Solana wallet trades memecoins, like a school report card. Reads the wallet's recent on-chain swaps (any launchpad or trading bot), computes realized PnL with first-in-first-out cost basis, and returns an overall grade (S to F), five habit grades (entries, exits, patience, sizing, bag control), win rate, median hold time, best and worst token, and a one-line roast. Read-only public data; never signs or sends anything.",
  inputSchema: {
    type: "object",
    properties: {
      wallet: { type: "string", description: "Solana wallet address (base58)" },
      max_transactions: { type: "number", description: "How many recent transactions to read (10-500, default 300)" }
    },
    required: ["wallet"]
  }
}];
function fmtHold(sec) {
  if (sec === null) return "n/a";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
async function gradeWallet(args) {
  const wallet = String(args.wallet ?? "").trim();
  if (!B58.test(wallet)) throw new Error("wallet must be a Solana base58 address");
  const maxTx = Math.min(Math.max(Number(args.max_transactions) || 300, 10), 500);
  const txs = await fetchWalletTxs(RPC, wallet, { maxTx, concurrency: 6 });
  const r = analyze(wallet, txs);
  const s = r.stats;
  const report = {
    wallet,
    transactions_read: r.txAnalyzed,
    trades_found: r.trades,
    overall_grade: r.grade,
    score_out_of_100: r.score,
    subjects: subjects(s).map((x) => ({ subject: x.name, grade: x.grade, note: x.note })),
    realized_pnl_sol: +s.realizedSol.toFixed(4),
    win_rate_pct: Math.round(s.winRate * 100),
    tokens_traded: s.tokensTraded,
    closed_positions: s.closedPositions,
    open_positions: s.openPositions,
    median_hold: fmtHold(s.medianHoldSec),
    best_token: s.best && { mint: s.best.mint, pnl_sol: +s.best.pnlSol.toFixed(4) },
    worst_token: s.worst && { mint: s.worst.mint, pnl_sol: +s.worst.pnlSol.toFixed(4) },
    roast: roast(s, r.grade, parseInt(wallet.slice(-6), 36) || 7),
    full_report: `${SITE}/?w=${wallet}`,
    full_report_includes: "personal rulebook from the wallet's own losing patterns, regret ledger (every sold token vs today's price), PnL by hold time / size / hour",
    note: "Backward-looking analysis of public data for fun and self-reflection. Not financial advice."
  };
  return JSON.stringify(report, null, 2);
}
var send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === void 0) return;
  try {
    switch (method) {
      case "initialize":
        return send({ jsonrpc: "2.0", id, result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "trench-report", version: VERSION },
          instructions: "Use grade_wallet to grade any Solana wallet's memecoin trading. Results are read-only and public-data based."
        } });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        if (params?.name !== "grade_wallet") throw new Error(`unknown tool ${params?.name}`);
        try {
          const text = await gradeWallet(params.arguments ?? {});
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        } catch (e) {
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Could not grade: ${e.message}` }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}
var buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
  }
});
