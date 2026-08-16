# CCA Monitor update: 6 chains, 5 real auctions, and what broke along the way

Quick update on the open-source CCA (Continuous Clearing Auction) monitor.

**Dashboard:** https://monkrus.github.io/cca-monitor
**Repo:** https://github.com/monkrus/cca-monitor

## What's new

- **6 chains monitored**: Added Optimism and Polygon alongside Ethereum, Base, Arbitrum, and Unichain. Auto-detection watches all factory contracts simultaneously.
- **Multi-channel alerts**: Beyond Telegram — now supports Discord/Slack webhooks and email via SendGrid. Whale bid alerts, auction end notifications, daily digests.
- **Auction comparison tool**: Side-by-side analysis of up to 4 auctions — clearing ratios, bidder overlap, concentration metrics.
- **Post-graduation price tracking**: Sparkline charts on the dashboard for graduated tokens, with alert bands at -10/-20/-30%.
- **REST API**: Cloudflare Workers, free tier for basic data, pro tier for concentration/overlap endpoints.

## Auction scorecard

4 out of 5 real CCAs graduated. AKITA on Base was the first to fail — which honestly validates the mechanism. The graduation threshold is a real filter.

The bidder overlap data is getting interesting. Some wallets show up in every single CCA. As more auctions launch, that cross-auction pattern becomes the most valuable dataset here.

## Things that broke (and fixes)

**polygon-rpc.com went 401.** They silently added API key requirements. Lesson reinforced: never rely on a single RPC per chain. The monitor now carries 2-3 fallback URLs per chain (Blockscout, dRPC, PublicNode) and auto-falls through them.

**Windows PM2 + PowerShell popups.** The watchdog process uses `execSync` to check pm2 status every 5 minutes. On Windows, that spawns a visible console window. One flag (`windowsHide: true`) fixed it. Small thing, but annoying if you're running this on a desktop.

**Viem default RPCs go stale.** If you don't set an explicit RPC URL, viem uses the chain's built-in default. Those defaults can stop working without warning. Fixed the client factory to fall back to the public RPC list instead of viem's defaults.

## Current state

The system runs on a Windows box, 4 PM2 processes, ~250MB total, $0/month infrastructure. It polls every 30 seconds and auto-detects, analyzes, and deploys dashboard updates without manual intervention.

Right now it's a quiet market — watching and waiting for the next wave of CCA launches. The tooling is ready.

Dashboard and API are free. PRs welcome.
