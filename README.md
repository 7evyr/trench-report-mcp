# Trench Report MCP

Grade any Solana wallet's memecoin trading like a school report card, from inside Claude, Cursor or any MCP client.

Ask your agent *"grade wallet 9vDq…inqK"* and get back:

- **Overall grade** S to F, plus a score out of 100
- **Five habit grades:** entries, exits, patience, sizing, bag control
- **Realized PnL** in SOL with first-in-first-out cost basis (fees and Jito tips count, token-account rent and airdrops don't)
- Win rate, median hold time, best and worst token
- A one-line roast

It reads public on-chain data from your own machine through a free public Solana RPC. No API key, no account, no wallet connect. It never signs or sends anything.

Web version and the full report (personal rulebook, regret ledger, PnL by hold time / size / hour): **https://trench-report.trenchreport.workers.dev**

## Install

**Claude Code plugin** (MCP server + a skill that teaches Claude how to read the report)

```bash
claude plugin marketplace add 7evyr/trench-report-mcp
claude plugin install trench-report@trench-report
```

**Claude Code, MCP only**

```bash
claude mcp add trench-report -- npx -y github:7evyr/trench-report-mcp
```

**Docker**

```bash
docker build -t trench-report-mcp https://github.com/7evyr/trench-report-mcp.git
```

then point your client at `docker run -i --rm trench-report-mcp`.

**Claude Desktop / Cursor / Windsurf** (`mcpServers` in the client's config)

```json
{
  "mcpServers": {
    "trench-report": {
      "command": "npx",
      "args": ["-y", "github:7evyr/trench-report-mcp"]
    }
  }
}
```

Needs Node 18+ and git. Optional: set `SOLANA_RPC_URL` to use your own RPC (Helius, Triton, etc.) for faster, larger reads.

## Tool

`grade_wallet`

| Argument | Type | Notes |
|---|---|---|
| `wallet` | string | Solana address (base58) |
| `max_transactions` | number | Recent transactions to read, 10–500, default 300 |

Returns JSON with the grades, stats, roast and a link to the full report.

## How the math works

Every transaction is reduced to the wallet's own balance changes: SOL out and token in is a buy, the reverse is a sell. That makes it work the same on pump.fun, Raydium, Meteora, Jupiter and every trading bot. Sells are matched first-in-first-out against what was paid. Tokens received by transfer or airdrop have no cost basis and are kept out of PnL. The grade weighs profit factor and return most, then win rate. Fewer than five closed trades stays unranked.

## Disclaimer

Backward-looking analysis of public data for fun and self-reflection. Not financial advice.

MIT licence.
