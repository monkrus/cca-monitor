/**
 * Bid Placement Helper — suggests optimal bid ranges for new CCA auctions
 *
 * Analyzes historical clearing/floor ratios, bidder counts, and raised amounts
 * to recommend bid price ranges based on auction characteristics.
 *
 * Usage: npm run bid-helper [--hook] [--no-hook] [--currency ETH|USDC]
 *   --hook      assume KYC/allowlist hook (like AZTEC, CAP)
 *   --no-hook   assume open auction (like STRATO, wOCT)
 *   --currency  filter comparables by currency type
 */

import * as fs from 'fs'

interface AuctionRecord {
  name: string
  chain: string
  isTest: boolean
  graduated: boolean
  hasValidationHook: boolean
  floorPrice: string
  clearingPrice: string
  clearingVsFloor: string
  currencySymbol: string
  currencyRaisedFormatted?: string
  durationHours: number
  totalBids?: number
  uniqueBidders?: number
  tokenSupply?: string
}

function loadResults(): { auctions: AuctionRecord[] } {
  return JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
}

function parseCvf(s: string): number | null {
  const m = s.match(/([\d.]+)%/)
  return m ? parseFloat(m[1]) : null
}

function main() {
  const args = process.argv.slice(2)
  const wantHook = args.includes('--hook')
  const wantNoHook = args.includes('--no-hook')
  const currIdx = args.indexOf('--currency')
  const wantCurrency = currIdx >= 0 ? args[currIdx + 1]?.toUpperCase() : null

  const data = loadResults()
  const real = data.auctions.filter(a => !a.isTest && a.graduated)

  // Parse clearing/floor ratios
  const withRatios = real.map(a => ({
    ...a,
    ratio: parseCvf(a.clearingVsFloor),
  })).filter(a => a.ratio !== null) as (AuctionRecord & { ratio: number })[]

  if (withRatios.length === 0) {
    console.error('No graduated auctions with clearing/floor data found.')
    process.exit(1)
  }

  // Filter to comparable auctions
  let comparables = withRatios
  if (wantHook) comparables = comparables.filter(a => a.hasValidationHook)
  if (wantNoHook) comparables = comparables.filter(a => !a.hasValidationHook)
  if (wantCurrency) comparables = comparables.filter(a => a.currencySymbol.toUpperCase() === wantCurrency)

  // Fall back to all if filter is too narrow
  if (comparables.length === 0) {
    console.log('No auctions match filters, using all graduated auctions.\n')
    comparables = withRatios
  }

  const ratios = comparables.map(a => a.ratio).sort((a, b) => a - b)
  const min = ratios[0]
  const max = ratios[ratios.length - 1]
  const median = ratios.length % 2 === 0
    ? (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
    : ratios[Math.floor(ratios.length / 2)]
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length

  // Hooked vs open stats
  const hookedRatios = withRatios.filter(a => a.hasValidationHook).map(a => a.ratio)
  const openRatios = withRatios.filter(a => !a.hasValidationHook).map(a => a.ratio)
  const hookedAvg = hookedRatios.length > 0 ? hookedRatios.reduce((s, r) => s + r, 0) / hookedRatios.length : null
  const openAvg = openRatios.length > 0 ? openRatios.reduce((s, r) => s + r, 0) / openRatios.length : null

  console.log(`\nBID PLACEMENT HELPER`)
  console.log('='.repeat(60))

  // Historical data
  console.log(`\nHistorical Clearing/Floor Ratios:`)
  console.log('-'.repeat(60))
  for (const a of withRatios) {
    const hook = a.hasValidationHook ? 'KYC' : 'Open'
    const bidders = a.uniqueBidders?.toLocaleString('en-US') ?? '?'
    console.log(`  ${a.name.padEnd(10)} ${(a.ratio + '%').padEnd(8)} ${hook.padEnd(6)} ${a.currencySymbol.padEnd(6)} ${bidders.padStart(8)} bidders`)
  }

  console.log(`\nComparable Set (${comparables.length} auction${comparables.length !== 1 ? 's' : ''}):`)
  console.log('-'.repeat(60))
  console.log(`  Min clearing/floor:    ${min.toFixed(1)}%`)
  console.log(`  Max clearing/floor:    ${max.toFixed(1)}%`)
  console.log(`  Median:                ${median.toFixed(1)}%`)
  console.log(`  Mean:                  ${mean.toFixed(1)}%`)

  if (hookedAvg !== null && openAvg !== null) {
    console.log(`\n  By hook type:`)
    console.log(`    KYC/hooked avg:      ${hookedAvg.toFixed(1)}%  (${hookedRatios.length} auctions)`)
    console.log(`    Open/no-hook avg:    ${openAvg.toFixed(1)}%  (${openRatios.length} auctions)`)
  }

  // Recommendations
  console.log(`\n\nRecommended Bid Ranges (as % of floor price):`)
  console.log('='.repeat(60))

  const conservative = min * 0.95
  const moderate = median
  const aggressive = max * 1.1

  console.log(`\n  Conservative (high fill probability):`)
  console.log(`    Bid at ${conservative.toFixed(0)}–${min.toFixed(0)}% of floor`)
  console.log(`    Risk: may clear above this — partial or no fill`)
  console.log(`    Best for: maximizing token/currency ratio`)

  console.log(`\n  Moderate (balanced):`)
  console.log(`    Bid at ${min.toFixed(0)}–${moderate.toFixed(0)}% of floor`)
  console.log(`    Based on historical median clearing ratio`)
  console.log(`    Best for: reasonable fill probability with decent price`)

  console.log(`\n  Aggressive (maximize fill chance):`)
  console.log(`    Bid at ${moderate.toFixed(0)}–${aggressive.toFixed(0)}% of floor`)
  console.log(`    Covers the full historical range + 10% buffer`)
  console.log(`    Best for: must-fill situations, high-demand auctions`)

  // Sizing guidance
  console.log(`\n\nSizing Guidance:`)
  console.log('='.repeat(60))
  const totalBids = withRatios.reduce((s, a) => s + (a.totalBids || 0), 0)
  const totalBidders = withRatios.reduce((s, a) => s + (a.uniqueBidders || 0), 0)
  const avgBidsPerBidder = totalBidders > 0 ? (totalBids / totalBidders).toFixed(1) : '?'
  console.log(`  Avg bids per bidder:   ${avgBidsPerBidder} (across all auctions)`)
  console.log(`  Tip: place 2-3 bids at different price levels to spread risk`)
  console.log(`  Note: CCA auctions are uniform-price — all winning bids`)
  console.log(`        pay the same clearing price, regardless of bid price.`)
  console.log(`        Bidding higher only increases fill probability, not cost.`)

  // Caveats
  console.log(`\n\nCaveats:`)
  console.log('-'.repeat(60))
  console.log(`  - Based on ${withRatios.length} graduated real auctions — small sample size`)
  console.log(`  - Past clearing ratios don't predict future ones`)
  console.log(`  - Demand depends on project fundamentals, market conditions`)
  console.log(`  - KYC-hooked auctions tend to have different dynamics than open ones`)
  if (openAvg && hookedAvg) {
    const higher = openAvg > hookedAvg ? 'open' : 'KYC-hooked'
    console.log(`  - Historically ${higher} auctions clear higher vs floor`)
  }
  console.log()
}

main()
