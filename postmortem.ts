/**
 * Post-Mortem Stats Extract — all stats needed for an article, in one block
 *
 * Usage: npm run postmortem [auctionName]
 * Default: CAP
 */

import * as fs from 'fs'
import { q96ToPrice, q96ToDecimal } from './shared.ts'

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

  // ─── FDV Derivation (full chain, auditable) ──────────────────────────
  const floorQ96raw = target.floorPrice_Q96 || null
  const clearingQ96raw = target.finalClearingPrice_Q96 || null
  const currDecimals = target.currencySymbol === 'USDC' || target.currencySymbol === 'USDT' ? 6 : 18
  const tokDecimals = 18 // CCA auction tokens use 18 decimals (ERC20 standard)
  const shift = tokDecimals - currDecimals
  const supplyRaw = target.tokenSupply ? parseInt(target.tokenSupply.replace(/,/g, '')) : null

  // Step-by-step decode
  const Q96 = 2n ** 96n
  const decodePrice = (rawQ96: string) => {
    const big = BigInt(rawQ96)
    const shifted = shift >= 0 ? big * 10n ** BigInt(shift) : big / 10n ** BigInt(-shift)
    const whole = shifted / Q96
    const frac = (shifted % Q96) * 10n ** 8n / Q96
    const decoded = parseFloat(`${whole}.${frac.toString().padStart(8, '0')}`)
    return { big, shifted, decoded }
  }

  const floor = floorQ96raw ? decodePrice(floorQ96raw) : null
  const clearing = clearingQ96raw ? decodePrice(clearingQ96raw) : null

  const floorFDV = floor && supplyRaw ? floor.decoded * supplyRaw : null
  const clearingFDV = clearing && supplyRaw ? clearing.decoded * supplyRaw : null

  const formatUsd = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  // Total raised
  const raisedRaw = target.currencyRaised ? BigInt(target.currencyRaised) : null
  const raisedDivisor = 10n ** BigInt(currDecimals)

  console.log(`\nPOST-MORTEM: ${target.name}`)
  console.log('='.repeat(70))
  console.log()
  console.log(`Token:              ${target.tokenSymbol || '?'} (${target.tokenName || '?'})`)
  console.log(`Chain:              ${target.chain}`)
  console.log(`Token supply:       ${target.tokenSupply || '?'}`)
  console.log(`Currency:           ${target.currencySymbol || '?'}`)
  console.log()

  // ─── FDV derivation (auditable) ──────────────────────────────────────
  console.log(`FDV DERIVATION`)
  console.log('-'.repeat(70))
  console.log(`  tokenDecimals:     ${tokDecimals}`)
  console.log(`  currencyDecimals:  ${currDecimals}`)
  console.log(`  decimals shift:    ${shift} (token - currency)`)
  console.log(`  totalSupply:       ${target.tokenSupply || '?'} tokens (on-chain ERC20.totalSupply)`)
  console.log()
  if (floor) {
    console.log(`  FLOOR PRICE:`)
    console.log(`    raw Q96:         ${floorQ96raw}`)
    console.log(`    shifted (×10^${shift}): ${floor.shifted.toString()}`)
    console.log(`    ÷ 2^96:         ${floor.decoded.toFixed(8)} ${target.currencySymbol}/token`)
    console.log(`    FDV = ${floor.decoded.toFixed(8)} × ${supplyRaw?.toLocaleString()} = ${floorFDV !== null ? formatUsd(floorFDV) : '?'}`)
  }
  console.log()
  if (clearing) {
    console.log(`  CLEARING PRICE:`)
    console.log(`    raw Q96:         ${clearingQ96raw}`)
    console.log(`    shifted (×10^${shift}): ${clearing.shifted.toString()}`)
    console.log(`    ÷ 2^96:         ${clearing.decoded.toFixed(8)} ${target.currencySymbol}/token`)
    console.log(`    FDV = ${clearing.decoded.toFixed(8)} × ${supplyRaw?.toLocaleString()} = ${clearingFDV !== null ? formatUsd(clearingFDV) : '?'}`)
  }
  console.log()
  console.log(`  Clearing vs floor: ${target.clearingVsFloor || '?'}`)

  // Reconciliation check
  if (clearingFDV !== null && supplyRaw) {
    const reportedFDV = target.name === 'CAP' ? 106_000_000 : null
    if (reportedFDV) {
      const reconcilingSupply = Math.round(reportedFDV / clearing!.decoded)
      console.log()
      console.log(`  RECONCILIATION vs public $${(reportedFDV / 1e6).toFixed(0)}M FDV:`)
      console.log(`    Our decode:      ${formatUsd(clearingFDV)} (using totalSupply = ${supplyRaw.toLocaleString()})`)
      console.log(`    Public report:   ${formatUsd(reportedFDV)}`)
      console.log(`    Gap:             ${formatUsd(Math.abs(clearingFDV - reportedFDV))} (${((clearingFDV / reportedFDV - 1) * 100).toFixed(1)}%)`)
      console.log(`    Supply to match: ${reconcilingSupply.toLocaleString()} tokens at $${clearing!.decoded.toFixed(8)}/token`)
      console.log(`    Ratio:           ${(reconcilingSupply / supplyRaw).toFixed(4)}x our on-chain totalSupply`)
      const diff = reconcilingSupply - supplyRaw
      if (Math.abs(diff) / supplyRaw < 0.01) {
        console.log(`    Verdict:         Rounding difference — math is clean.`)
      } else {
        console.log(`    Verdict:         Public reporting uses a different supply assumption`)
        console.log(`                     (likely circulating/allocated supply, not ERC20.totalSupply).`)
      }
    }
  }
  console.log('-'.repeat(70))

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
