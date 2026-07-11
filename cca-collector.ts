/**
 * CCA Data Collector + New Auction Monitor
 *
 * Two jobs in one file:
 * 1. HISTORICAL: Pull parameters + outcomes from known completed CCAs
 * 2. LIVE MONITOR: Watch the factory contract for new auction deployments
 *
 * Stack: viem (lightweight, no ethers needed), dotenv
 * Works on Ethereum mainnet, Base, Arbitrum, Unichain
 *
 * Install: npm install viem dotenv
 */

import { createPublicClient, http, parseAbiItem, defineChain } from 'viem'
import { mainnet, base, arbitrum } from 'viem/chains'
import * as fs from 'fs'
import * as dotenv from 'dotenv'
import { checkCrashLoop, writeJsonAtomic, readJsonSafe } from './shared.ts'
dotenv.config()

// ─── Unichain definition (not yet in viem) ──────────────────────────────────
const unichain = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } },
  blockExplorers: { default: { name: 'Uniscan', url: 'https://uniscan.xyz' } },
})

// ─── Factory addresses (same across all chains) ─────────────────────────────
// V1: 0x0000ccaDF55C911a2FbC0BB9d2942Aa77c6FAa1D (early auctions, Dec 2025 – Feb 2026)
// V2: 0xcccccccae7503cac057829bf2811de42e16e0bd5 (current — wOCT, STRATO, CAP, etc.)
const FACTORY_ADDRESS = '0xcccccccae7503cac057829bf2811de42e16e0bd5' as const

// ─── Q96 math ────────────────────────────────────────────────────────────────
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

// ─── Known completed auctions (add more as they happen) ─────────────────────
// Discovery: Uniswap app URL pattern: app.uniswap.org/explore/auctions/{chain}/{contractAddress}
// Also monitor @UniswapAuctions on X — they post every new auction publicly
// Factory events indexed via Blockscout: eth.blockscout.com / base.blockscout.com
const KNOWN_AUCTIONS = [
  {
    name: 'AZTEC',
    chain: 'mainnet',
    contractAddress: '0x608c4e792c65f5527b3f70715dea44d3b302f4ee' as `0x${string}`,
    startBlock: 23790741n,
    notes: '$59M raised, 17,232 bids, 14,096 unique bidders, Nov-Dec 2025. Concluded block 23,955,276. Validation hook: ZK Passport + contributor allowlist.',
    isTest: false,
  },
  {
    name: 'STRATO',
    chain: 'mainnet',
    contractAddress: '0xfFDab1083fCbBCEE32997795388B3D61Ebab786E' as `0x${string}`,
    startBlock: 0n,
    notes: '803.9 ETH raised (cleared bids), ~577 bids, ~291 unique wallets, Jun 3-11 2026. HardFi/gold platform.',
    isTest: false,
  },
  {
    name: 'wOCT',
    chain: 'mainnet',
    contractAddress: '0xb3079Ec6b82f22A1ABfDCA1A22659aB07Cdf2f0F' as `0x${string}`,
    startBlock: 0n,
    notes: 'Wrapped OCT token. 7-day auction, ETH currency, graduated. Found via Uniswap app.',
    isTest: false,
  },
  {
    name: 'CAP',
    chain: 'mainnet',
    contractAddress: '0x20eebd78151eae9ed2380ac613204aaf5ca0cd24' as `0x${string}`,
    startBlock: 0n,
    notes: '1,002 bids, 5.5x oversubscribed, $106M FDV, $3.8M USDC raised (cleared bids), floor $75M FDV, cleared at $0.011/CAP. Token: rCAP.',
    isTest: false,
  },
  // ── Test/early auctions on Base (Dec 2025 – Jan 2026) ─────────────────────
  // All failed graduation, tiny tick spacing, no bids — confirmed test deployments
  { name: 'TEST_DEC08',  chain: 'base', contractAddress: '0x090e15d1807e2173c6e9531cfd4701fcd3c04ede' as `0x${string}`, startBlock: 39206206n, notes: 'Dec 8 2025 — test deployment',  isTest: true },
  { name: 'TEST_DEC18',  chain: 'base', contractAddress: '0x4d147d5e6f1cf4af6cd50933eae37f4660743c35' as `0x${string}`, startBlock: 39624912n, notes: 'Dec 18 2025 — test deployment', isTest: true },
  { name: 'TEST_DEC23',  chain: 'base', contractAddress: '0x58bedc5577044c4f3ca7b2a76ce411ca02ba394b' as `0x${string}`, startBlock: 39869623n, notes: 'Dec 23 2025 — test deployment', isTest: true },
  { name: 'TEST_DEC26A', chain: 'base', contractAddress: '0xc1390b7131fce0e96a5ccea739df3016d9a70313' as `0x${string}`, startBlock: 39992861n, notes: 'Dec 26 2025 — test deployment', isTest: true },
  { name: 'TEST_DEC26B', chain: 'base', contractAddress: '0x44c18e14fa976cde87f702aa564df28f33ee9d36' as `0x${string}`, startBlock: 39995131n, notes: 'Dec 26 2025 — test deployment', isTest: true },
  { name: 'TEST_JAN05',  chain: 'base', contractAddress: '0xcf984ee5001acc3707926d6cc9597fdddc771193' as `0x${string}`, startBlock: 40426331n, notes: 'Jan 5 2026 — test deployment',  isTest: true },
  { name: 'TEST_JAN19',  chain: 'base', contractAddress: '0x86cc18d5943cb81e10f3b4dea96762433a823047' as `0x${string}`, startBlock: 41019521n, notes: 'Jan 19 2026 — test deployment', isTest: true },
  // May 26 cluster — test deployments (100% tick spacing, <10 min durations, same token)
  { name: 'TEST_MAY26A', chain: 'base', contractAddress: '0x85e34f170f6f89e377e23531246c727ede55775e' as `0x${string}`, startBlock: 46499907n, notes: 'May 26 2026 — test deployment', isTest: true },
  { name: 'TEST_MAY26B', chain: 'base', contractAddress: '0x8175727b13e020d0811ced94a8863b7f49e417b1' as `0x${string}`, startBlock: 46500844n, notes: 'May 26 2026 — test deployment', isTest: true },
  { name: 'TEST_MAY26C', chain: 'base', contractAddress: '0x1cdadeeceb6017d19e64b4dc23377d003d174867' as `0x${string}`, startBlock: 46501079n, notes: 'May 26 2026 — test deployment', isTest: true },
  { name: 'TEST_MAY26D', chain: 'base', contractAddress: '0x5107cc753cc9d246de31ec999d549257cde3ae6d' as `0x${string}`, startBlock: 46501539n, notes: 'May 26 2026 — test deployment', isTest: true },
]

// ─── ABI fragments we care about ────────────────────────────────────────────

const FACTORY_ABI = [
  parseAbiItem('event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)'),
] as const

const AUCTION_ABI = [
  { name: 'currency',               type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'tokensRecipient',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fundsRecipient',         type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'startBlock',             type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64'  }] },
  { name: 'endBlock',               type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64'  }] },
  { name: 'claimBlock',             type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64'  }] },
  { name: 'tickSpacing',            type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'validationHook',         type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'floorPrice',             type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'clearingPrice',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'isGraduated',            type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool'    }] },
  { name: 'currencyRaised',         type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalCleared',           type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'token',                  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  parseAbiItem('event CheckpointUpdated(uint256 indexed blockNumber, uint256 clearingPrice, uint24 cumulativeMps)'),
  parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint128 amount)'),
] as const

const ERC20_ABI = [
  { name: 'name',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { name: 'symbol',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { name: 'decimals',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'   }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

// ─── Chain config ────────────────────────────────────────────────────────────
const CHAINS: Record<string, { chain: any, secsPerBlock: number, explorer: string }> = {
  mainnet:  { chain: mainnet,  secsPerBlock: 12,   explorer: 'https://etherscan.io' },
  base:     { chain: base,     secsPerBlock: 2,    explorer: 'https://basescan.org' },
  arbitrum: { chain: arbitrum, secsPerBlock: 0.25, explorer: 'https://arbiscan.io' },
  unichain: { chain: unichain, secsPerBlock: 1,    explorer: 'https://uniscan.xyz' },
}

// ─── RPC clients ────────────────────────────────────────────────────────────
const PUBLIC_RPCS: Record<string, string> = {
  mainnet:  'https://eth.blockscout.com/api/eth-rpc',
  base:     'https://base.blockscout.com/api/eth-rpc',
  arbitrum: 'https://arbitrum.blockscout.com/api/eth-rpc',
}

function getClient(chainName: string, usePublicRpc = false) {
  const rpcUrl = usePublicRpc
    ? PUBLIC_RPCS[chainName]
    : process.env[`RPC_URL_${chainName.toUpperCase()}`]
  const chainCfg = CHAINS[chainName]
  if (!chainCfg) throw new Error(`Unknown chain: ${chainName}`)
  return createPublicClient({
    chain: chainCfg.chain,
    transport: http(rpcUrl || undefined),
  })
}

// ─── Webhook alerting ────────────────────────────────────────────────────────
async function sendWebhook(payload: Record<string, any>) {
  const url = process.env.WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err: any) {
    console.error(`Webhook failed: ${err.message}`)
  }
}

// ─── Telegram alerting ──────────────────────────────────────────────────────
const TELEGRAM_TARGETS = {
  dm: process.env.TELEGRAM_CHAT_ID,                    // your personal DM
  premium: process.env.TELEGRAM_PREMIUM_CHANNEL_ID,    // paid subscribers (instant)
  public: process.env.TELEGRAM_PUBLIC_CHANNEL_ID,       // free followers (delayed)
}
const PUBLIC_DELAY_MS = 30 * 60 * 1000 // 30-minute delay for public channel

// ─── Routing table (single source of truth for all alert routing) ───────────
type AlertType = 'auction' | 'bid-update' | 'whale-bid' | 'end-intel' | 'auction-end'
  | 'daily-summary' | 'price-alert'
  | 'heartbeat' | 'weekly-digest' | 'milestone' | 'state-of-cca'

interface RouteSpec {
  dm: boolean
  premium: boolean
  publicDelayed: boolean
  publicImmediate: boolean
}

export const ROUTE_TABLE: Record<AlertType, RouteSpec> = {
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

// ─── Persistent public alert queue ──────────────────────────────────────────
const PENDING_ALERTS_FILE = 'data/pending-public-alerts.json'

interface PendingAlert {
  sendAt: string
  text: string
  queuedAt: string
}

let pendingAlertsCache: PendingAlert[] | null = null

function loadPendingAlerts(): PendingAlert[] {
  if (pendingAlertsCache !== null) return pendingAlertsCache
  pendingAlertsCache = readJsonSafe<PendingAlert[]>(PENDING_ALERTS_FILE, [])
  return pendingAlertsCache
}

function savePendingAlerts(alerts: PendingAlert[]) {
  pendingAlertsCache = alerts
  writeJsonAtomic(PENDING_ALERTS_FILE, alerts)
}

function formatDelay(ms: number): string {
  if (ms <= 0) return '30 min'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (remainMins === 0) return `${hours}h`
  return `${hours}h ${remainMins}m`
}

async function flushPendingAlerts() {
  const alerts = loadPendingAlerts()
  if (!alerts.length) return
  const now = Date.now()
  const ready = alerts.filter(a => new Date(a.sendAt).getTime() <= now)
  const remaining = alerts.filter(a => new Date(a.sendAt).getTime() > now)
  const publicId = TELEGRAM_TARGETS.public
  if (publicId && ready.length > 0) {
    for (const alert of ready) {
      const queuedTime = alert.queuedAt ? new Date(alert.queuedAt).getTime() : 0
      const actualDelayMs = queuedTime ? now - queuedTime : 0
      const delayStr = formatDelay(actualDelayMs)
      const footerText = `\n\n⏱ <i>Delayed ${delayStr}. Get instant alerts:</i> <b>@cca_monitor_bot</b>`
      await sendTelegramTo(publicId, alert.text + footerText)
    }
    savePendingAlerts(remaining)
    console.log(`Flushed ${ready.length} pending public alert(s)`)
  }
}

async function sendTelegramTo(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } catch (err: any) {
    console.error(`Telegram failed (${chatId}): ${err.message}`)
  }
}

/** Single routing function — every alert goes through here. */
async function routeAlert(alertType: AlertType, text: string) {
  const route = ROUTE_TABLE[alertType]
  const instantTargets: string[] = []
  if (route.dm && TELEGRAM_TARGETS.dm) instantTargets.push(TELEGRAM_TARGETS.dm)
  if (route.premium && TELEGRAM_TARGETS.premium) instantTargets.push(TELEGRAM_TARGETS.premium)
  if (route.publicImmediate && TELEGRAM_TARGETS.public) instantTargets.push(TELEGRAM_TARGETS.public)
  if (instantTargets.length > 0) await Promise.all(instantTargets.map(id => sendTelegramTo(id, text)))

  if (route.publicDelayed && TELEGRAM_TARGETS.public) {
    const now = new Date()
    const alerts = loadPendingAlerts()
    alerts.push({
      sendAt: new Date(now.getTime() + PUBLIC_DELAY_MS).toISOString(),
      text,
      queuedAt: now.toISOString(),
    })
    savePendingAlerts(alerts)
  }
}

function formatTelegramAlert(detection: Record<string, any>, analysis?: Record<string, any> | null): string {
  const lines = [
    `🚨 <b>NEW CCA DETECTED</b>`,
    ``,
    `<b>Chain:</b> ${detection.chain.toUpperCase()}`,
    `<b>Auction:</b> <code>${detection.auction}</code>`,
    `<b>Token:</b> <code>${detection.token}</code>`,
  ]
  if (analysis) {
    if (analysis.tokenSymbol) lines.push(`<b>Token:</b> ${analysis.tokenSymbol} (${analysis.tokenName})`)
    if (analysis.tokenSupply) lines.push(`<b>Supply:</b> ${analysis.tokenSupply}`)
    lines.push(`<b>Currency:</b> ${analysis.currencySymbol || 'Unknown'}`)
    if (analysis.durationHours) lines.push(`<b>Duration:</b> ${analysis.durationHours}h (${(analysis.durationHours / 24).toFixed(1)} days)`)
    if (analysis.floorPrice) lines.push(`<b>Floor price:</b> ${analysis.floorPrice}`)
    lines.push(`<b>Validation hook:</b> ${analysis.hasValidationHook ? '✅ Yes (KYC/allowlist)' : '⚠️ No'}`)
    if (analysis.currencyRaisedFormatted) lines.push(`<b>Total raised:</b> ${analysis.currencyRaisedFormatted}`)
    if (analysis.totalBids !== undefined) lines.push(`<b>Bids:</b> ${analysis.totalBids} total, ${analysis.uniqueBidders} unique bidders`)
    if (analysis.graduated !== undefined) lines.push(`<b>Status:</b> ${analysis.graduated ? '✅ Graduated' : '❌ Not graduated'}`)
    if (analysis.clearingVsFloor && analysis.clearingVsFloor !== '?') lines.push(`<b>Clearing vs floor:</b> ${analysis.clearingVsFloor}`)
    if (analysis.flags?.length) lines.push(`\n<b>⚠️ Flags:</b>\n${analysis.flags.map((f: string) => `  • ${f}`).join('\n')}`)
  }
  lines.push(``, `<a href="${detection.uniswap}">View on Uniswap</a> | <a href="${detection.explorer}">Explorer</a>`)
  return lines.join('\n')
}

// ─── Persistent data helpers ────────────────────────────────────────────────
function appendDetection(detection: Record<string, any>) {
  const file = 'data/live-detections.json'
  const existing = readJsonSafe<any[]>(file, [])
  existing.push(detection)
  writeJsonAtomic(file, existing)
}

function appendResult(result: Record<string, any>) {
  const file = 'data/results.json'
  const existing = readJsonSafe(file, { timestamp: '', summary: {} as any, auctions: [] as any[] })
  // Upsert by contractAddress to avoid duplicates (address is the true key)
  const idx = existing.auctions.findIndex((a: any) => a.contractAddress === result.contractAddress)
  if (idx >= 0) existing.auctions[idx] = result
  else existing.auctions.push(result)
  existing.timestamp = new Date().toISOString()
  existing.summary.total = existing.auctions.length
  writeJsonAtomic(file, existing)
  console.log(`  Saved to ${file} (${existing.auctions.length} auctions total)`)
}

// ─── Chunked getLogs with retry ──────────────────────────────────────────────
const LOG_CHUNK_SIZE = 5000n
const MAX_LOG_RANGE = 50000n

async function getLogsChunked(
  client: ReturnType<typeof getClient>,
  params: { address: `0x${string}`, event: any, fromBlock: bigint, toBlock: bigint },
  uncapped = false,
  chainName?: string,
) {
  const wasCapped = !uncapped && params.toBlock - params.fromBlock > MAX_LOG_RANGE
  const cappedTo = wasCapped
    ? params.fromBlock + MAX_LOG_RANGE
    : params.toBlock
  const totalRange = cappedTo - params.fromBlock

  const CHUNK_FLOOR = 9n
  const MAX_CHUNKS = 2000n
  let loggedRangeError = false

  const isRangeError = (msg: string) =>
    /block range|range.{0,5}too large|exceeds|limited to|max is/i.test(msg)

  const doScan = async (scanClient: ReturnType<typeof getClient>, initialChunkSize: bigint) => {
    const allLogs: any[] = []
    let from = params.fromBlock
    let chunkSize = initialChunkSize
    let retries = 0
    let chunks = 0

    while (from <= cappedTo) {
      const to = from + chunkSize < cappedTo ? from + chunkSize : cappedTo
      try {
        const logs = await scanClient.getLogs({
          address: params.address,
          event: params.event,
          fromBlock: from,
          toBlock: to,
        })
        allLogs.push(...logs)
        from = to + 1n
        retries = 0
        chunks++
        if (chunks % 100 === 0) {
          const pct = totalRange > 0n ? Number((from - params.fromBlock) * 100n / totalRange) : 100
          console.log(`  ...${pct}% scanned (${chunks} chunks, ${allLogs.length} events)`)
        }
      } catch (err: any) {
        const msg = err?.details || err?.message || ''

        // Rate limit — backoff and retry
        if (/too many|429/i.test(msg) && retries < 5) {
          retries++
          await new Promise(r => setTimeout(r, 1000 * retries))
          continue
        }

        // Block range error — halve chunk size and retry same segment
        if (isRangeError(msg)) {
          if (!loggedRangeError) {
            console.log(`  Block range error: ${msg}`)
            loggedRangeError = true
          }
          const newSize = chunkSize / 2n < CHUNK_FLOOR ? CHUNK_FLOOR : chunkSize / 2n
          if (newSize < chunkSize) {
            chunkSize = newSize
            if (totalRange / chunkSize > MAX_CHUNKS) throw err
            console.log(`  Adapting chunk size to ${chunkSize} blocks`)
            continue
          }
          throw err // at floor, can't reduce further
        }

        throw err
      }
    }
    return allLogs
  }

  // Try primary client
  try {
    const logs = await doScan(client, LOG_CHUNK_SIZE)
    if (wasCapped) console.log(`  (scanned first ${MAX_LOG_RANGE} of ${params.toBlock - params.fromBlock} blocks)`)
    return { logs, wasCapped }
  } catch (primaryErr: any) {
    const msg = primaryErr?.details || primaryErr?.message || ''
    if (!chainName || !isRangeError(msg)) throw primaryErr
  }

  // Fallback: public RPC with original chunk size
  console.log(`  Primary RPC failed, trying public RPC fallback...`)
  loggedRangeError = false
  const publicClient = getClient(chainName, true)
  const logs = await doScan(publicClient, LOG_CHUNK_SIZE)
  console.log(`  Scan completed via public RPC fallback`)
  if (wasCapped) console.log(`  (scanned first ${MAX_LOG_RANGE} of ${params.toBlock - params.fromBlock} blocks)`)
  return { logs, wasCapped }
}

// ─── HISTORICAL: Pull params + outcomes from a known auction ────────────────
async function analyzeAuction(auction: typeof KNOWN_AUCTIONS[0]) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Analyzing: ${auction.name}${auction.isTest ? ' [TEST]' : ''}`)
  console.log(`Notes: ${auction.notes}`)
  console.log('='.repeat(60))

  if (auction.contractAddress === '0x') {
    console.log('  Contract address not set yet — fill in KNOWN_AUCTIONS')
    return null
  }

  const client = getClient(auction.chain)
  const chainCfg = CHAINS[auction.chain]

  try {
    const address = auction.contractAddress

    const [currency, startBlock, endBlock, tickSpacing, validationHook,
           floorPrice, clearingPrice, graduated, currencyRaisedResult, totalClearedResult, tokenAddr] =
      await client.multicall({
        contracts: [
          { address, abi: AUCTION_ABI as any, functionName: 'currency' },
          { address, abi: AUCTION_ABI as any, functionName: 'startBlock' },
          { address, abi: AUCTION_ABI as any, functionName: 'endBlock' },
          { address, abi: AUCTION_ABI as any, functionName: 'tickSpacing' },
          { address, abi: AUCTION_ABI as any, functionName: 'validationHook' },
          { address, abi: AUCTION_ABI as any, functionName: 'floorPrice' },
          { address, abi: AUCTION_ABI as any, functionName: 'clearingPrice' },
          { address, abi: AUCTION_ABI as any, functionName: 'isGraduated' },
          { address, abi: AUCTION_ABI as any, functionName: 'currencyRaised' },
          { address, abi: AUCTION_ABI as any, functionName: 'totalCleared' },
          { address, abi: AUCTION_ABI as any, functionName: 'token' },
        ],
      })

    const ok = (r: any) => r.status === 'success' ? r.result : undefined
    const startBlockVal = ok(startBlock) as bigint | undefined
    const endBlockVal = ok(endBlock) as bigint | undefined
    const durationBlocks = (startBlockVal && endBlockVal) ? Number(endBlockVal - startBlockVal) : 0
    let durationHours = Math.round(durationBlocks * chainCfg.secsPerBlock / 3600)
    if (startBlockVal && endBlockVal) {
      try {
        const [startBl, endBl] = await Promise.all([
          client.getBlock({ blockNumber: startBlockVal }),
          client.getBlock({ blockNumber: endBlockVal }),
        ])
        durationHours = Math.round(Number(endBl.timestamp - startBl.timestamp) / 3600)
      } catch {}
    }

    const floorBig = ok(floorPrice) ? BigInt(ok(floorPrice)) : 0n
    const tickBig = ok(tickSpacing) ? BigInt(ok(tickSpacing)) : 0n
    const tickPct = floorBig > 0n ? (Number(tickBig * 1_000_000n / floorBig) / 10_000).toFixed(4) : '?'

    // Read token name/symbol
    const tokenAddress = ok(tokenAddr) as `0x${string}` | undefined
    let tokenName: string | undefined
    let tokenSymbol: string | undefined
    let tokenDecimals: number | undefined
    let tokenTotalSupply: bigint | undefined
    if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
      try {
        const [nameResult, symbolResult, decimalsResult, supplyResult] = await client.multicall({
          contracts: [
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'name' },
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'symbol' },
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'decimals' },
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'totalSupply' },
          ],
        })
        tokenName = ok(nameResult) as string | undefined
        tokenSymbol = ok(symbolResult) as string | undefined
        tokenDecimals = ok(decimalsResult) as number | undefined
        tokenTotalSupply = ok(supplyResult) as bigint | undefined
      } catch {}
    }

    // Read currency decimals for formatting totalRaised
    let currencyDecimals = 18 // default ETH
    let currencySymbol = 'ETH'
    const currencyAddr = ok(currency) as string | undefined
    if (currencyAddr && currencyAddr !== '0x0000000000000000000000000000000000000000') {
      try {
        const [cdResult, csResult] = await client.multicall({
          contracts: [
            { address: currencyAddr as `0x${string}`, abi: ERC20_ABI as any, functionName: 'decimals' },
            { address: currencyAddr as `0x${string}`, abi: ERC20_ABI as any, functionName: 'symbol' },
          ],
        })
        currencyDecimals = (ok(cdResult) as number) ?? 18
        currencySymbol = (ok(csResult) as string) ?? currencyAddr
      } catch {}
    }

    // Decode Q96 prices to human-readable (decimals-aware)
    const floorDecimal = q96ToPrice(ok(floorPrice)?.toString(), tokenDecimals ?? 18, currencyDecimals)
    const clearingDecimal = q96ToPrice(ok(clearingPrice)?.toString(), tokenDecimals ?? 18, currencyDecimals)
    let clearingVsFloor = '?'
    if (floorBig > 0n && ok(clearingPrice)) {
      const ratio = Number(BigInt(ok(clearingPrice)) * 10000n / floorBig) / 100
      clearingVsFloor = ratio > 99999 ? 'n/a (near-zero floor)' : `${ratio.toFixed(1)}%`
    }

    // Format currencyRaised as human-readable
    const currencyRaisedRaw = ok(currencyRaisedResult) as bigint | undefined
    const totalClearedRaw = ok(totalClearedResult) as bigint | undefined
    const formatCurrencyAmount = (raw: bigint | undefined) => {
      if (!raw) return undefined
      const divisor = 10n ** BigInt(currencyDecimals)
      const whole = raw / divisor
      const frac = raw % divisor
      const fracStr = frac.toString().padStart(currencyDecimals, '0').slice(0, 2)
      return `${whole.toLocaleString('en-US')}.${fracStr} ${currencySymbol}`
    }

    // Token supply formatted
    const tokenSupplyFormatted = (tokenTotalSupply && tokenDecimals !== undefined)
      ? Number(tokenTotalSupply / (10n ** BigInt(tokenDecimals))).toLocaleString('en-US')
      : undefined

    const result = {
      name: auction.name,
      chain: auction.chain,
      contractAddress: auction.contractAddress,
      isTest: auction.isTest,
      tokenAddress,
      tokenName,
      tokenSymbol,
      tokenSupply: tokenSupplyFormatted,
      startBlock: startBlockVal?.toString(),
      endBlock: endBlockVal?.toString(),
      floorPrice_Q96: ok(floorPrice)?.toString(),
      floorPrice: floorDecimal,
      tickSpacing_Q96: ok(tickSpacing)?.toString(),
      tickSpacingAsPctOfFloor: `${tickPct}%`,
      durationBlocks,
      durationHours,
      hasValidationHook: ok(validationHook) != null && ok(validationHook) !== '0x0000000000000000000000000000000000000000',
      currency: ok(currency) as string | undefined,
      currencySymbol,
      tokenDecimals: tokenDecimals ?? 18,
      currencyDecimals,
      graduated: ok(graduated) as boolean | undefined,
      finalClearingPrice_Q96: ok(clearingPrice)?.toString(),
      clearingPrice: clearingDecimal,
      clearingVsFloor,
      currencyRaised: currencyRaisedRaw?.toString(),
      currencyRaisedFormatted: formatCurrencyAmount(currencyRaisedRaw),
      totalCleared: totalClearedRaw?.toString(),
      flags: [] as string[],
    }

    // ── Risk flag logic ──────────────────────────────────────────────────
    if (parseFloat(tickPct) < 0.01) {
      result.flags.push('TICK_TOO_SMALL: tick spacing below 0.01% of floor')
    }
    if (durationHours < 4) {
      result.flags.push('DURATION_SHORT: auction under 4 hours')
    }
    if (durationHours > 168) {
      result.flags.push('DURATION_LONG: auction over 7 days')
    }
    if (!result.hasValidationHook) {
      result.flags.push('NO_HOOK: no validation hook')
    }
    if (result.graduated === false) {
      result.flags.push('DID_NOT_GRADUATE: auction failed to reach required raise')
    }

    const tokenLabel = tokenSymbol ? ` | Token: ${tokenSymbol} (${tokenName})` : ''
    console.log(JSON.stringify(result, null, 2))
    console.log(`Flags: ${result.flags.length === 0 ? 'None' : result.flags.join(', ')}${tokenLabel}`)

    // Count unique bidders
    const logFromBlock = startBlockVal || auction.startBlock
    const logToBlock = endBlockVal || (logFromBlock + 50000n)
    console.log(`Fetching bid events (blocks ${logFromBlock}–${logToBlock})...`)
    try {
      const { logs: bidLogs, wasCapped } = await getLogsChunked(client, {
        address: auction.contractAddress,
        event: parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint128 amount)'),
        fromBlock: logFromBlock,
        toBlock: logToBlock,
      }, true, auction.chain)

      const bidderAddresses = new Set(bidLogs.map(log => ((log.args as any).owner as string).toLowerCase()))
      const uniqueBidders = bidderAddresses.size
      const totalBids = bidLogs.length
      console.log(`Bid stats: ${totalBids} total bids, ${uniqueBidders} unique bidders`)
      return { ...result, uniqueBidders, totalBids, bidScanPartial: wasCapped, _bidderAddresses: [...bidderAddresses] }
    } catch (logErr: any) {
      const msg = logErr?.details || logErr?.message || ''
      console.log(`Skipping bid events — ${msg || 'unknown error'}`)
      return { ...result, bidScanPartial: true }
    }

  } catch (err) {
    console.error(`Error reading ${auction.name}:`, err)
    return null
  }
}

// ─── Graduated token price tracker ──────────────────────────────────────────
const TRACK_POST_GRADUATION = process.env.TRACK_POST_GRADUATION === 'true'

interface TrackedToken {
  address: string
  symbol: string
  name: string
  chain: string
  auctionName: string
  clearingPrice?: string
  lastPrice?: string
  lastPriceUsd?: string
  priceChange24h?: string
  volume24h?: string
  poolAddress?: string
  lastChecked?: string
  lastAlertAt?: string      // ISO — 24h cooldown
  lastAlertBand?: number    // last threshold band that triggered (-10, -20, -30)
}

const trackedTokens: TrackedToken[] = []
const PRICE_CHECK_INTERVAL = 10 * 60 * 1000 // check prices every 10 min
const PRICE_ALERT_BANDS = [-10, -20, -30] // threshold bands
const PRICE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24h cooldown per token

function loadTrackedTokens(): TrackedToken[] {
  return readJsonSafe<TrackedToken[]>('data/tracked-tokens.json', [])
}

function saveTrackedTokens() {
  writeJsonAtomic('data/tracked-tokens.json', trackedTokens)
}

async function fetchTokenPrice(address: string, chain: string): Promise<{ priceUsd: string, change24h: string, volume24h: string, poolAddress: string } | null> {
  const chainMap: Record<string, string> = { mainnet: 'ethereum', base: 'base', arbitrum: 'arbitrum' }
  const dexChain = chainMap[chain] || chain
  try {
    const resp = await fetch(`https://api.dexscreener.com/tokens/v1/${dexChain}/${address}`)
    const data = await resp.json() as any[]
    if (!data?.length) return null
    const pair = data[0]
    return {
      priceUsd: pair.priceUsd || '0',
      change24h: pair.priceChange?.h24?.toString() || '0',
      volume24h: pair.volume?.h24?.toString() || '0',
      poolAddress: pair.pairAddress || '',
    }
  } catch { return null }
}

function getPriceAlertBand(change: number): number | null {
  // Returns the most severe band crossed (e.g. -25% → -20 band)
  for (let i = PRICE_ALERT_BANDS.length - 1; i >= 0; i--) {
    if (change <= PRICE_ALERT_BANDS[i]) return PRICE_ALERT_BANDS[i]
  }
  return null
}

async function pollPrices() {
  if (!TRACK_POST_GRADUATION) return

  for (const token of trackedTokens) {
    const price = await fetchTokenPrice(token.address, token.chain)
    if (!price) continue

    const prevPrice = token.lastPriceUsd
    token.lastPriceUsd = price.priceUsd
    token.priceChange24h = price.change24h
    token.volume24h = price.volume24h
    token.poolAddress = price.poolAddress
    token.lastChecked = new Date().toISOString()

    if (!prevPrice) continue

    const change = parseFloat(price.change24h)
    const band = getPriceAlertBand(change)

    // Reset cooldown state when price recovers above all alert thresholds
    if (!band && token.lastAlertBand) {
      token.lastAlertBand = undefined
      token.lastAlertAt = undefined
    }
    if (!band) continue

    // Check cooldown: 24h unless a new (more severe) band is crossed
    const now = Date.now()
    const lastAlert = token.lastAlertAt ? new Date(token.lastAlertAt).getTime() : 0
    const withinCooldown = (now - lastAlert) < PRICE_ALERT_COOLDOWN_MS
    const newBand = band !== token.lastAlertBand && band < (token.lastAlertBand ?? 0)
    if (withinCooldown && !newBand) continue

    const direction = change > 0 ? '📈' : '📉'
    await routeAlert('price-alert', [
      `${direction} <b>${token.symbol} Price Alert</b>`,
      ``,
      `<b>Price:</b> $${parseFloat(price.priceUsd).toFixed(6)}`,
      `<b>24h change:</b> ${price.change24h}%`,
      `<b>24h volume:</b> $${parseFloat(price.volume24h).toLocaleString('en-US')}`,
    ].join('\n'))

    token.lastAlertAt = new Date().toISOString()
    token.lastAlertBand = band
  }
  saveTrackedTokens()
}

async function initTokenTracking() {
  if (!TRACK_POST_GRADUATION) return

  // Load saved tokens
  const saved = loadTrackedTokens()

  // Build from known graduated auctions
  const resultsFile = 'data/results.json'
  if (!fs.existsSync(resultsFile)) return

  const results = readJsonSafe(resultsFile, { auctions: [] as any[] })
  for (const auction of results.auctions || []) {
    if (!auction.graduated || auction.isTest || !auction.tokenAddress) continue

    // Check if already tracked
    if (saved.find(t => t.address.toLowerCase() === auction.tokenAddress.toLowerCase())) continue
    if (trackedTokens.find(t => t.address.toLowerCase() === auction.tokenAddress.toLowerCase())) continue

    // Check if token has a DEX pool
    const price = await fetchTokenPrice(auction.tokenAddress, auction.chain)
    if (price) {
      const token: TrackedToken = {
        address: auction.tokenAddress,
        symbol: auction.tokenSymbol || auction.name,
        name: auction.tokenName || auction.name,
        chain: auction.chain,
        auctionName: auction.name,
        clearingPrice: auction.clearingPrice,
        lastPriceUsd: price.priceUsd,
        priceChange24h: price.change24h,
        volume24h: price.volume24h,
        poolAddress: price.poolAddress,
        lastChecked: new Date().toISOString(),
      }
      trackedTokens.push(token)
      console.log(`  Tracking price: ${token.symbol} ($${price.priceUsd})`)
    }
  }

  // Merge saved tokens that aren't already in the list
  for (const s of saved) {
    if (!trackedTokens.find(t => t.address.toLowerCase() === s.address.toLowerCase())) {
      trackedTokens.push(s)
    }
  }

  saveTrackedTokens()
}

// ─── Daily market summary ───────────────────────────────────────────────────
const WATCH_STATE_FILE = 'data/watch-state.json'
const watchState: { lastDailySummary: string; lastHeartbeat: string; lastWeeklyDigest: string } =
  readJsonSafe(WATCH_STATE_FILE, {} as any)
let lastDailySummary = watchState.lastDailySummary || ''
let lastHeartbeat = watchState.lastHeartbeat || ''
const lastSuccessfulPoll: Record<string, string> = {}

function saveWatchState() {
  writeJsonAtomic(WATCH_STATE_FILE, { lastDailySummary, lastHeartbeat, lastWeeklyDigest })
}

async function sendDailySummary() {
  const now = new Date()
  const dateKey = now.toISOString().slice(0, 10) // YYYY-MM-DD
  if (dateKey === lastDailySummary) return

  // Send at 9:00 UTC
  if (now.getUTCHours() !== 9) return
  lastDailySummary = dateKey

  const lines = [
    `📋 <b>CCA Daily Summary</b> — ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
    ``,
  ]

  // Active auctions section
  if (trackedAuctions.length > 0) {
    lines.push(`<b>🔴 Active Auctions:</b>`)
    for (const a of trackedAuctions) {
      const divisor = 10n ** BigInt(a.currencyDecimals)
      const whole = a.currencyRaised / divisor
      const frac = (a.currencyRaised % divisor).toString().padStart(a.currencyDecimals, '0').slice(0, 2)
      const raised = `${whole.toLocaleString('en-US')}.${frac} ${a.currencySymbol}`
      const blocksLeft = Number(a.endBlock - a.lastScannedBlock)
      const hoursLeft = Math.max(0, Math.round(blocksLeft * CHAINS[a.chain].secsPerBlock / 3600))
      lines.push(`  • <b>${a.tokenSymbol || a.address.slice(0,10)}</b> (${a.chain}): ${a.totalBids} bids, ${raised} raised, ~${hoursLeft}h left`)
    }
    lines.push(``)
  } else {
    lines.push(`<b>No active auctions</b> — monitoring 4 chains for new deployments.`)
    lines.push(``)
  }

  // Graduated token prices (only when feature is enabled)
  if (TRACK_POST_GRADUATION && trackedTokens.length > 0) {
    lines.push(`<b>📊 Graduated Token Prices:</b>`)
    for (const t of trackedTokens) {
      if (!t.lastPriceUsd || t.lastPriceUsd === '0') continue
      const change = parseFloat(t.priceChange24h || '0')
      const arrow = change > 0 ? '🟢' : change < 0 ? '🔴' : '⚪'
      const vol = parseFloat(t.volume24h || '0')
      lines.push(`  ${arrow} <b>${t.symbol}</b>: $${parseFloat(t.lastPriceUsd).toFixed(6)} (${change > 0 ? '+' : ''}${change.toFixed(1)}%) | Vol: $${vol.toLocaleString('en-US')}`)
    }
    lines.push(``)
  }

  // Stats (filter isTest from public-facing counts)
  const resultsFile = 'data/results.json'
  if (fs.existsSync(resultsFile)) {
    const results = readJsonSafe(resultsFile, { auctions: [] as any[] })
    const real = results.auctions?.filter((a: any) => !a.isTest) || []
    const graduated = real.filter((a: any) => a.graduated).length
    lines.push(`<b>📈 All-time:</b> ${real.length} auctions tracked, ${graduated} graduated`)
  }

  lines.push(``, `<i>Get instant alerts: @cca_monitor_bot → /subscribe</i>`)

  await routeAlert('daily-summary', lines.join('\n'))
  saveWatchState()
  console.log(`Daily summary sent (${dateKey})`)
}

// ─── Auction detection dates (for go/no-go trigger) ─────────────────────────
const DETECTION_DATES_FILE = 'data/detection-dates.json'

interface DetectionDates { [nameOrAddress: string]: string } // ISO date or 'unknown'

function loadDetectionDates(): DetectionDates {
  return readJsonSafe<DetectionDates>(DETECTION_DATES_FILE, {})
}

function saveDetectionDates(d: DetectionDates) {
  writeJsonAtomic(DETECTION_DATES_FILE, d)
}

async function backfillDetectionDates() {
  const dates = loadDetectionDates()
  let changed = false
  for (const a of KNOWN_AUCTIONS) {
    if (a.isTest) continue
    const key = a.name
    if (dates[key] && dates[key] !== 'unknown') continue
    // Fetch startBlock timestamp from chain (exact, replaces notes parsing)
    try {
      const client = getClient(a.chain)
      let startBlockNum: bigint
      if (a.startBlock && a.startBlock > 0n) {
        startBlockNum = a.startBlock
      } else {
        const [sbResult] = await client.multicall({
          contracts: [{ address: a.contractAddress, abi: AUCTION_ABI as any, functionName: 'startBlock' }],
        })
        startBlockNum = sbResult.status === 'success' ? (sbResult.result as bigint) : 0n
      }
      if (startBlockNum > 0n) {
        const block = await client.getBlock({ blockNumber: startBlockNum })
        dates[key] = new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 10)
        changed = true
      }
    } catch {
      // Leave as-is if RPC fails; will retry next heartbeat
    }
  }
  if (changed) saveDetectionDates(dates)
  return dates
}

function recordDetection(nameOrAddress: string) {
  const dates = loadDetectionDates()
  if (!dates[nameOrAddress]) {
    dates[nameOrAddress] = new Date().toISOString().slice(0, 10)
    saveDetectionDates(dates)
  }
}

// ─── Watchdog heartbeat (DM only) ───────────────────────────────────────────
async function sendHeartbeat() {
  const now = new Date()
  const dateKey = now.toISOString().slice(0, 10)
  if (dateKey === lastHeartbeat) return
  if (now.getUTCHours() !== 9) return
  lastHeartbeat = dateKey

  const dmId = TELEGRAM_TARGETS.dm
  if (!dmId) return

  let totalAuctions = 0, realGraduated = 0, testGraduated = 0
  {
    const data = readJsonSafe('data/results.json', { auctions: [] as any[] })
    totalAuctions = data.auctions?.length || 0
    const real = (data.auctions || []).filter((a: any) => !a.isTest)
    const test = (data.auctions || []).filter((a: any) => a.isTest)
    realGraduated = real.filter((a: any) => a.graduated).length
    testGraduated = test.filter((a: any) => a.graduated).length
  }

  const chainNames = ['mainnet', 'base', 'arbitrum', 'unichain']
  const lines: string[] = []
  let hasWarning = false
  const oneHourAgo = Date.now() - 60 * 60 * 1000

  for (const chain of chainNames) {
    const lastPoll = lastSuccessfulPoll[chain]
    if (!lastPoll) {
      hasWarning = true
      lines.push(`  ⚠️ ${chain}: never polled`)
    } else {
      const stale = new Date(lastPoll).getTime() < oneHourAgo
      if (stale) hasWarning = true
      lines.push(`  ${stale ? '⚠️' : '✅'} ${chain}: ${new Date(lastPoll).toISOString().slice(11, 19)} UTC`)
    }
  }

  // Subscriber counts by tier
  let subLines: string[] = []
  {
    const subs = readJsonSafe<Array<{ tier?: string; expiresAt: string }>>('data/subscribers.json', [])
    const now = new Date()
    const active = subs.filter(s => s.tier === 'lifetime' || new Date(s.expiresAt) >= now)
    const byTier: Record<string, number> = {}
    for (const s of active) byTier[s.tier || 'legacy'] = (byTier[s.tier || 'legacy'] || 0) + 1
    const parts = Object.entries(byTier).map(([t, n]) => `${t}: ${n}`)
    subLines = active.length > 0 ? [`<b>Subscribers:</b> ${active.length} (${parts.join(', ')})`] : [`<b>Subscribers:</b> 0`]
  }

  // Public channel member count
  let publicMembers = ''
  const publicId = TELEGRAM_TARGETS.public
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (publicId && botToken) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: publicId }),
      })
      const data = await resp.json() as any
      if (data.ok) publicMembers = ` | Public channel: ${data.result}`
    } catch {}
  }

  // Go/no-go trigger: trailing 30d real auction velocity
  const detDates = await backfillDetectionDates()
  const realDetections = Object.entries(detDates).filter(([, d]) => d !== 'unknown')
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const trailing30d = realDetections.filter(([, d]) => d >= thirtyDaysAgo).length
  const totalReal = KNOWN_AUCTIONS.filter(a => !a.isTest).length

  const triggerLine = trailing30d >= 3
    ? `🚦 <b>TRIGGER MET:</b> CCA velocity at ${trailing30d}/month — start audit outreach.\n`
    : ''

  const header = hasWarning ? '⚠️ <b>WATCHDOG HEARTBEAT</b>' : '💚 <b>WATCHDOG HEARTBEAT</b>'
  const msg = [
    triggerLine + header,
    ``,
    `<b>Last successful poll:</b>`,
    ...lines,
    ``,
    `<b>Active auctions:</b> ${trackedAuctions.length}`,
    `<b>Total in dataset:</b> ${totalAuctions}`,
    `<b>Real auctions (all time):</b> ${totalReal}`,
    `<b>Graduated:</b> ${realGraduated} real, ${testGraduated} test`,
    `<b>Real auctions (trailing 30d):</b> ${trailing30d}`,
    ...subLines,
    publicMembers ? `<b>Public channel members:</b> ${publicMembers.split(': ')[1]}` : '',
  ].filter(Boolean).join('\n')

  await routeAlert('heartbeat', msg)
  saveWatchState()
  console.log(`Heartbeat sent (${dateKey})`)
}

// ─── Weekly digest (Monday 9 UTC) ────────────────────────────────────────────
let lastWeeklyDigest = watchState.lastWeeklyDigest || ''

async function sendWeeklyDigest() {
  const now = new Date()
  if (now.getUTCDay() !== 1) return // Monday only
  if (now.getUTCHours() !== 9) return
  const weekKey = now.toISOString().slice(0, 10)
  if (weekKey === lastWeeklyDigest) return
  lastWeeklyDigest = weekKey

  const dmId = TELEGRAM_TARGETS.dm
  if (!dmId) return

  // Dataset stats
  let totalAuctions = 0, realAuctions = 0
  {
    const data = readJsonSafe('data/results.json', { auctions: [] as any[] })
    totalAuctions = data.auctions?.length || 0
    realAuctions = data.auctions?.filter((a: any) => !a.isTest).length || 0
  }

  // Subscribers by tier
  let subLine = '0'
  {
    const subs = readJsonSafe<Array<{ tier?: string; expiresAt: string }>>('data/subscribers.json', [])
    const active = subs.filter(s => s.tier === 'lifetime' || new Date(s.expiresAt) >= now)
    if (active.length > 0) {
      const byTier: Record<string, number> = {}
      for (const s of active) byTier[s.tier || 'legacy'] = (byTier[s.tier || 'legacy'] || 0) + 1
      subLine = `${active.length} (${Object.entries(byTier).map(([t, n]) => `${t}: ${n}`).join(', ')})`
    }
  }

  // Public channel members
  let publicMembers = 'n/a'
  const publicId = TELEGRAM_TARGETS.public
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (publicId && botToken) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/getChatMemberCount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: publicId }),
      })
      const data = await resp.json() as any
      if (data.ok) publicMembers = String(data.result)
    } catch {}
  }

  // Real auctions this week
  const detDates = await backfillDetectionDates()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const realDetections = Object.entries(detDates).filter(([, d]) => d !== 'unknown')
  const thisWeek = realDetections.filter(([, d]) => d >= sevenDaysAgo).length

  // Days since last real auction
  const sortedDates = realDetections.map(([, d]) => d).sort().reverse()
  const daysSinceLast = sortedDates.length > 0
    ? Math.floor((Date.now() - new Date(sortedDates[0]).getTime()) / 86400000)
    : -1

  // Intent radar matches this week
  let intentMatches = 0
  {
    const seen = readJsonSafe<string[]>('data/intent-seen.json', [])
    intentMatches = seen.length
  }

  // Data files size
  let dataSize = '?'
  try {
    const files = fs.readdirSync('data').filter(f => f.endsWith('.json'))
    const totalBytes = files.reduce((s, f) => s + fs.statSync(`data/${f}`).size, 0)
    dataSize = `${files.length} files, ${(totalBytes / 1024).toFixed(0)} KB`
  } catch {}

  const msg = [
    `📊 <b>WEEKLY DIGEST</b> — ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    ``,
    `<b>Real auctions:</b> ${thisWeek} this week / ${realAuctions} total`,
    `<b>Days since last real auction:</b> ${daysSinceLast >= 0 ? daysSinceLast : 'n/a'}`,
    `<b>Dataset:</b> ${totalAuctions} auctions (${dataSize})`,
    `<b>Subscribers:</b> ${subLine}`,
    `<b>Public channel:</b> ${publicMembers} members`,
    `<b>Intent radar:</b> ${intentMatches} total items tracked`,
  ].join('\n')

  await routeAlert('weekly-digest', msg)
  saveWatchState()
  console.log(`Weekly digest sent (${weekKey})`)
}

// ─── Weekly "State of CCA" public channel post (Wednesday 15 UTC) ────────────
let lastStateCCA = ''

const DID_YOU_KNOW_POOL = [
  (real: any[]) => {
    const best = real.filter(a => a.clearingVsFloor && !String(a.clearingVsFloor).includes('e+')).sort((a, b) => parseFloat(b.clearingVsFloor) - parseFloat(a.clearingVsFloor))[0]
    return best ? `Highest clearing ratio: ${best.name} at ${best.clearingVsFloor} of floor` : null
  },
  (_real: any[], allAuctions: any[]) => {
    const tests = allAuctions.filter((a: any) => a.isTest).length
    const total = allAuctions.length
    return total > 0 ? `${Math.round(tests / total * 100)}% of all CCA deployments were test auctions` : null
  },
  () => {
    const idx = readJsonSafe<any[]>('data/bidder-index.json', [])
    if (idx.length === 0) return null
    const repeat = idx.filter((e: any) => e.auctionCount >= 2).length
    return `${repeat} addresses have bid in 2+ CCA auctions — the early repeat-bidder cohort`
  },
  (real: any[]) => {
    const totalBids = real.reduce((s: number, a: any) => s + (a.totalBids || 0), 0)
    return `${totalBids.toLocaleString('en-US')} total bids placed across all real CCA auctions`
  },
  (real: any[]) => {
    const totalBidders = real.reduce((s: number, a: any) => s + (a.uniqueBidders || 0), 0)
    return `${totalBidders.toLocaleString('en-US')} unique addresses have participated in CCA auctions`
  },
]

async function sendStateCCA(dryRun = false) {
  const now = new Date()
  if (now.getUTCDay() !== 3) return // Wednesday only
  if (now.getUTCHours() !== 15) return
  const weekKey = now.toISOString().slice(0, 10)
  if (weekKey === lastStateCCA) return

  // Skip if there are active auctions (daily summary already covers it)
  if (trackedAuctions.length > 0) return

  lastStateCCA = weekKey

  const publicId = TELEGRAM_TARGETS.public
  if (!publicId && !dryRun) return

  // Load data
  const data = readJsonSafe('data/results.json', { auctions: [] as any[] })
  const allAuctions = data.auctions || []
  const real = allAuctions.filter((a: any) => !a.isTest)

  // Days since last real auction
  const detDates = await backfillDetectionDates()
  const sortedDates = Object.entries(detDates).filter(([, d]) => d !== 'unknown').map(([, d]) => d).sort().reverse()
  const daysSinceLast = sortedDates.length > 0
    ? Math.floor((Date.now() - new Date(sortedDates[0]).getTime()) / 86400000)
    : -1

  // Total raised (ETH equivalent — rough)
  const totalBidders = real.reduce((s: number, a: any) => s + (a.uniqueBidders || 0), 0)

  // Rotating "did you know"
  const weekNum = Math.floor(Date.now() / (7 * 86400000))
  const factFn = DID_YOU_KNOW_POOL[weekNum % DID_YOU_KNOW_POOL.length]
  const fact = factFn(real, allAuctions)

  const lines = [
    `📊 <b>State of CCA</b>`,
    ``,
    `Real auctions: <b>${real.length}</b>`,
    `Total dataset: <b>${allAuctions.length}</b> auctions (${real.length} real + ${allAuctions.length - real.length} test)`,
    `Unique bidders (all-time): <b>${totalBidders.toLocaleString('en-US')}</b>`,
    daysSinceLast >= 0 ? `Days since last real auction: <b>${daysSinceLast}</b>` : '',
    ``,
    fact ? `💡 <i>${fact}</i>` : '',
    ``,
    `🤖 Instant alerts: @cca_monitor_bot`,
    `📂 github.com/monkrus/cca-monitor`,
  ].filter(Boolean).join('\n')

  if (dryRun) {
    console.log(`[DRY RUN] State of CCA post:\n${lines}`)
    return
  }

  await routeAlert('state-of-cca', lines)
  console.log(`State of CCA post sent (${weekKey})`)
}

// ─── Milestone posts ─────────────────────────────────────────────────────────
const MILESTONES_FILE = 'data/posted-milestones.json'

function loadMilestones(): string[] {
  return readJsonSafe<string[]>(MILESTONES_FILE, [])
}

function saveMilestones(m: string[]) {
  writeJsonAtomic(MILESTONES_FILE, m)
}

async function checkMilestones(dryRun = false) {
  const publicId = TELEGRAM_TARGETS.public
  if (!publicId && !dryRun) return

  const posted = loadMilestones()
  const newMilestones: string[] = []

  // Real auction count milestones (every 5)
  const data = readJsonSafe('data/results.json', { auctions: [] as any[] })
  const realCount = (data.auctions || []).filter((a: any) => !a.isTest).length
  const auctionMilestone = Math.floor(realCount / 5) * 5
  if (auctionMilestone >= 5) {
    const key = `auctions-${auctionMilestone}`
    if (!posted.includes(key)) {
      const text = `🎯 <b>Milestone:</b> ${auctionMilestone} real CCA auctions tracked!\n\n📂 github.com/monkrus/cca-monitor`
      if (dryRun) console.log(`[DRY RUN] Milestone: ${key}\n${text}`)
      else await routeAlert('milestone', text)
      newMilestones.push(key)
    }
  }

  // Bidder index milestones (every 5000)
  {
    const idx = readJsonSafe<any[]>('data/bidder-index.json', [])
    const bidderMilestone = Math.floor(idx.length / 5000) * 5000
    if (bidderMilestone >= 5000) {
      const key = `bidders-${bidderMilestone}`
      if (!posted.includes(key)) {
        const text = `🎯 <b>Milestone:</b> ${bidderMilestone.toLocaleString('en-US')} unique addresses in the CCA bidder index!\n\n📂 github.com/monkrus/cca-monitor`
        if (dryRun) console.log(`[DRY RUN] Milestone: ${key}\n${text}`)
        else await routeAlert('milestone', text)
        newMilestones.push(key)
      }
    }
  }

  if (newMilestones.length > 0) {
    if (!dryRun) {
      const all = [...posted, ...newMilestones]
      saveMilestones(all)
    }
    console.log(`${dryRun ? '[DRY RUN] ' : ''}Posted ${newMilestones.length} milestone(s): ${newMilestones.join(', ')}`)
  }
}

// ─── Whale bid alert helper ─────────────────────────────────────────────────
const WHALE_THRESHOLD_ETH = 10n * 10n ** 18n       // 10 ETH
const WHALE_THRESHOLD_USDC = 25000n * 10n ** 6n     // 25,000 USDC

function isWhaleBid(amount: bigint, currencySymbol: string): boolean {
  if (currencySymbol === 'USDC' || currencySymbol === 'USDT') return amount >= WHALE_THRESHOLD_USDC
  return amount >= WHALE_THRESHOLD_ETH
}

// ─── Bid tracker for active auctions ────────────────────────────────────────
interface TrackedAuction {
  address: `0x${string}`
  chain: string
  token: string
  tokenSymbol?: string
  tokenName?: string
  currencySymbol: string
  currencyDecimals: number
  tokenDecimals: number
  startBlock: bigint
  endBlock: bigint
  lastScannedBlock: bigint
  totalBids: number
  uniqueBidders: Set<string>
  currencyRaised: bigint
  lastAlertBids: number  // bid count at last Telegram update
  graduated: boolean
  floorPriceQ96: bigint
  clearingPriceQ96: bigint
}

const trackedAuctions: TrackedAuction[] = []
const BID_ALERT_INTERVAL = 50 // send update every N new bids
const BID_POLL_INTERVAL = 60_000 // check bids every 60s

async function initTrackedAuction(address: `0x${string}`, chain: string, tokenAddr: string): Promise<TrackedAuction | null> {
  try {
    const client = getClient(chain)
    const [startBlock, endBlock, currencyResult, graduatedResult, tokenResult, raisedResult, floorResult, clearingResult] = await client.multicall({
      contracts: [
        { address, abi: AUCTION_ABI as any, functionName: 'startBlock' },
        { address, abi: AUCTION_ABI as any, functionName: 'endBlock' },
        { address, abi: AUCTION_ABI as any, functionName: 'currency' },
        { address, abi: AUCTION_ABI as any, functionName: 'isGraduated' },
        { address, abi: AUCTION_ABI as any, functionName: 'token' },
        { address, abi: AUCTION_ABI as any, functionName: 'currencyRaised' },
        { address, abi: AUCTION_ABI as any, functionName: 'floorPrice' },
        { address, abi: AUCTION_ABI as any, functionName: 'clearingPrice' },
      ],
    })
    const ok = (r: any) => r.status === 'success' ? r.result : undefined
    const startBlockVal = ok(startBlock) as bigint | undefined
    const endBlockVal = ok(endBlock) as bigint | undefined
    if (!startBlockVal || !endBlockVal) return null

    let currencyDecimals = 18
    let currencySymbol = 'ETH'
    const currAddr = ok(currencyResult) as string | undefined
    if (currAddr && currAddr !== '0x0000000000000000000000000000000000000000') {
      try {
        const [cd, cs] = await client.multicall({
          contracts: [
            { address: currAddr as `0x${string}`, abi: ERC20_ABI as any, functionName: 'decimals' },
            { address: currAddr as `0x${string}`, abi: ERC20_ABI as any, functionName: 'symbol' },
          ],
        })
        currencyDecimals = (ok(cd) as number) ?? 18
        currencySymbol = (ok(cs) as string) ?? 'TOKEN'
      } catch {}
    }

    let tokenSymbol: string | undefined
    let tokenName: string | undefined
    let tokenDecimals = 18
    const tAddr = (ok(tokenResult) || tokenAddr) as `0x${string}`
    if (tAddr && tAddr !== '0x0000000000000000000000000000000000000000') {
      try {
        const [ns, nn, nd] = await client.multicall({
          contracts: [
            { address: tAddr, abi: ERC20_ABI as any, functionName: 'symbol' },
            { address: tAddr, abi: ERC20_ABI as any, functionName: 'name' },
            { address: tAddr, abi: ERC20_ABI as any, functionName: 'decimals' },
          ],
        })
        tokenSymbol = ok(ns) as string | undefined
        tokenName = ok(nn) as string | undefined
        tokenDecimals = (ok(nd) as number) ?? 18
      } catch {}
    }

    return {
      address,
      chain,
      token: tokenAddr,
      tokenSymbol,
      tokenName,
      currencySymbol,
      currencyDecimals,
      tokenDecimals,
      startBlock: startBlockVal,
      endBlock: endBlockVal,
      lastScannedBlock: startBlockVal,
      totalBids: 0,
      uniqueBidders: new Set(),
      currencyRaised: (ok(raisedResult) as bigint) ?? 0n,
      lastAlertBids: 0,
      graduated: (ok(graduatedResult) as boolean) ?? false,
      floorPriceQ96: (ok(floorResult) as bigint) ?? 0n,
      clearingPriceQ96: (ok(clearingResult) as bigint) ?? 0n,
    }
  } catch {
    return null
  }
}

function formatBidUpdate(auction: TrackedAuction): string {
  const divisor = 10n ** BigInt(auction.currencyDecimals)
  const whole = auction.currencyRaised / divisor
  const frac = (auction.currencyRaised % divisor).toString().padStart(auction.currencyDecimals, '0').slice(0, 2)
  const raised = `${whole.toLocaleString('en-US')}.${frac} ${auction.currencySymbol}`
  const label = auction.tokenSymbol || auction.address.slice(0, 10)
  const chainLabel = auction.chain.toUpperCase()
  const blocksLeft = Number(auction.endBlock - auction.lastScannedBlock)
  const secsLeft = blocksLeft * CHAINS[auction.chain].secsPerBlock
  const hoursLeft = Math.max(0, Math.round(secsLeft / 3600))

  const lines = [
    `📊 <b>${label} Auction Update</b> (${chainLabel})`,
    ``,
    `<b>Total bids:</b> ${auction.totalBids}`,
    `<b>Unique bidders:</b> ${auction.uniqueBidders.size}`,
    `<b>Currency raised:</b> ${raised}`,
    `<b>Time remaining:</b> ~${hoursLeft}h`,
  ]
  if (auction.graduated) lines.push(`<b>Status:</b> ✅ Graduated`)
  lines.push(``, `<a href="https://app.uniswap.org/explore/auctions/${auction.chain === 'mainnet' ? 'ethereum' : auction.chain}/${auction.address}">View on Uniswap</a>`)
  return lines.join('\n')
}

// ─── Auction-end intel alerts ────────────────────────────────────────────────
const END_ALERTS_FILE = 'data/end-alerts-sent.json'
const END_ALERT_PUBLIC_DELAY_MS = 6 * 60 * 60 * 1000 // 6-hour delay for public teaser

interface EndAlertsSent {
  [auctionAddress: string]: { h24?: boolean; h1?: boolean }
}

function loadEndAlerts(): EndAlertsSent {
  return readJsonSafe<EndAlertsSent>(END_ALERTS_FILE, {})
}

function saveEndAlerts(data: EndAlertsSent) {
  writeJsonAtomic(END_ALERTS_FILE, data)
}

function buildEndIntel(auction: TrackedAuction, hoursLeft: number, includeRatio: boolean): string {
  const label = auction.tokenSymbol || auction.address.slice(0, 10)
  const chainLabel = auction.chain.toUpperCase()

  // Currency raised
  const divisor = 10n ** BigInt(auction.currencyDecimals)
  const whole = auction.currencyRaised / divisor
  const frac = (auction.currencyRaised % divisor).toString().padStart(auction.currencyDecimals, '0').slice(0, 2)
  const raised = `${whole.toLocaleString('en-US')}.${frac} ${auction.currencySymbol}`

  // Clearing vs floor
  const cvf = auction.floorPriceQ96 > 0n && auction.clearingPriceQ96 > 0n
    ? `${(Number(auction.clearingPriceQ96 * 10000n / auction.floorPriceQ96) / 100).toFixed(1)}%`
    : '?'

  const emoji = hoursLeft <= 1 ? '🔴' : '🟡'
  const timeStr = hoursLeft <= 1 ? '< 1 hour' : `~${hoursLeft}h`

  const lines = [
    `${emoji} <b>${label} Auction Closing</b> (${chainLabel})`,
    ``,
    `<b>Time remaining:</b> ${timeStr}`,
    `<b>Total bids:</b> ${auction.totalBids.toLocaleString('en-US')}`,
    `<b>Unique bidders:</b> ${auction.uniqueBidders.size.toLocaleString('en-US')}`,
    `<b>Currency raised:</b> ${raised}`,
  ]

  if (includeRatio) {
    lines.push(`<b>Clearing vs floor:</b> ${cvf}`)
  }

  lines.push(``, `<a href="https://app.uniswap.org/explore/auctions/${auction.chain === 'mainnet' ? 'ethereum' : auction.chain}/${auction.address}">View on Uniswap</a>`)
  return lines.join('\n')
}

async function checkEndAlerts() {
  const sent = loadEndAlerts()
  let changed = false

  for (const auction of trackedAuctions) {
    const key = auction.address.toLowerCase()
    if (!sent[key]) sent[key] = {}

    const blocksLeft = Number(auction.endBlock - auction.lastScannedBlock)
    const secsLeft = blocksLeft * CHAINS[auction.chain].secsPerBlock
    const hoursLeft = secsLeft / 3600

    // Refresh clearing price for intel
    try {
      const client = getClient(auction.chain)
      const [cpResult, raisedResult] = await client.multicall({
        contracts: [
          { address: auction.address, abi: AUCTION_ABI as any, functionName: 'clearingPrice' },
          { address: auction.address, abi: AUCTION_ABI as any, functionName: 'currencyRaised' },
        ],
      })
      const ok = (r: any) => r.status === 'success' ? r.result : undefined
      auction.clearingPriceQ96 = (ok(cpResult) as bigint) ?? auction.clearingPriceQ96
      auction.currencyRaised = (ok(raisedResult) as bigint) ?? auction.currencyRaised
    } catch {}

    // 24h alert — premium instant, public teaser delayed 6h
    if (hoursLeft <= 24 && hoursLeft > 1 && !sent[key].h24) {
      const premiumText = buildEndIntel(auction, Math.round(hoursLeft), true)
      await routeAlert('end-intel', premiumText)

      // Public: teaser without clearing ratio, delayed 6h
      const publicId = TELEGRAM_TARGETS.public
      if (publicId) {
        const teaser = buildEndIntel(auction, Math.round(hoursLeft), false)
        const alerts = loadPendingAlerts()
        alerts.push({
          sendAt: new Date(Date.now() + END_ALERT_PUBLIC_DELAY_MS).toISOString(),
          text: teaser,
          queuedAt: new Date().toISOString(),
        })
        savePendingAlerts(alerts)
      }

      sent[key].h24 = true
      changed = true
      console.log(`  End intel (24h) sent for ${auction.tokenSymbol || key}`)
    }

    // 1h alert — premium only
    if (hoursLeft <= 1 && hoursLeft > 0 && !sent[key].h1) {
      const premiumText = buildEndIntel(auction, 1, true)
      await routeAlert('end-intel', premiumText)

      sent[key].h1 = true
      changed = true
      console.log(`  End intel (1h) sent for ${auction.tokenSymbol || key}`)
    }
  }

  if (changed) saveEndAlerts(sent)
}

async function pollBids() {
  for (const auction of trackedAuctions) {
    try {
      const client = getClient(auction.chain)
      const currentBlock = await client.getBlockNumber()

      // Check if auction has ended
      if (currentBlock > auction.endBlock) {
        // Final update
        const [raisedResult, gradResult] = await client.multicall({
          contracts: [
            { address: auction.address, abi: AUCTION_ABI as any, functionName: 'currencyRaised' },
            { address: auction.address, abi: AUCTION_ABI as any, functionName: 'isGraduated' },
          ],
        })
        const ok = (r: any) => r.status === 'success' ? r.result : undefined
        auction.currencyRaised = (ok(raisedResult) as bigint) ?? auction.currencyRaised
        auction.graduated = (ok(gradResult) as boolean) ?? false

        const status = auction.graduated ? '✅ GRADUATED' : '❌ DID NOT GRADUATE'
        const divisor = 10n ** BigInt(auction.currencyDecimals)
        const whole = auction.currencyRaised / divisor
        const frac = (auction.currencyRaised % divisor).toString().padStart(auction.currencyDecimals, '0').slice(0, 2)
        const raised = `${whole.toLocaleString('en-US')}.${frac} ${auction.currencySymbol}`

        const label = auction.tokenSymbol || auction.address.slice(0, 10)
        await routeAlert('auction-end', [
          `🏁 <b>${label} Auction ENDED</b>`,
          ``,
          `<b>Result:</b> ${status}`,
          `<b>Final raised:</b> ${raised}`,
          `<b>Total bids:</b> ${auction.totalBids}`,
          `<b>Unique bidders:</b> ${auction.uniqueBidders.size}`,
        ].join('\n'))
        console.log(`  ${label} auction ended: ${status}`)

        // Remove from tracking
        const idx = trackedAuctions.indexOf(auction)
        if (idx >= 0) trackedAuctions.splice(idx, 1)
        continue
      }

      // Scan new bid events
      const scanTo = currentBlock < auction.endBlock ? currentBlock : auction.endBlock
      if (scanTo <= auction.lastScannedBlock) continue

      const bidLogs = await client.getLogs({
        address: auction.address,
        event: parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint128 amount)'),
        fromBlock: auction.lastScannedBlock + 1n,
        toBlock: scanTo,
      })

      for (const log of bidLogs) {
        const { owner, amount } = log.args as any
        auction.uniqueBidders.add((owner as string).toLowerCase())
        auction.totalBids++

        // Whale bid alert
        if (amount && isWhaleBid(BigInt(amount), auction.currencySymbol)) {
          const divisor = 10n ** BigInt(auction.currencyDecimals)
          const whole = BigInt(amount) / divisor
          const frac = (BigInt(amount) % divisor).toString().padStart(auction.currencyDecimals, '0').slice(0, 2)
          const amtStr = `${whole.toLocaleString('en-US')}.${frac} ${auction.currencySymbol}`
          const label = auction.tokenSymbol || auction.address.slice(0, 10)
          await routeAlert('whale-bid', [
            `🐋 <b>Whale Bid — ${label}</b>`,
            ``,
            `<b>Amount:</b> ${amtStr}`,
            `<b>Bidder:</b> <code>${owner}</code>`,
            `<b>Total bids:</b> ${auction.totalBids}`,
            `<b>Bidders:</b> ${auction.uniqueBidders.size}`,
          ].join('\n'))
          console.log(`  Whale bid: ${amtStr} from ${owner}`)
        }
      }
      auction.lastScannedBlock = scanTo

      // Update raised amount
      try {
        const [raisedResult] = await client.multicall({
          contracts: [{ address: auction.address, abi: AUCTION_ABI as any, functionName: 'currencyRaised' }],
        })
        const ok = (r: any) => r.status === 'success' ? r.result : undefined
        auction.currencyRaised = (ok(raisedResult) as bigint) ?? auction.currencyRaised
      } catch {}

      // Send Telegram update every N new bids
      const newBidsSinceAlert = auction.totalBids - auction.lastAlertBids
      if (newBidsSinceAlert >= BID_ALERT_INTERVAL) {
        await routeAlert('bid-update', formatBidUpdate(auction))
        auction.lastAlertBids = auction.totalBids
        console.log(`  Bid update sent for ${auction.tokenSymbol || auction.address}: ${auction.totalBids} bids, ${auction.uniqueBidders.size} bidders`)
      }
    } catch (err: any) {
      console.error(`  Bid poll error (${auction.tokenSymbol || auction.address}): ${err.message}`)
    }
  }
}

// ─── LIVE MONITOR: Poll for new auctions across all chains (no filters) ─────
async function watchForNewAuctions() {
  await checkCrashLoop('cca-watch')
  console.log('\nStarting new auction monitor...')
  console.log('Watching factory on: Ethereum, Base, Arbitrum, Unichain')
  console.log('Factory address:', FACTORY_ADDRESS)
  if (process.env.WEBHOOK_URL) console.log('Webhook: enabled')
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const channels = []
    if (TELEGRAM_TARGETS.dm) channels.push('DM')
    if (TELEGRAM_TARGETS.premium) channels.push('Premium')
    if (TELEGRAM_TARGETS.public) channels.push('Public (30m delay)')
    console.log(`Telegram: ${channels.join(' + ')}`)
  }
  console.log('-'.repeat(60))

  const chainNames = ['mainnet', 'base', 'arbitrum', 'unichain']
  const lastBlock: Record<string, bigint> = {}

  // Load persisted last-block state (resume from where we left off)
  const LAST_BLOCKS_FILE = 'data/last-blocks.json'
  const savedBlocks: Record<string, string> = readJsonSafe(LAST_BLOCKS_FILE, {})
  const saveLastBlocks = () => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(lastBlock)) out[k] = v.toString()
    writeJsonAtomic(LAST_BLOCKS_FILE, out)
  }

  // Initialize last-seen block for each chain (with 10s timeout per chain)
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

  for (const name of chainNames) {
    try {
      const client = getClient(name)
      const currentBlock = await withTimeout(client.getBlockNumber(), 15_000)
      if (savedBlocks[name]) {
        const saved = BigInt(savedBlocks[name])
        lastBlock[name] = saved < currentBlock ? saved : currentBlock
        console.log(`  Watching ${name} (resuming from block ${lastBlock[name]}, current ${currentBlock})`)
      } else {
        lastBlock[name] = currentBlock
        console.log(`  Watching ${name} (from block ${lastBlock[name]})`)
      }
    } catch (err: any) {
      console.error(`  Skipping ${name}: ${err.message}`)
    }
  }

  // Track already-processed auctions to prevent duplicates on re-poll
  const processedAuctions = new Set<string>()
  // Seed from existing detection log
  const detections = readJsonSafe<any[]>('data/live-detections.json', [])
  for (const d of detections) if (d.auction) processedAuctions.add(d.auction.toLowerCase())

  console.log('\nMonitor running (polling every 30s). Press Ctrl+C to stop.\n')

  const poll = async () => {
    for (const name of chainNames) {
      // Retry init for chains that failed at startup
      if (lastBlock[name] === undefined) {
        try {
          const client = getClient(name)
          const currentBlock = await withTimeout(client.getBlockNumber(), 15_000)
          if (savedBlocks[name]) {
            const saved = BigInt(savedBlocks[name])
            lastBlock[name] = saved < currentBlock ? saved : currentBlock
          } else {
            lastBlock[name] = currentBlock
          }
          console.log(`  Late-init ${name} at block ${lastBlock[name]} (current ${currentBlock})`)
        } catch {
          continue
        }
      }
      try {
        const client = getClient(name)
        const chainCfg = CHAINS[name]
        const currentBlock = await client.getBlockNumber()
        if (currentBlock <= lastBlock[name]) continue

        const logs = await client.getLogs({
          address: FACTORY_ADDRESS,
          event: parseAbiItem('event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)'),
          fromBlock: lastBlock[name] + 1n,
          toBlock: currentBlock,
        })

        for (const log of logs) {
          const { auction, token } = log.args as any
          if (processedAuctions.has((auction as string).toLowerCase())) continue
          processedAuctions.add((auction as string).toLowerCase())
          const timestamp = new Date().toISOString()
          const uniswapUrl = `https://app.uniswap.org/explore/auctions/${name === 'mainnet' ? 'ethereum' : name}/${auction}`

          console.log(`\nNEW CCA DETECTED on ${name.toUpperCase()}`)
          console.log(`  Time:          ${timestamp}`)
          console.log(`  Auction addr:  ${auction}`)
          console.log(`  Token addr:    ${token}`)
          console.log(`  Explorer:      ${chainCfg.explorer}/address/${auction}`)
          console.log(`  Uniswap:       ${uniswapUrl}`)

          // Save detection to live log
          const detection = {
            event: 'new_cca',
            chain: name,
            timestamp,
            block: Number(log.blockNumber),
            auction,
            token,
            explorer: `${chainCfg.explorer}/address/${auction}`,
            uniswap: uniswapUrl,
          }
          appendDetection(detection)
          recordDetection(auction as string)

          sendWebhook(detection)

          // Auto-analyze the new auction
          console.log('  Auto-analyzing...')
          const entry = { name: `NEW_${name.toUpperCase()}`, chain: name, contractAddress: auction as `0x${string}`, startBlock: 0n, notes: `Auto-detected ${timestamp}`, isTest: false }
          const result = await analyzeAuction(entry)
          if (result) appendResult(result)

          // Send Telegram alert
          const alertText = formatTelegramAlert(detection, result)
          await routeAlert('auction', alertText)
          console.log('  Telegram alert sent')

          // Start tracking bids on this new auction
          const tracked = await initTrackedAuction(auction as `0x${string}`, name, token)
          if (tracked) {
            trackedAuctions.push(tracked)
            console.log(`  Tracking bids for ${tracked.tokenSymbol || auction}`)
          }
        }

        lastBlock[name] = currentBlock
        lastSuccessfulPoll[name] = new Date().toISOString()
        saveLastBlocks()
      } catch (err: any) {
        console.error(`  Poll error (${name}): ${err.message}`)
      }
    }
  }

  // Flush any pending public alerts from before restart
  await flushPendingAlerts()

  const interval = setInterval(poll, 30_000)
  const bidInterval = setInterval(pollBids, BID_POLL_INTERVAL)
  const priceInterval = setInterval(pollPrices, PRICE_CHECK_INTERVAL)
  const endIntelInterval = setInterval(checkEndAlerts, 5 * 60_000) // check every 5 min
  const alertFlushInterval = setInterval(flushPendingAlerts, 60_000)
  const dailyInterval = setInterval(async () => { await sendDailySummary(); await sendHeartbeat(); await sendWeeklyDigest(); await sendStateCCA(); await checkMilestones(); }, 60_000)

  // Init graduated token price tracking
  console.log('\nInitializing token price tracking...')
  await initTokenTracking()
  if (trackedTokens.length > 0) {
    console.log(`Tracking prices for ${trackedTokens.length} graduated token(s)`)
  } else {
    console.log('No graduated tokens with active DEX pools found')
  }

  // Auto-track any known active auctions on startup
  for (const a of KNOWN_AUCTIONS.filter(a => !a.isTest && a.contractAddress !== '0x')) {
    try {
      const client = getClient(a.chain)
      const currentBlock = await withTimeout(client.getBlockNumber(), 15_000)
      const [endBlockResult] = await client.multicall({
        contracts: [{ address: a.contractAddress, abi: AUCTION_ABI as any, functionName: 'endBlock' }],
      })
      const endBlock = endBlockResult.status === 'success' ? (endBlockResult.result as bigint) : 0n
      if (endBlock > currentBlock) {
        const tracked = await initTrackedAuction(a.contractAddress, a.chain, '')
        if (tracked) {
          trackedAuctions.push(tracked)
          console.log(`  Tracking active auction: ${tracked.tokenSymbol || a.name}`)
        }
      }
    } catch {}
  }
  if (trackedAuctions.length > 0) {
    console.log(`\nTracking bids on ${trackedAuctions.length} active auction(s)`)
  } else {
    console.log('\nNo active auctions to track bids on currently')
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    clearInterval(interval)
    clearInterval(bidInterval)
    clearInterval(priceInterval)
    clearInterval(endIntelInterval)
    clearInterval(alertFlushInterval)
    clearInterval(dailyInterval)
    process.exit(0)
  })

  await new Promise(() => {})
}

// ─── ENTRY POINT ────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] || 'analyze'
  const realOnly = process.argv.includes('--real-only')
  const dryRun = process.argv.includes('--dry-run')

  if (dryRun) {
    console.log('DRY RUN — printing scheduled posts without sending\n')
    await sendStateCCA(true)
    await checkMilestones(true)
    console.log('\nDone.')
    return
  }

  if (mode === 'watch') {
    await watchForNewAuctions()
  } else {
    console.log('CCA Historical Analysis')
    console.log('Pulling data from all known auctions...\n')

    // Default: analyze ALL auctions (real + test) so results.json is complete.
    // --real-only: analyze only real auctions, but UPSERT into existing file
    // (never shrinks the dataset — test records are preserved).
    // isTest filtering for display/alerts happens downstream, never here.
    const auctions = realOnly
      ? KNOWN_AUCTIONS.filter(a => !a.isTest)
      : KNOWN_AUCTIONS
    if (realOnly) {
      console.log(`(--real-only: analyzing ${auctions.length} real auctions, preserving existing test records)\n`)
    } else {
      const testCount = auctions.filter(a => a.isTest).length
      if (testCount > 0) console.log(`(Analyzing all ${auctions.length} auctions: ${auctions.length - testCount} real, ${testCount} test)\n`)
    }

    const results = []
    for (const auction of auctions) {
      const result = await analyzeAuction(auction)
      if (result) results.push(result)
    }

    // Summary
    const real = results.filter(r => !r.isTest)
    const tests = results.filter(r => r.isTest)

    console.log('\n\nDATASET SUMMARY')
    console.log('='.repeat(60))
    console.log(`Total auctions analyzed: ${results.length}${tests.length ? ` (${real.length} real, ${tests.length} test)` : ''}`)
    console.log(`Graduated: ${results.filter(r => r.graduated).length}`)
    console.log(`Failed: ${results.filter(r => r.graduated === false).length}`)
    console.log(`With validation hooks: ${results.filter(r => r.hasValidationHook).length}`)

    // ── Repeat-bidder cross-reference (real auctions only) ──────────────
    const bidderIndex: Map<string, string[]> = new Map() // address -> auction names
    for (const r of real) {
      const addrs = (r as any)._bidderAddresses as string[] | undefined
      if (!addrs) continue
      for (const addr of addrs) {
        const list = bidderIndex.get(addr)
        if (list) list.push(r.name)
        else bidderIndex.set(addr, [r.name])
      }
    }

    const repeatBidders = [...bidderIndex.entries()].filter(([, auctions]) => auctions.length >= 2)
    const bidderIndexSorted = [...bidderIndex.entries()]
      .map(([address, auctions]) => ({ address, auctionCount: auctions.length, auctions }))
      .sort((a, b) => b.auctionCount - a.auctionCount)

    // Add repeatBidders count to each result
    for (const r of real) {
      const addrs = (r as any)._bidderAddresses as string[] | undefined
      if (!addrs) { (r as any).repeatBidders = 0; continue }
      (r as any).repeatBidders = addrs.filter(a => (bidderIndex.get(a)?.length ?? 0) >= 2).length
    }

    // Write bidder index
    writeJsonAtomic('data/bidder-index.json', bidderIndexSorted)

    console.log(`\nREPEAT-BIDDER CROSS-REFERENCE`)
    console.log('='.repeat(60))
    console.log(`Total unique addresses (real auctions): ${bidderIndex.size.toLocaleString('en-US')}`)
    console.log(`Appearing in 2+ auctions: ${repeatBidders.length.toLocaleString('en-US')}`)
    if (bidderIndexSorted.length > 0) {
      console.log(`\nTop 10 repeat bidders:`)
      for (const entry of bidderIndexSorted.slice(0, 10)) {
        console.log(`  ${entry.address}  ${entry.auctionCount} auctions: ${entry.auctions.join(', ')}`)
      }
    }
    for (const r of real) {
      console.log(`  ${r.name}: ${(r as any).repeatBidders} repeat bidders`)
    }

    // ── Hook clustering analysis ──────────────────────────────────────
    const hookedAuctions = new Set(real.filter(r => r.hasValidationHook).map(r => r.name))
    let repeatInHooked = 0, repeatInOpen = 0, singleInHooked = 0, singleInOpen = 0
    for (const [addr, auctions] of bidderIndex) {
      const isRepeat = auctions.length >= 2
      for (const aName of auctions) {
        const hooked = hookedAuctions.has(aName)
        if (isRepeat) { hooked ? repeatInHooked++ : repeatInOpen++ }
        else { hooked ? singleInHooked++ : singleInOpen++ }
      }
    }
    const repeatTotal = repeatInHooked + repeatInOpen
    const singleTotal = singleInHooked + singleInOpen
    const repeatHookedPct = repeatTotal > 0 ? (repeatInHooked / repeatTotal * 100).toFixed(1) : '0'
    const singleHookedPct = singleTotal > 0 ? (singleInHooked / singleTotal * 100).toFixed(1) : '0'

    console.log(`\nHOOK CLUSTERING`)
    console.log('='.repeat(60))
    console.log(`Hooked auctions: ${[...hookedAuctions].join(', ')}`)
    console.log(`Repeat bidders — participations in hooked: ${repeatInHooked}, open: ${repeatInOpen} (${repeatHookedPct}% hooked)`)
    console.log(`Single bidders — participations in hooked: ${singleInHooked}, open: ${singleInOpen} (${singleHookedPct}% hooked)`)
    for (const r of real) {
      const total = (r as any).uniqueBidders || 0
      const repeat = (r as any).repeatBidders || 0
      const pct = total > 0 ? (repeat / total * 100).toFixed(1) : '0'
      console.log(`  ${r.name}: ${repeat}/${total} repeat bidders (${pct}%)${r.hasValidationHook ? ' [hooked]' : ' [open]'}`)
    }

    const bidderInsights = {
      totalUnique: bidderIndex.size,
      repeatBidders: repeatBidders.length,
      recurrenceRate: `${(repeatBidders.length / bidderIndex.size * 100).toFixed(2)}%`,
      repeatInHooked, repeatInOpen, repeatHookedPct: `${repeatHookedPct}%`,
      singleInHooked, singleInOpen, singleHookedPct: `${singleHookedPct}%`,
    }

    // Strip internal _bidderAddresses before saving
    for (const r of results) delete (r as any)._bidderAddresses

    // In --real-only mode, merge new real results into existing file (upsert).
    // Existing test records are preserved — partial analyze never shrinks the dataset.
    let allResults = results
    if (realOnly) {
      const existing = readJsonSafe('data/results.json', { auctions: [] as any[] })
      const existingAuctions = existing.auctions || []
      if (existingAuctions.length > 0) {
        const existingTests = existingAuctions.filter((a: any) => a.isTest)
        const newAddrs = new Set(results.map((r: any) => r.contractAddress?.toLowerCase()))
        const keptExisting = existingAuctions.filter((a: any) =>
          a.isTest || !newAddrs.has(a.contractAddress?.toLowerCase())
        )
        allResults = [...keptExisting, ...results]
        console.log(`\n--real-only upsert: ${results.length} real updated, ${existingTests.length} test records preserved`)
      } else {
        console.log(`\nNo existing results.json — writing ${results.length} results`)
      }
    }

    const allReal = allResults.filter((r: any) => !r.isTest)
    const allTests = allResults.filter((r: any) => r.isTest)

    // Save to file
    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        total: allResults.length,
        real: allReal.length,
        tests: allTests.length,
        graduated: allResults.filter((r: any) => r.graduated).length,
        failed: allResults.filter((r: any) => r.graduated === false).length,
        withHooks: allResults.filter((r: any) => r.hasValidationHook).length,
        bidderInsights,
      },
      auctions: allResults,
    }

    writeJsonAtomic('data/results.json', output)
    console.log(`\nResults saved to data/results.json`)
    console.log(`Bidder index saved to data/bidder-index.json`)
  }
}

main().catch(console.error)
