# CCA Monitor

[![CI](https://github.com/monkrus/cca-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/monkrus/cca-monitor/actions/workflows/ci.yml) [![Agent Ready — Accepts Payments](https://img.shields.io/badge/Agent_Ready-Accepts_x402_Payments-6366f1?style=flat&logo=cloudflare&logoColor=white)](https://cca-monitor-api.sergeigodev.workers.dev/.well-known/ai-plugin.json) [![USDC on Base](https://img.shields.io/badge/USDC-Pay_per_call_on_Base-22c55e?style=flat)](https://docs.x402.org)

On-chain data collector and live monitor for Uniswap's Continuous Clearing Auctions (CCAs). Tracks 17 auctions (6 real, 11 test) across Ethereum, Base, Arbitrum, Unichain, Optimism, Polygon, and Robinhood Chain with 16,976 unique bidder addresses indexed. 94 automated checks guard dataset integrity.

>**Click:** [Dashboard](https://monkrus.github.io/cca-monitor/)    **Telegram:** [@cca_auctions](https://t.me/cca_auctions) (free, 30-min delay) | [@cca_monitor_bot](https://t.me/cca_monitor_bot) (premium)

See [RUNBOOK.md](RUNBOOK.md) for operations. Dataset derived from public on-chain events; free to use with attribution.

## Setup

```bash
npm install
cp .env.example .env   # add RPC keys if you have them (optional)
```

Public RPCs work out of the box. Dedicated keys (Alchemy, Infura, Ankr) give better rate limits for bid-event scanning.

## Running (production)

```bash
npm run start:all   # starts watch + bot + intent via pm2
npm run status      # check process health
pm2 logs            # tail all logs
```

All three processes auto-restart on crash. See [RUNBOOK.md](RUNBOOK.md) for ops details.

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `analyze` | `npm run analyze` | Collect all auctions (real + test); `--real-only` for fast upsert of real only |
| `watch` | `npm run watch` | Live-monitor CCA factory for new deployments (all chains) |
| `bot` | `npm run bot` | Telegram subscription bot with premium/public channels |
| `intent` | `npm run intent` | Intent-radar: scan pending auctions for early bidding signals |
| `profile` | `npm run profile [addr]` | Deep-dive a single bidder across all real auctions |
| `postmortem` | `npm run postmortem [name]` | Full post-mortem stats for an auction (FDV derivation, cross-auction comparison) |
| `charts` | `npm run charts` | Generate publication-ready PNGs to `charts/` via QuickChart API |
| `bid-helper` | `npm run bid-helper` | Suggest bid ranges based on historical clearing/floor ratios (`--hook`, `--no-hook`) |
| `backup` | `npm run backup` | Copy data/*.json to backups/YYYY-MM-DD/, keep 14 days |
| `verify-data` | `npm run verify-data` | Check dataset integrity against `data/invariants.json` |
| `typecheck` | `npm run typecheck` | Run TypeScript strict type-check (no emit) |
| `test` | `npm test` | Type-check + test suite (81 tests) + verify-data (11 checks) |
| `start:all` | `npm run start:all` | Start all long-running processes via pm2 |
| `status` | `npm run status` | Show pm2 process status |

Results are saved to `data/results.json` (version-controlled — commit after each new real auction).

## Output

Each auction record includes:

| Field | Description |
|-------|-------------|
| `tokenName` / `tokenSymbol` | ERC20 identity read on-chain |
| `floorPrice` | Decoded from Q96 fixed-point to decimal |
| `clearingPrice` | Final clearing price (decoded) |
| `clearingVsFloor` | Clearing price as % of floor |
| `durationHours` | Auction length (chain-aware block times) |
| `graduated` | Whether the auction met its required raise |
| `hasValidationHook` | KYC/allowlist hook present |
| `totalRaised` | Total currency committed |
| `flags` | Risk flags (short duration, no hook, etc.) |
| `currentPriceUsd` | Current token price from DexScreener (graduated tokens) |
| `priceChange24h` | 24-hour price change percentage |
| `volume24h` | 24-hour trading volume in USD |

## API

Live REST API at **https://cca-monitor-api.sergeigodev.workers.dev** (Cloudflare Workers, free tier: 100K requests/day).

Agent-ready: scored **64/100** on [isitagentready.com](https://isitagentready.com). Cloudflare Wallet handle: `@cca-monitor`.

### Free tier (no auth required)

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/auctions` | Auction data (filters: `?chain=mainnet&status=graduated&hook=true&q=AZTEC&test=true`) |
| `GET /api/v1/auctions/:name` | Single auction by name or symbol |
| `GET /api/v1/summary` | Summary stats |

Rate limit: 30 requests/minute. Basic fields only.

### Pro tier (API key or x402 USDC payment)

| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/v1/auctions` | — | Full auction data with concentration metrics |
| `GET /api/v1/auctions/:name` | — | Full single auction |
| `GET /api/v1/summary` | — | Summary stats + bidder insights |
| `GET /api/v1/overlap` | $0.001/call | Bidder overlap matrix |
| `GET /api/v1/bidders` | $0.005/call | Bidder index (15,520 wallets) |
| `GET /api/v1/concentration` | $0.001/call | HHI + top-5 concentration for all auctions |

Rate limit: 300 requests/minute. Two ways to access:

1. **API key**: Set `X-API-Key` header. DM [@monkrus](https://t.me/monkrus) on Telegram or X. First 5 keys free for 30 days.
2. **x402 payment**: AI agents pay per call with USDC on Base — no signup needed. Send GET, receive HTTP 402 with `Payment-Required` header, sign payment, retry with `Payment-Signature` header. See [docs.x402.org](https://docs.x402.org).

### Agent discovery

| Endpoint | Format | Purpose |
|----------|--------|---------|
| `/.well-known/ai-plugin.json` | JSON | AI agent plugin manifest (capabilities, auth, pricing) |
| `/.well-known/api-catalog` | linkset+json | RFC 9727 API catalog |
| `/.well-known/agent-skills/index.json` | JSON | Agent Skills Discovery v0.2.0 |
| `/.well-known/mcp/server-card.json` | JSON | MCP Server Card |
| `/.well-known/x402` | JSON | x402 payment discovery (paid endpoints + pricing) |
| `/robots.txt` | text | AI bot rules + Content Signals |
| `/sitemap.xml` | XML | All API endpoints |

Homepage returns `Link` headers for agent discovery and supports `Accept: text/markdown` content negotiation.

CORS enabled. Responses cached 5 minutes. GET only (POST/PUT/DELETE return 405).

```bash
# Self-host
cd api && npx wrangler deploy   # deploy to Cloudflare
cd api && npx wrangler dev      # local dev server
```

## Alert Channels

All alerts route through a single `routeAlert()` function. Configure any combination:

| Channel | Env Vars | Description |
|---------|----------|-------------|
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_PREMIUM_CHANNEL_ID`, `TELEGRAM_PUBLIC_CHANNEL_ID` | DM, premium (instant), public (30-min delay) |
| Webhooks | `ALERT_WEBHOOK_URLS` | Comma-separated URLs. Auto-formats for Discord (embeds) and Slack (blocks). Generic endpoints get `{ type, text, html, timestamp }` |
| Email | `SENDGRID_API_KEY`, `ALERT_EMAIL` | Via SendGrid API. `ALERT_EMAIL_MODE=digest` (default) sends daily/weekly only; `all` sends every alert |
| Legacy webhook | `WEBHOOK_URL` | Raw JSON payload on new auction detection only |

Example `.env` for Discord + email digest:
```
ALERT_WEBHOOK_URLS=https://discord.com/api/webhooks/123/abc
SENDGRID_API_KEY=SG.xxxxx
ALERT_EMAIL=team@example.com
ALERT_EMAIL_MODE=digest
```

## Known Auctions

| Name | Chain | Status | Bids | Bidders | Clearing/Floor | Raised | Hook |
|------|-------|--------|------|---------|----------------|--------|------|
| AZTEC | Mainnet | Graduated | 17,232 | 14,096 | 163% | 19,388 ETH | Yes (ZK Passport) |
| STRATO | Mainnet | Graduated | 575 | 291 | 407% | 804 ETH | No |
| wOCT | Mainnet | Graduated | 1,867 | 812 | n/a | 1,177 ETH | No |
| CAP | Mainnet | Graduated | 1,002 | 416 | 142% | 3.84M USDC | Yes (KYC) |
| AKITA | Base | Failed | — | — | — | — | No |
| 11 test auctions | Base | Failed | — | — | — | — | — |

wOCT's floor price decodes to near-zero (Q96 value `4294967300` = ~5.4e-20), making the clearing/floor ratio astronomically large and meaningless. The auction itself graduated normally with a clearing price of 0.00001236 ETH and 1,177 ETH raised.

## What This Data Enables

### Market Intelligence
- **Pre-launch discovery**: Watch mode catches new CCAs the moment they deploy, before any public announcement. Early awareness of upcoming token launches.
- **Pricing analysis**: Decoded Q96 prices let you compare floor vs. clearing across auctions. AZTEC cleared at 163% of floor; STRATO at 407%. These ratios reveal demand intensity.
- **Duration benchmarking**: Real auctions range from 7-23 days. Anything under 4 hours is flagged as a test. Patterns here inform what auction lengths attract the most participation.

### Risk Assessment
- **Validation hooks**: Auctions with KYC/allowlist hooks (like AZTEC's ZK Passport) attract institutional capital and signal serious projects. No-hook auctions are open but riskier.
- **Graduation tracking**: Failed graduations (required raise not met) indicate weak demand. The system flags these automatically.
- **Tick spacing analysis**: Abnormally small tick spacing (< 0.01% of floor) correlates with test deployments.

### Participation Strategy
- **Oversubscription signals**: When `totalRaised` far exceeds `requiredRaise`, the auction is oversubscribed. CAP was 5.5x — meaning most bidders get partial fills. This data helps size bids.
- **Clearing prediction**: Historical clearing/floor ratios create a baseline. New auctions with similar parameters will likely clear in similar ranges, informing bid price placement.
- **Cross-chain coverage**: CCAs can deploy on any supported chain. The monitor watches all six simultaneously, so nothing is missed regardless of which chain a project chooses.

### Programmatic Use
- **Bot integration**: Webhook alerts can trigger automated analysis pipelines, Telegram/Discord bots, or even auto-bidding logic.
- **Dataset building**: JSON output accumulates a structured dataset of every CCA ever deployed. As the mechanism matures, this becomes the definitive historical record for research and backtesting.

## Dataset Insights

Computed by the `analyze` summary across all 5 real auctions:

- **15,520** unique bidder addresses
- **86** addresses bid in 2+ auctions (0.55% recurrence rate)
- Repeat bidders participate in hooked (KYC) auctions **62.4%** of the time vs **93.3%** for single-auction bidders — experienced bidders are more willing to enter open auctions (measured per auction-participation, not per unique address: 86 repeat addresses generate 113 hooked-auction entries)
- 4 of 5 real auctions graduated successfully (AKITA failed)

## Architecture

Core logic lives in `cca-collector.ts` with shared utilities (ABI definitions, Q96 decoding, chunked log fetching) extracted to `shared.ts`. Uses [viem](https://viem.sh/) for all chain interaction — no ethers.js dependency. Multicall batches all contract reads into one RPC call per auction. Factory events discovered via [Blockscout API](https://eth.blockscout.com) (free, no key required, no block range limits).

## License

MIT
