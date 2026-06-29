# CCA Monitor

On-chain data collector and live monitor for Uniswap's [Continuous Clearing Auctions](https://blog.uniswap.org/cca) (CCAs).

Tracks all CCA deployments across Ethereum, Base, Arbitrum, and Unichain. Pulls auction parameters, outcomes, token identity, decoded prices, and risk flags. Optionally watches the factory contract in real time for new auctions.

## Setup

```bash
npm install
cp .env.example .env   # add RPC keys if you have them (optional)
```

Public RPCs work out of the box. Dedicated keys (Alchemy, Infura, Ankr) give better rate limits for bid-event scanning.

## Usage

```bash
# Analyze all known real auctions
npm run analyze

# Include test deployments
npx tsx cca-collector.ts analyze --include-tests

# Watch for new CCA deployments (all chains, real-time)
npm run watch
```

Results are saved to `data/results.json`.

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

| Name | Chain | Status | Notes |
|------|-------|--------|-------|
| AZTEC | Mainnet | Graduated | $59M raised, 17K bidders, ZK Passport hook |
| STRATO | Mainnet | Graduated | 1,016 ETH raised, 577 bids, HardFi/gold |
| wOCT | Mainnet | Graduated | Wrapped OCT token |
| CAP | Base | Address TBD | $16.4M USDC, 5.5x oversubscribed |
| 11 test auctions | Base | Failed | Dec 2025 - May 2026 test deployments |

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

## Architecture

Single TypeScript file (`cca-collector.ts`) using [viem](https://viem.sh/) for all chain interaction. No ethers.js dependency. Multicall batches all contract reads into one RPC call per auction. Factory events discovered via [Blockscout API](https://eth.blockscout.com) (free, no key required, no block range limits).

## License

MIT
