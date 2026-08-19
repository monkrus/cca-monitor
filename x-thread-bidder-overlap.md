# X Thread: Who Bids in Every Uniswap CCA?

Post as a thread (each ## is a separate tweet). Attach the noted images.

---

## Tweet 1 (hook)

I tracked 16,976 wallets across every Uniswap CCA auction.

150 of them showed up in more than one.
2 wallets have bid in 4 out of 6 auctions.

Here's what the data shows. A thread.

[ATTACH: charts/bidder-recurrence.png]

---

## Tweet 2 (the data)

6 real CCAs so far. 5 graduated, 1 failed:

AZTEC — 19,388 ETH raised, 14,096 bidders
RNBW — 330K USDC raised, 1,526 bidders
wOCT — 1,177 ETH raised, 812 bidders
CAP — 3.8M USDC raised, 416 bidders
STRATO — 803 ETH raised, 291 bidders
AKITA — failed to graduate, 0 bids cleared

[ATTACH: charts/clearing-vs-floor.png]

---

## Tweet 3 (overlap matrix)

The overlap matrix — how many wallets bid in both auctions:

AZTEC-RNBW: 52 shared wallets (biggest overlap)
AZTEC-CAP: 32
AZTEC-wOCT: 30
wOCT-RNBW: 15
CAP-wOCT: 14
STRATO-CAP: 13

AKITA shared zero wallets with any other auction. It was isolated from the start.

---

## Tweet 4 (the power bidders)

The 2 wallets that bid in 4 auctions:

0x3eaf...1d — AZTEC, STRATO, wOCT, CAP (all mainnet)
0xf570...ec — STRATO, wOCT, CAP, RNBW (cross-chain: mainnet + Base)

11 more wallets hit 3 auctions each.

These aren't bots — CCA is designed to make sniping pointless. These are deliberate, repeat participants in a new market mechanism.

---

## Tweet 5 (the RNBW finding)

RNBW is interesting. It launched on Base, not mainnet.

Yet 52 wallets that bid in AZTEC also bid in RNBW — the strongest overlap of any pair.

That means CCA regulars are following the mechanism across chains, not just farming one network.

---

## Tweet 6 (AKITA signal)

AKITA is the counter-signal.

First CCA to fail. Zero overlap with any other auction. None of the 150 repeat bidders touched it.

The regulars knew. Or at least, they weren't interested.

---

## Tweet 7 (CTA)

All of this is open source and free:

Dashboard: monkrus.github.io/cca-monitor
API: cca-monitor-api.sergeigodev.workers.dev
Repo: github.com/monkrus/cca-monitor

The monitor auto-detects new CCAs across 6 chains. When the next one launches, the bidder overlap data gets more valuable.

If you're building on CCA or studying token distribution mechanisms, the data is yours.
