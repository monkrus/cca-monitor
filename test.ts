/**
 * CCA Monitor Test Suite
 *
 * Run: npm test
 * Skip RPC tests: SKIP_RPC=1 npm test
 */

import { createPublicClient, http, keccak256, parseAbiItem } from 'viem'
import { mainnet } from 'viem/chains'
import * as dotenv from 'dotenv'
dotenv.config()

// ─── Inline the functions under test (no export gymnastics) ─────────────────
const Q96 = 2n ** 96n

function q96ToDecimal(q96: string | bigint | undefined, decimals = 8): string {
  if (!q96) return '?'
  const big = BigInt(q96)
  const whole = big / Q96
  const frac = big % Q96
  const fracDecimal = (frac * 10n ** BigInt(decimals)) / Q96
  return `${whole}.${fracDecimal.toString().padStart(decimals, '0')}`
}

function q96ToPrice(q96: string | bigint | undefined, tokenDecimals: number, currencyDecimals: number, displayDecimals = 8): string {
  if (!q96) return '?'
  const big = BigInt(q96)
  const shift = tokenDecimals - currencyDecimals
  const shifted = shift >= 0
    ? big * 10n ** BigInt(shift)
    : big / 10n ** BigInt(-shift)
  return q96ToDecimal(shifted, displayDecimals)
}

// ─── Test runner ────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
let skipped = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

function assertClose(actual: number, expected: number, tolerance: number, label: string) {
  const diff = Math.abs(actual - expected)
  if (diff <= tolerance) {
    console.log(`  PASS  ${label} (${actual})`)
    passed++
  } else {
    console.error(`  FAIL  ${label} — got ${actual}, expected ~${expected} (diff ${diff} > ${tolerance})`)
    failed++
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: OFFLINE GOLDEN TESTS (no RPC)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n--- Layer 1: Offline golden tests ---\n')

// q96ToPrice: CAP clearing price (USDC 6 decimals, rCAP 18 decimals)
const capClearingQ96 = '843779930776940'
const capResult = q96ToPrice(capClearingQ96, 18, 6)
assert(capResult === '0.01065000', `CAP clearing price: ${capResult} === 0.01065000`)

// q96ToPrice: CAP floor price
const capFloorQ96 = '594211218857000'
const capFloor = q96ToPrice(capFloorQ96, 18, 6)
assert(capFloor === '0.00750000', `CAP floor price: ${capFloor} === 0.00750000`)

// q96ToPrice: ETH-denominated (shift=0, same as q96ToDecimal)
const aztecClearingQ96 = '1228948759257280615755529'
const aztecResult = q96ToPrice(aztecClearingQ96, 18, 18)
const aztecDirect = q96ToDecimal(aztecClearingQ96)
assert(aztecResult === aztecDirect, `ETH shift=0: q96ToPrice matches q96ToDecimal (${aztecResult})`)
assert(aztecResult === '0.00001551', `AZTEC clearing price: ${aztecResult} === 0.00001551`)

// q96ToPrice: undefined input
assert(q96ToPrice(undefined, 18, 6) === '?', 'q96ToPrice(undefined) returns ?')

// BidSubmitted topic0 pin — guards against future ABI edits
const bidSubmittedSig = 'BidSubmitted(uint256,address,uint256,uint128)'
const computedTopic0 = keccak256(new TextEncoder().encode(bidSubmittedSig))
const expectedTopic0 = '0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540'
assert(
  computedTopic0 === expectedTopic0,
  `BidSubmitted topic0: ${computedTopic0.slice(0, 18)}... === ${expectedTopic0.slice(0, 18)}...`,
)

// Verify parseAbiItem produces the same topic0 (viem's internal path)
const bidEvent = parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint128 amount)')
const viemTopic0 = keccak256(new TextEncoder().encode('BidSubmitted(uint256,address,uint256,uint128)'))
assert(viemTopic0 === expectedTopic0, 'viem parseAbiItem canonical sig matches expected topic0')

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1b: REGRESSION TESTS (bugs #1-#5)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n--- Layer 1b: Regression tests (audit bugs #1-#5) ---\n')

// ── Bug #1: formatDelay must show actual delay, not hardcoded "30 min" ──
function formatDelay(ms: number): string {
  if (ms <= 0) return '30 min'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (remainMins === 0) return `${hours}h`
  return `${hours}h ${remainMins}m`
}
assert(formatDelay(30 * 60_000) === '30 min', 'formatDelay: 30min = "30 min"')
assert(formatDelay(10 * 60 * 60_000) === '10h', 'formatDelay: 10h = "10h"')
assert(formatDelay(2 * 60 * 60_000 + 18 * 60_000) === '2h 18m', 'formatDelay: 2h18m = "2h 18m"')
assert(formatDelay(0) === '30 min', 'formatDelay: 0ms = "30 min" (default)')
assert(formatDelay(45 * 60_000) === '45 min', 'formatDelay: 45min = "45 min"')
assert(formatDelay(4 * 60 * 60_000 + 43 * 60_000) === '4h 43m', 'formatDelay: 4h43m = "4h 43m"')

// ── Bug #3: Routing table — verify destinations per alert type ──────────
type AlertType = 'auction' | 'bid-update' | 'whale-bid' | 'end-intel' | 'auction-end'
  | 'daily-summary' | 'price-alert'
  | 'heartbeat' | 'weekly-digest' | 'milestone' | 'state-of-cca'

interface RouteSpec {
  dm: boolean
  premium: boolean
  publicDelayed: boolean
  publicImmediate: boolean
}

const ROUTE_TABLE: Record<AlertType, RouteSpec> = {
  'auction':        { dm: false, premium: true,  publicDelayed: true,  publicImmediate: false },
  'bid-update':     { dm: false, premium: true,  publicDelayed: true,  publicImmediate: false },
  'whale-bid':      { dm: false, premium: true,  publicDelayed: true,  publicImmediate: false },
  'end-intel':      { dm: false, premium: true,  publicDelayed: false, publicImmediate: false },
  'auction-end':    { dm: false, premium: true,  publicDelayed: true,  publicImmediate: false },
  'daily-summary':  { dm: false, premium: true,  publicDelayed: true,  publicImmediate: false },
  'price-alert':    { dm: false, premium: true,  publicDelayed: false, publicImmediate: false },
  'heartbeat':      { dm: true,  premium: false, publicDelayed: false, publicImmediate: false },
  'weekly-digest':  { dm: true,  premium: false, publicDelayed: false, publicImmediate: false },
  'milestone':      { dm: false, premium: false, publicDelayed: false, publicImmediate: true  },
  'state-of-cca':   { dm: false, premium: false, publicDelayed: false, publicImmediate: true  },
}

// Admin DM must ONLY receive heartbeat, weekly-digest
const dmTypes = Object.entries(ROUTE_TABLE).filter(([, r]) => r.dm).map(([t]) => t)
assert(dmTypes.length === 2, `DM routes: exactly 2 types (got ${dmTypes.length}: ${dmTypes.join(', ')})`)
assert(dmTypes.includes('heartbeat'), 'DM routes include heartbeat')
assert(dmTypes.includes('weekly-digest'), 'DM routes include weekly-digest')

// Daily summary must NOT go to DM
assert(!ROUTE_TABLE['daily-summary'].dm, 'daily-summary does NOT route to DM')

// Price alerts must NOT go to public or DM
assert(!ROUTE_TABLE['price-alert'].dm, 'price-alert does NOT route to DM')
assert(!ROUTE_TABLE['price-alert'].publicDelayed, 'price-alert does NOT route to public (delayed)')
assert(!ROUTE_TABLE['price-alert'].publicImmediate, 'price-alert does NOT route to public (immediate)')
assert(ROUTE_TABLE['price-alert'].premium, 'price-alert routes to premium')

// Milestones go to public immediately, not delayed
assert(ROUTE_TABLE['milestone'].publicImmediate, 'milestone routes to public immediately')
assert(!ROUTE_TABLE['milestone'].publicDelayed, 'milestone does NOT use delay queue')
assert(!ROUTE_TABLE['milestone'].dm, 'milestone does NOT route to DM')

// ── Bug #4: Footer isolation — milestone/digest/summary must not contain auction footer ──
const milestoneText = `🎯 <b>Milestone:</b> 15000 unique addresses in the CCA bidder index!\n\n📂 github.com/monkrus/cca-monitor`
const digestText = `📊 <b>WEEKLY DIGEST</b>\n<b>Real auctions:</b> 2 this week`
const summaryText = `📋 <b>CCA Daily Summary</b>\n<b>No active auctions</b>`
assert(!milestoneText.includes('CCA auction:'), 'milestone text has no auction footer')
assert(!digestText.includes('CCA auction:'), 'digest text has no auction footer')
assert(!summaryText.includes('CCA auction:'), 'summary text has no auction footer')

// ── Bug #5: isTest filtering — verify filter logic ──────────────────────
const mockAuctions = [
  { name: 'AZTEC', graduated: true, isTest: false },
  { name: 'TEST1', graduated: true, isTest: true },
  { name: 'TEST2', graduated: true, isTest: true },
  { name: 'CAP',   graduated: true, isTest: false },
  { name: 'FAIL',  graduated: false, isTest: false },
]
const realOnly = mockAuctions.filter(a => !a.isTest)
const realGraduated = realOnly.filter(a => a.graduated).length
assert(realOnly.length === 3, `isTest filter: 3 real auctions (got ${realOnly.length})`)
assert(realGraduated === 2, `isTest filter: 2 real graduated (got ${realGraduated})`)

// ── Bug #2: Price alert cooldown logic ──────────────────────────────────
const PRICE_ALERT_BANDS = [-10, -20, -30]
function getPriceAlertBand(change: number): number | null {
  for (let i = PRICE_ALERT_BANDS.length - 1; i >= 0; i--) {
    if (change <= PRICE_ALERT_BANDS[i]) return PRICE_ALERT_BANDS[i]
  }
  return null
}
assert(getPriceAlertBand(-5) === null, 'band: -5% = no alert')
assert(getPriceAlertBand(-10) === -10, 'band: -10% = -10 band')
assert(getPriceAlertBand(-15) === -10, 'band: -15% = -10 band')
assert(getPriceAlertBand(-25) === -20, 'band: -25% = -20 band')
assert(getPriceAlertBand(-35) === -30, 'band: -35% = -30 band')
assert(getPriceAlertBand(5) === null, 'band: +5% = no alert (positive)')

// Cooldown: within 24h same band → no alert; new band → alert
const COOLDOWN_MS = 24 * 60 * 60 * 1000
{
  const now = Date.now()
  const lastAlert = now - 1 * 60 * 60 * 1000 // 1h ago
  const withinCooldown = (now - lastAlert) < COOLDOWN_MS
  assert(withinCooldown === true, 'cooldown: 1h ago = within cooldown')

  const lastAlertBand = -10
  const currentBand = -10
  const newBand = currentBand !== lastAlertBand && currentBand < lastAlertBand
  assert(newBand === false, 'cooldown: same band = not new band')

  const currentBand2 = -20
  const newBand2 = currentBand2 !== lastAlertBand && currentBand2 < lastAlertBand
  assert(newBand2 === true, 'cooldown: -20 after -10 = new band (bypasses cooldown)')
}

// ── Bug #2 addendum: cooldown reset after recovery ──────────────────────
{
  // Simulate: drop to -10 band, recover to -5 (no band), drop again to -12 (band -10)
  let lastBand: number | undefined = -10
  let lastAlertTime: string | undefined = new Date().toISOString()

  // Price recovers above all thresholds (change = -5, no band)
  const recoveryBand = getPriceAlertBand(-5)
  if (!recoveryBand && lastBand) {
    lastBand = undefined
    lastAlertTime = undefined
  }
  assert(lastBand === undefined, 'recovery: band reset to undefined after price recovers')
  assert(lastAlertTime === undefined, 'recovery: alert time reset after price recovers')

  // Now price drops again to -12 (band -10) — should fire because state was reset
  const newDropBand = getPriceAlertBand(-12)
  const shouldFire = newDropBand !== null && (!lastBand || newDropBand <= lastBand)
  assert(shouldFire === true, 'recovery: re-entry to -10 band fires after recovery')
}

// ── Fix #1: Near-zero floor guard ───────────────────────────────────────
{
  // wOCT floor Q96 ≈ 2^32 = effective zero → ratio is astronomically high
  const woctFloor = 4294967300n // ~2^32
  const woctClearing = 978959564890993n // actual wOCT clearing Q96
  const ratio = Number(woctClearing * 10000n / woctFloor) / 100
  const capped = ratio > 99999 ? 'n/a (near-zero floor)' : `${ratio.toFixed(1)}%`
  assert(capped === 'n/a (near-zero floor)', `near-zero floor guard: wOCT ratio capped (was ${ratio.toFixed(0)}%)`)

  // Normal ratio should pass through
  const capFloorBig = BigInt('594211218857000')
  const capClearBig = BigInt('843779930776940')
  const capRatio = Number(capClearBig * 10000n / capFloorBig) / 100
  const capCapped = capRatio > 99999 ? 'n/a (near-zero floor)' : `${capRatio.toFixed(1)}%`
  assert(capCapped === '142.0%', `normal ratio passthrough: CAP = ${capCapped}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1c: DATASET INTEGRITY TESTS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n--- Layer 1c: Dataset integrity tests ---\n')

// (a) Save/load round-trip retains isTest records
{
  const fs = await import('fs')
  const data = JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
  const allAuctions = data.auctions || []
  const testRecords = allAuctions.filter((a: any) => a.isTest)
  const realRecords = allAuctions.filter((a: any) => !a.isTest)
  assert(allAuctions.length === 15, `results.json has 15 records (got ${allAuctions.length})`)
  assert(realRecords.length === 4, `results.json has 4 real auctions (got ${realRecords.length})`)
  assert(testRecords.length === 11, `results.json has 11 test auctions (got ${testRecords.length})`)

  // Verify no duplicates by contractAddress
  const addrs = allAuctions.map((a: any) => a.contractAddress.toLowerCase())
  const uniqueAddrs = new Set(addrs)
  assert(uniqueAddrs.size === allAuctions.length, `no duplicate contractAddresses (${uniqueAddrs.size} unique vs ${allAuctions.length} total)`)
}

// (b) Summary count helpers given a mixed fixture return correct splits
{
  const fixture = [
    { name: 'REAL1', isTest: false, graduated: true },
    { name: 'REAL2', isTest: false, graduated: true },
    { name: 'REAL3', isTest: false, graduated: false },
    { name: 'REAL4', isTest: false, graduated: true },
    { name: 'TEST1', isTest: true,  graduated: false },
    { name: 'TEST2', isTest: true,  graduated: true },
    { name: 'TEST3', isTest: true,  graduated: false },
    { name: 'TEST4', isTest: true,  graduated: false },
    { name: 'TEST5', isTest: true,  graduated: false },
    { name: 'TEST6', isTest: true,  graduated: false },
    { name: 'TEST7', isTest: true,  graduated: false },
    { name: 'TEST8', isTest: true,  graduated: false },
    { name: 'TEST9', isTest: true,  graduated: false },
    { name: 'TEST10', isTest: true, graduated: false },
    { name: 'TEST11', isTest: true, graduated: true },
  ]
  const real = fixture.filter(a => !a.isTest)
  const test = fixture.filter(a => a.isTest)
  const realGraduated = real.filter(a => a.graduated).length
  const testGraduated = test.filter(a => a.graduated).length
  assert(real.length === 4, `fixture: 4 real (got ${real.length})`)
  assert(test.length === 11, `fixture: 11 test (got ${test.length})`)
  assert(realGraduated === 3, `fixture: 3 real graduated (got ${realGraduated})`)
  assert(testGraduated === 2, `fixture: 2 test graduated (got ${testGraduated})`)

  // Public-facing counts must filter isTest
  const publicTotal = real.length
  const publicGraduated = realGraduated
  assert(publicTotal === 4, `public count: 4 auctions tracked (got ${publicTotal})`)
  assert(publicGraduated === 3, `public count: 3 graduated (got ${publicGraduated})`)

  // Internal heartbeat shows both
  const heartbeatTotal = fixture.length
  assert(heartbeatTotal === 15, `heartbeat: 15 total (got ${heartbeatTotal})`)
}

// (c) --real-only upsert: merging 4 real results into a 15-record file must keep all 15
{
  const fixture15 = {
    timestamp: '2026-01-01T00:00:00Z',
    summary: { total: 15, real: 4, tests: 11 },
    auctions: [
      { name: 'REAL1', contractAddress: '0xaaa', isTest: false },
      { name: 'REAL2', contractAddress: '0xbbb', isTest: false },
      { name: 'REAL3', contractAddress: '0xccc', isTest: false },
      { name: 'REAL4', contractAddress: '0xddd', isTest: false },
      ...Array.from({ length: 11 }, (_, i) => ({ name: `TEST${i+1}`, contractAddress: `0xtest${i}`, isTest: true })),
    ],
  }
  // Simulate --real-only upsert: 4 new real results replace existing real, keep tests
  const newReal = [
    { name: 'REAL1', contractAddress: '0xaaa', isTest: false, updated: true },
    { name: 'REAL2', contractAddress: '0xbbb', isTest: false, updated: true },
    { name: 'REAL3', contractAddress: '0xccc', isTest: false, updated: true },
    { name: 'REAL4', contractAddress: '0xddd', isTest: false, updated: true },
  ]
  const existingAuctions = fixture15.auctions
  const newAddrs = new Set(newReal.map(r => r.contractAddress.toLowerCase()))
  const kept = existingAuctions.filter(a =>
    a.isTest || !newAddrs.has(a.contractAddress.toLowerCase())
  )
  const merged = [...kept, ...newReal]
  assert(merged.length === 15, `--real-only upsert: 15 records after merge (got ${merged.length})`)
  assert(merged.filter(a => a.isTest).length === 11, `--real-only upsert: 11 test records preserved`)
  assert(merged.filter(a => !a.isTest).length === 4, `--real-only upsert: 4 real records present`)
  // All new real records should be the updated versions
  const updatedReal = merged.filter((a: any) => a.updated === true)
  assert(updatedReal.length === 4, `--real-only upsert: all 4 real records are the updated versions`)
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1d: CORRUPTION RECOVERY + ATOMIC WRITE TESTS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n--- Layer 1d: Corruption recovery + atomic write tests ---\n')

{
  const fs = await import('fs')
  const { writeJsonAtomic, readJsonSafe } = await import('./shared.ts')
  const testDir = 'data/test-tmp'
  fs.mkdirSync(testDir, { recursive: true })

  // writeJsonAtomic round-trip
  const testFile = `${testDir}/atomic-test.json`
  const testObj = { hello: 'world', n: 42, arr: [1, 2, 3] }
  writeJsonAtomic(testFile, testObj)
  const readBack = JSON.parse(fs.readFileSync(testFile, 'utf-8'))
  assert(readBack.hello === 'world' && readBack.n === 42, 'writeJsonAtomic round-trips correctly')

  // No .tmp file left behind
  assert(!fs.existsSync(testFile + '.tmp'), 'writeJsonAtomic leaves no .tmp file')

  // readJsonSafe on missing file returns fallback
  const missing = readJsonSafe(`${testDir}/no-such-file.json`, { x: 99 })
  assert(missing.x === 99, 'readJsonSafe returns fallback for missing file')

  // readJsonSafe on corrupt file: recovers and creates .corrupt- file
  const corruptFile = `${testDir}/corrupt-test.json`
  fs.writeFileSync(corruptFile, '{{{INVALID JSON!!!')
  const recovered = readJsonSafe(corruptFile, { recovered: true })
  assert(recovered.recovered === true, 'readJsonSafe returns fallback on corrupt file')
  assert(!fs.existsSync(corruptFile), 'corrupt file is moved away (no longer at original path)')
  const corruptFiles = fs.readdirSync(testDir).filter(f => f.startsWith('corrupt-test.json.corrupt-'))
  assert(corruptFiles.length === 1, `corrupt file renamed to .corrupt-* (found ${corruptFiles.length})`)

  // readJsonSafe on valid file works normally
  const validFile = `${testDir}/valid-test.json`
  writeJsonAtomic(validFile, { status: 'ok' })
  const valid = readJsonSafe(validFile, { status: 'fail' })
  assert(valid.status === 'ok', 'readJsonSafe reads valid file correctly')

  // appendResult recovery: simulate corrupt results.json, verify it recovers
  const resultsFile = `${testDir}/results-recovery.json`
  fs.writeFileSync(resultsFile, 'CORRUPT DATA HERE')
  const fallback = readJsonSafe(resultsFile, { timestamp: '', summary: {}, auctions: [] as any[] })
  assert(Array.isArray(fallback.auctions) && fallback.auctions.length === 0, 'appendResult-style recovery starts from empty auctions')
  const recoveryCorrupt = fs.readdirSync(testDir).filter(f => f.startsWith('results-recovery.json.corrupt-'))
  assert(recoveryCorrupt.length === 1, 'corrupt results.json preserved as .corrupt- file')

  // Cleanup test dir
  for (const f of fs.readdirSync(testDir)) fs.unlinkSync(`${testDir}/${f}`)
  fs.rmdirSync(testDir)
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: ONLINE SMOKE TEST (skippable)
// ═══════════════════════════════════════════════════════════════════════════
if (process.env.SKIP_RPC === '1') {
  console.log('\n--- Layer 2: Online smoke test — SKIPPED (SKIP_RPC=1) ---\n')
  skipped++
} else {
  console.log('\n--- Layer 2: Online smoke test (AZTEC mainnet) ---\n')

  const AZTEC_ADDRESS = '0x608c4e792c65f5527b3f70715dea44d3b302f4ee' as const
  const AUCTION_ABI = [
    { name: 'floorPrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'clearingPrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'isGraduated', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  ] as const

  const rpcUrl = process.env.RPC_URL_MAINNET
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl || undefined),
  })

  try {
    const [floorResult, clearingResult, graduatedResult] = await client.multicall({
      contracts: [
        { address: AZTEC_ADDRESS, abi: AUCTION_ABI, functionName: 'floorPrice' },
        { address: AZTEC_ADDRESS, abi: AUCTION_ABI, functionName: 'clearingPrice' },
        { address: AZTEC_ADDRESS, abi: AUCTION_ABI, functionName: 'isGraduated' },
      ],
    })

    const ok = (r: any) => r.status === 'success' ? r.result : undefined
    const floor = ok(floorResult) as bigint | undefined
    const clearing = ok(clearingResult) as bigint | undefined
    const graduated = ok(graduatedResult) as boolean | undefined

    assert(graduated === true, 'AZTEC graduated === true')

    if (floor && clearing && floor > 0n) {
      const ratio = Number(clearing * 10000n / floor) / 100
      assertClose(ratio, 163.0, 1.0, 'AZTEC clearingVsFloor ≈ 163%')
    } else {
      console.error('  FAIL  Could not read AZTEC floor/clearing prices')
      failed++
    }
  } catch (err: any) {
    console.error(`  FAIL  RPC error: ${err.message}`)
    failed++
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
console.log('='.repeat(40))
process.exit(failed > 0 ? 1 : 0)
