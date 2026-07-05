/**
 * Post-Mortem Stats Extract — all stats needed for an article, in one block
 *
 * Usage: npm run postmortem [auctionName]
 * Default: CAP
 */

import * as fs from 'fs'
import { q96ToPrice } from './shared.ts'

function loadResults(): any {
  return JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
}

function loadBidderIndex(): Array<{ address: string; auctionCount: number; auctions: string[] }> {
  return JSON.parse(fs.readFileSync('data/bidder-index.json', 'utf-8'))
}

async function main() {
  const targetName = process.argv[2] || 'CAP'

  const data = loadResults()
  const allAuctions = (data.auctions as any[])
  const real = allAuctions.filter((a: any) => !a.isTest)
  const target = real.find((a: any) => a.name.toUpperCase() === targetName.toUpperCase())

  if (!target) {
    console.error(`Auction "${targetName}" not found. Available: ${real.map((a: any) => a.name).join(', ')}`)
    process.exit(1)
  }

  const bidderIndex = loadBidderIndex()
  const totalUnique = bidderIndex.length
  const repeatCount = bidderIndex.filter(e => e.auctionCount >= 2).length
  const recurrencePct = (repeatCount / totalUnique * 100).toFixed(2)

  // Token decimals inference for FDV calc
  const currDecimals = target.currencySymbol === 'USDC' || target.currencySymbol === 'USDT' ? 6 : 18
  const tokDecimals = 18 // CCA tokens are typically 18

  // FDV calculation: price * totalSupply
  // price is in currency units per token; FDV = price * supply
  const supplyRaw = target.tokenSupply ? parseInt(target.tokenSupply.replace(/,/g, '')) : null

  const floorPriceNum = target.floorPrice && target.floorPrice !== '?' ? parseFloat(target.floorPrice) : null
  const clearingPriceNum = target.clearingPrice && target.clearingPrice !== '?' ? parseFloat(target.clearingPrice) : null

  const floorFDV = floorPriceNum && supplyRaw ? (floorPriceNum * supplyRaw) : null
  const clearingFDV = clearingPriceNum && supplyRaw ? (clearingPriceNum * supplyRaw) : null

  const formatUsd = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString('en-US')}`
  const formatEth = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K ETH` : `${n.toFixed(2)} ETH`

  // Total raised
  const raisedRaw = target.currencyRaised ? BigInt(target.currencyRaised) : null
  const raisedDivisor = 10n ** BigInt(currDecimals)
  const raisedNum = raisedRaw ? Number(raisedRaw) / Number(raisedDivisor) : null

  // requiredRaise is not exposed by the CCA contract — note this
  const requiredRaise = null
  const oversubRatio = null

  console.log(`\nPOST-MORTEM: ${target.name}`)
  console.log('='.repeat(70))
  console.log()
  console.log(`Token:              ${target.tokenSymbol || '?'} (${target.tokenName || '?'})`)
  console.log(`Chain:              ${target.chain}`)
  console.log(`Token supply:       ${target.tokenSupply || '?'}`)
  console.log(`Currency:           ${target.currencySymbol || '?'}`)
  console.log()
  console.log(`Floor price:        ${target.floorPrice || '?'} ${target.currencySymbol}/token`)
  console.log(`Floor FDV:          ${floorFDV !== null ? formatUsd(floorFDV) : '? (supply or price unavailable)'}`)
  console.log(`Clearing price:     ${target.clearingPrice || '?'} ${target.currencySymbol}/token`)
  console.log(`Clearing FDV:       ${clearingFDV !== null ? formatUsd(clearingFDV) : '? (supply or price unavailable)'}`)
  console.log(`Clearing vs floor:  ${target.clearingVsFloor || '?'}`)
  console.log()
  console.log(`Total raised:       ${target.currencyRaisedFormatted || '?'}`)
  console.log(`Required raise:     ? (not exposed by CCA contract)`)
  console.log(`Oversubscription:   ? (requires requiredRaise — not on-chain)`)
  console.log()
  console.log(`Duration:           ${target.durationHours || '?'}h (${target.durationHours ? (target.durationHours / 24).toFixed(1) : '?'} days)`)
  console.log(`Total bids:         ${target.totalBids?.toLocaleString() || '?'}`)
  console.log(`Unique bidders:     ${target.uniqueBidders?.toLocaleString() || '?'}`)
  console.log(`Repeat bidders:     ${target.repeatBidders?.toLocaleString() || '?'}`)
  console.log(`Graduated:          ${target.graduated === true ? 'Yes' : target.graduated === false ? 'No' : '?'}`)
  console.log(`Validation hook:    ${target.hasValidationHook ? 'Yes (KYC/allowlist)' : 'No (open)'}`)
  if (target.flags?.length) console.log(`Flags:              ${target.flags.join(', ')}`)

  // Cross-auction comparison
  console.log(`\n\nCROSS-AUCTION COMPARISON`)
  console.log('='.repeat(70))
  const header = 'Name'.padEnd(10) + 'Clearing/Floor'.padEnd(16) + 'Duration'.padEnd(12) + 'Hooked'.padEnd(8) + 'Bidders'.padEnd(10) + 'Repeat'.padEnd(8) + 'Raised'
  console.log(header)
  console.log('-'.repeat(70))
  for (const a of real) {
    const name = a.name.padEnd(10)
    const cvf = (a.clearingVsFloor || '?').padEnd(16)
    const dur = a.durationHours ? `${(a.durationHours / 24).toFixed(0)}d`.padEnd(12) : '?'.padEnd(12)
    const hooked = (a.hasValidationHook ? 'Yes' : 'No').padEnd(8)
    const bidders = (a.uniqueBidders?.toLocaleString() || '?').padEnd(10)
    const repeat = (a.repeatBidders?.toLocaleString() || '?').padEnd(8)
    const raised = a.currencyRaisedFormatted || '?'
    console.log(`${name}${cvf}${dur}${hooked}${bidders}${repeat}${raised}`)
  }

  // Dataset headline stats
  console.log(`\n\nDATASET HEADLINE STATS`)
  console.log('='.repeat(70))
  console.log(`Total unique addresses (all real auctions): ${totalUnique.toLocaleString()}`)
  console.log(`Appearing in 2+ auctions:                   ${repeatCount.toLocaleString()}`)
  console.log(`Recurrence rate:                             ${recurrencePct}%`)
  console.log(`Real auctions tracked:                       ${real.length}`)
  console.log(`Graduated:                                   ${real.filter((a: any) => a.graduated).length}`)

  // bidderInsights from summary
  const insights = data.summary?.bidderInsights
  if (insights) {
    console.log(`\nHook clustering:`)
    console.log(`  Repeat bidders — hooked participation:  ${insights.repeatHookedPct}`)
    console.log(`  Single bidders — hooked participation:  ${insights.singleHookedPct}`)
  }

  console.log(`\nNote: requiredRaise and oversubscription ratio are not available — the`)
  console.log(`CCA contract does not expose a requiredRaise field. Oversubscription`)
  console.log(`can only be estimated from external sources (e.g. CAP was reported 5.5x).`)
}

main().catch(console.error)
