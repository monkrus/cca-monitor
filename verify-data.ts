/**
 * verify-data — dataset integrity checker
 *
 * Checks data/results.json and data/bidder-index.json against
 * data/invariants.json. Invariants auto-update on growth (new real
 * auctions) but never silently on shrinkage.
 *
 * Usage: npm run verify-data
 * Also runs as part of: npm test
 */

import * as fs from 'fs'

let passed = 0
let failed = 0

function check(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

console.log('\n--- verify-data: dataset integrity ---\n')

// Load files
const results = JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
const bidderIndex = JSON.parse(fs.readFileSync('data/bidder-index.json', 'utf-8'))
const invariants = JSON.parse(fs.readFileSync('data/invariants.json', 'utf-8'))

const allAuctions = results.auctions || []
const real = allAuctions.filter((a: any) => !a.isTest)
const test = allAuctions.filter((a: any) => a.isTest)
const repeatBidders = bidderIndex.filter((e: any) => e.auctionCount >= 2)
const allFourBidders = bidderIndex.filter((e: any) => e.auctionCount === 4)

// ── Check counts against invariants (must not shrink) ──────────────────
check(allAuctions.length >= invariants.minTotalAuctions,
  `total auctions >= ${invariants.minTotalAuctions} (got ${allAuctions.length})`)
check(real.length >= invariants.minRealAuctions,
  `real auctions >= ${invariants.minRealAuctions} (got ${real.length})`)
check(test.length >= invariants.minTestAuctions,
  `test auctions >= ${invariants.minTestAuctions} (got ${test.length})`)

// ── No duplicates ──────────────────────────────────────────────────────
const addrs = allAuctions.map((a: any) => a.contractAddress?.toLowerCase())
const uniqueAddrs = new Set(addrs)
check(uniqueAddrs.size === allAuctions.length,
  `no duplicate contractAddresses (${uniqueAddrs.size} unique vs ${allAuctions.length} total)`)

const names = allAuctions.map((a: any) => a.name)
const uniqueNames = new Set(names)
check(uniqueNames.size === allAuctions.length,
  `no duplicate names (${uniqueNames.size} unique vs ${allAuctions.length} total)`)

// ── Bidder index ───────────────────────────────────────────────────────
check(bidderIndex.length >= invariants.expectedBidderIndexEntries,
  `unique=${bidderIndex.length} >= ${invariants.expectedBidderIndexEntries}`)
check(repeatBidders.length >= invariants.expectedRepeatBidders,
  `repeat(2+)=${repeatBidders.length} >= ${invariants.expectedRepeatBidders}`)
check(allFourBidders.length >= invariants.expectedAllFourBidders,
  `all-four=${allFourBidders.length} >= ${invariants.expectedAllFourBidders}`)

// ── Summary.real/tests match actual counts ─────────────────────────────
if (results.summary) {
  check(results.summary.total === allAuctions.length,
    `summary.total matches auction count (${results.summary.total})`)
  check(results.summary.real === real.length,
    `summary.real matches real count (${results.summary.real})`)
  check(results.summary.tests === test.length,
    `summary.tests matches test count (${results.summary.tests})`)
}

// ── Auto-update invariants on GROWTH (never on shrinkage) ──────────────
let updated = false
if (real.length > invariants.minRealAuctions) {
  console.log(`\n  Invariant update: minRealAuctions ${invariants.minRealAuctions} -> ${real.length} (new real auction added)`)
  invariants.minRealAuctions = real.length
  invariants.minTotalAuctions = allAuctions.length
  invariants.minTestAuctions = test.length
  updated = true
}
if (bidderIndex.length > invariants.expectedBidderIndexEntries) {
  console.log(`  Invariant update: expectedBidderIndexEntries ${invariants.expectedBidderIndexEntries} -> ${bidderIndex.length}`)
  invariants.expectedBidderIndexEntries = bidderIndex.length
  updated = true
}
if (repeatBidders.length > invariants.expectedRepeatBidders) {
  invariants.expectedRepeatBidders = repeatBidders.length
  updated = true
}
if (allFourBidders.length > invariants.expectedAllFourBidders) {
  invariants.expectedAllFourBidders = allFourBidders.length
  updated = true
}
if (updated) {
  fs.writeFileSync('data/invariants.json', JSON.stringify(invariants, null, 2) + '\n')
  console.log('  Invariants updated (growth detected).')
}

// ── Result ─────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`)
console.log(`verify-data: ${passed} passed, ${failed} failed`)
console.log('='.repeat(40))

if (failed > 0) process.exit(1)
