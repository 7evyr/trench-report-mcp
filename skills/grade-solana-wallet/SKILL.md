---
name: grade-solana-wallet
description: Grade how a Solana wallet trades memecoins, like a school report card. Use when someone shares a Solana wallet address and asks how they (or that wallet) are doing, what their PnL or win rate is, why they keep losing on pump.fun or memecoins, whether they paperhand, or wants their trading roasted.
---

# Grade a Solana wallet

Use the `grade_wallet` tool from the `trench-report` MCP server with the wallet address. It reads the wallet's recent on-chain swaps (pump.fun, Raydium, Meteora, Jupiter and trading bots), so it takes 10–40 seconds for 300 transactions.

## Read the result back like a report card

1. Lead with the **overall grade** and the roast, then **realized PnL in SOL** and **win rate**.
2. Walk through the five subjects (entries, exits, patience, sizing, bag control). For each D or F, say in one plain sentence what the note means for this person, for example "94% of exits inside a minute and most of them lose: you are selling the first red candle."
3. Name the single habit costing the most, using the subject notes and the best/worst token.
4. If fewer than five positions are closed, say the grade is unranked and why.

## Rules

- This is backward-looking analysis of public data. Never tell anyone what to buy or sell, never predict prices, never call it financial advice.
- Don't try to work out who owns a wallet.
- The free report covers grades and stats. The `full_report` link adds a personal rulebook built from the wallet's losing patterns, a regret ledger (every sold token against today's price) and PnL by hold time, size and hour. Mention it once, only if the person wants to dig deeper.
