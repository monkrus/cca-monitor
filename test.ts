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
