# CCA Monitor

On-chain data collector and live monitor for Uniswap's [Continuous Clearing Auctions](https://blog.uniswap.org/cca) (CCAs). Tracks 15 auctions (4 real, 11 test) across Ethereum, Base, Arbitrum, and Unichain with 15,520 unique bidder addresses indexed. 78 automated checks guard dataset integrity.

<!-- > **Read the analysis:** [CCA Post-Mortem — Who Bids Twice?](https://TODO) -->
<!-- > **Telegram:** [@cca_auctions](https://t.me/cca_auctions) (free, 30-min delay) | [@cca_monitor_bot](https://t.me/cca_monitor_bot) (premium) -->

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
| `backup` | `npm run backup` | Copy data/*.json to backups/YYYY-MM-DD/, keep 14 days |
| `verify-data` | `npm run verify-data` | Check dataset integrity against `data/invariants.json` |
| `test` | `npm test` | Run full test suite (67 tests) + verify-data (11 checks) |
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

## Webhook Alerts

Set `WEBHOOK_URL` in `.env` to receive JSON POST notifications when new auctions are detected in watch mode. Works with Slack incoming webhooks, Discord webhooks, or any HTTP endpoint.

## Known Auctions

| Name | Chain | Status | Bids | Bidders | Clearing/Floor | Raised | Hook |
|------|-------|--------|------|---------|----------------|--------|------|
| AZTEC | Mainnet | Graduated | 17,232 | 14,096 | 163% | 19,388 ETH | Yes (ZK Passport) |
| STRATO | Mainnet | Graduated | 575 | 291 | 407% | 804 ETH | No |
| wOCT | Mainnet | Graduated | 1,867 | 812 | * | 1,177 ETH | No |
| CAP | Mainnet | Graduated | 1,002 | 416 | 142% | 3.84M USDC | Yes (KYC) |
| 11 test auctions | Base | Failed | — | — | — | — | — |

\* wOCT clearing/floor ratio is anomalous due to near-zero floor price.

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
- **Cross-chain coverage**: CCAs can deploy on any supported chain. The monitor watches all four simultaneously, so nothing is missed regardless of which chain a project chooses.

### Programmatic Use
- **Bot integration**: Webhook alerts can trigger automated analysis pipelines, Telegram/Discord bots, or even auto-bidding logic.
- **Dataset building**: JSON output accumulates a structured dataset of every CCA ever deployed. As the mechanism matures, this becomes the definitive historical record for research and backtesting.

## Dataset Insights

Computed by the `analyze` summary across all 4 real auctions:

- **15,520** unique bidder addresses
- **86** addresses bid in 2+ auctions (0.55% recurrence rate)
- Repeat bidders participate in hooked (KYC) auctions **62.4%** of the time vs **93.3%** for single-auction bidders — experienced bidders are more willing to enter open auctions
- All 4 real auctions graduated successfully

## Architecture

Core logic lives in `cca-collector.ts` with shared utilities (ABI definitions, Q96 decoding, chunked log fetching) extracted to `shared.ts`. Uses [viem](https://viem.sh/) for all chain interaction — no ethers.js dependency. Multicall batches all contract reads into one RPC call per auction. Factory events discovered via [Blockscout API](https://eth.blockscout.com) (free, no key required, no block range limits).

## License

MIT
