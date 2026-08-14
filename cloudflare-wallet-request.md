Subject: Request for Cloudflare Wallets Early Access & Handle Reservation — "cca-monitor"

---

Hi Cloudflare Team,

I'm writing in response to your August 2026 announcement "Cloudflare Gives AI Agents an Identity and a Wallet" regarding Cloudflare Wallets and cloudflare.pay.

I run the CCA Monitor API (https://cca-monitor-api.sergeigodev.workers.dev), a Cloudflare Worker that serves analytics for Uniswap V4 Continuous Clearing Auctions. The API has a free tier for basic data and a pro tier for concentration metrics, bidder overlap, and bidder analytics.

I'd like to request:

1. **Wallet handle reservation**: Please reserve the handle `cca-monitor` for my account (sergeigodev@gmail.com). This would serve as the stable identity for my API when agents make payments.

2. **Early access / beta**: I'd like to be among the first to integrate Cloudflare Wallets and cloudflare.pay into my Worker. My API already has:
   - Per-endpoint USDC pricing defined ($0.001-$0.005/call)
   - Pluggable auth that detects CF-Agent-ID and CF-Agent-Signature headers
   - Usage metering infrastructure (KV-backed, per-identity tracking)
   - An AI agent discovery manifest at /.well-known/ai-plugin.json

   In the meantime, I'm integrating x402 for immediate agent payment support, but I'd love to adopt the native Cloudflare Wallets flow as soon as it's available.

3. **Virtual Wallet support**: My use case is a good fit for Virtual Wallets — AI agents that consume auction analytics data should be able to set spending caps and have their usage tracked per-identity. I'd like to understand the timeline and API surface for Virtual Wallet issuance and verification from the server side.

The API is live, deployed, and handling requests today. Happy to be a design partner or beta tester. You can see the full project at https://github.com/monkrus/cca-monitor.

Best regards,
Sergei
sergeigodev@gmail.com
Telegram/X: @monkrus
Cloudflare account: sergeigodev@gmail.com
Worker: cca-monitor-api.sergeigodev.workers.dev
