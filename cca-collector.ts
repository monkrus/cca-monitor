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
    notes: '$59M raised, 17,000 bidders, Nov-Dec 2025. Concluded block 23,955,276. Validation hook: ZK Passport + contributor allowlist.',
    isTest: false,
  },
  {
    name: 'STRATO',
    chain: 'mainnet',
    contractAddress: '0xfFDab1083fCbBCEE32997795388B3D61Ebab786E' as `0x${string}`,
    startBlock: 0n,
    notes: '1,016 ETH raised, 577 bids, 292 unique wallets, Jun 3-11 2026. 4th largest CCA by volume. HardFi/gold platform.',
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
    notes: '1,002 bids, 5.5x oversubscribed, $106M FDV, $16.4M raised in USDC, floor $75M FDV, cleared at $0.011/CAP. Token: rCAP.',
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
  { name: 'requiredCurrencyRaised', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'clearingPrice',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'isGraduated',            type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool'    }] },
  { name: 'totalCurrencyRaised',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'token',                  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  parseAbiItem('event CheckpointUpdated(uint256 indexed blockNumber, uint256 clearingPrice, uint24 cumulativeMps)'),
  parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint256 amount)'),
] as const

const ERC20_ABI = [
  { name: 'name',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'  }] },
] as const

// ─── Chain config ────────────────────────────────────────────────────────────
const CHAINS: Record<string, { chain: any, secsPerBlock: number, explorer: string }> = {
  mainnet:  { chain: mainnet,  secsPerBlock: 12,   explorer: 'https://etherscan.io' },
  base:     { chain: base,     secsPerBlock: 2,    explorer: 'https://basescan.org' },
  arbitrum: { chain: arbitrum, secsPerBlock: 0.25, explorer: 'https://arbiscan.io' },
  unichain: { chain: unichain, secsPerBlock: 1,    explorer: 'https://uniscan.xyz' },
}

// ─── RPC clients ────────────────────────────────────────────────────────────
function getClient(chainName: string, usePublicRpc = false) {
  const rpcUrl = usePublicRpc ? undefined : process.env[`RPC_URL_${chainName.toUpperCase()}`]
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
async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } catch (err: any) {
    console.error(`Telegram failed: ${err.message}`)
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
    if (analysis.tokenSymbol) lines.push(`<b>Token ID:</b> ${analysis.tokenSymbol} (${analysis.tokenName})`)
    if (analysis.currency) {
      const cur = analysis.currency === '0x0000000000000000000000000000000000000000' ? 'ETH'
        : analysis.currency === '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' ? 'USDC' : analysis.currency
      lines.push(`<b>Currency:</b> ${cur}`)
    }
    if (analysis.durationHours) lines.push(`<b>Duration:</b> ${analysis.durationHours}h`)
    if (analysis.floorPrice) lines.push(`<b>Floor price:</b> ${analysis.floorPrice}`)
    lines.push(`<b>Validation hook:</b> ${analysis.hasValidationHook ? 'Yes' : 'No'}`)
    if (analysis.flags?.length) lines.push(`<b>Flags:</b> ${analysis.flags.join(', ')}`)
  }
  lines.push(``, `<a href="${detection.uniswap}">View on Uniswap</a> | <a href="${detection.explorer}">Explorer</a>`)
  return lines.join('\n')
}

// ─── Persistent data helpers ────────────────────────────────────────────────
function appendDetection(detection: Record<string, any>) {
  fs.mkdirSync('data', { recursive: true })
  const file = 'data/live-detections.json'
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []
  existing.push(detection)
  fs.writeFileSync(file, JSON.stringify(existing, null, 2))
}

function appendResult(result: Record<string, any>) {
  fs.mkdirSync('data', { recursive: true })
  const file = 'data/results.json'
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : { timestamp: '', summary: {}, auctions: [] }
  existing.auctions.push(result)
  existing.timestamp = new Date().toISOString()
  existing.summary.total = existing.auctions.length
  fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  console.log(`  Saved to ${file} (${existing.auctions.length} auctions total)`)
}

// ─── Chunked getLogs with retry ──────────────────────────────────────────────
const LOG_CHUNK_SIZE = 5000n
const MAX_LOG_RANGE = 50000n

async function getLogsChunked(
  client: ReturnType<typeof getClient>,
  params: { address: `0x${string}`, event: any, fromBlock: bigint, toBlock: bigint },
) {
  const cappedTo = (params.toBlock - params.fromBlock > MAX_LOG_RANGE)
    ? params.fromBlock + MAX_LOG_RANGE
    : params.toBlock

  const allLogs: any[] = []
  let from = params.fromBlock
  let retries = 0
  while (from <= cappedTo) {
    const to = from + LOG_CHUNK_SIZE < cappedTo ? from + LOG_CHUNK_SIZE : cappedTo
    try {
      const logs = await client.getLogs({
        address: params.address,
        event: params.event,
        fromBlock: from,
        toBlock: to,
      })
      allLogs.push(...logs)
      from = to + 1n
      retries = 0
    } catch (err: any) {
      const msg = err?.details || err?.message || ''
      if ((msg.includes('Too Many') || msg.includes('429')) && retries < 5) {
        retries++
        await new Promise(r => setTimeout(r, 1000 * retries))
        continue
      }
      throw err
    }
  }
  if (params.toBlock - params.fromBlock > MAX_LOG_RANGE) {
    console.log(`  (scanned first ${MAX_LOG_RANGE} of ${params.toBlock - params.fromBlock} blocks)`)
  }
  return allLogs
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
           floorPrice, requiredRaise, clearingPrice, graduated, totalRaised, tokenAddr] =
      await client.multicall({
        contracts: [
          { address, abi: AUCTION_ABI as any, functionName: 'currency' },
          { address, abi: AUCTION_ABI as any, functionName: 'startBlock' },
          { address, abi: AUCTION_ABI as any, functionName: 'endBlock' },
          { address, abi: AUCTION_ABI as any, functionName: 'tickSpacing' },
          { address, abi: AUCTION_ABI as any, functionName: 'validationHook' },
          { address, abi: AUCTION_ABI as any, functionName: 'floorPrice' },
          { address, abi: AUCTION_ABI as any, functionName: 'requiredCurrencyRaised' },
          { address, abi: AUCTION_ABI as any, functionName: 'clearingPrice' },
          { address, abi: AUCTION_ABI as any, functionName: 'isGraduated' },
          { address, abi: AUCTION_ABI as any, functionName: 'totalCurrencyRaised' },
          { address, abi: AUCTION_ABI as any, functionName: 'token' },
        ],
      })

    const ok = (r: any) => r.status === 'success' ? r.result : undefined
    const startBlockVal = ok(startBlock) as bigint | undefined
    const endBlockVal = ok(endBlock) as bigint | undefined
    const durationBlocks = (startBlockVal && endBlockVal) ? Number(endBlockVal - startBlockVal) : 0
    const durationHours = Math.round(durationBlocks * chainCfg.secsPerBlock / 3600)

    const floorBig = ok(floorPrice) ? BigInt(ok(floorPrice)) : 0n
    const tickBig = ok(tickSpacing) ? BigInt(ok(tickSpacing)) : 0n
    const tickPct = floorBig > 0n ? (Number(tickBig * 1_000_000n / floorBig) / 10_000).toFixed(4) : '?'

    // Read token name/symbol
    const tokenAddress = ok(tokenAddr) as `0x${string}` | undefined
    let tokenName: string | undefined
    let tokenSymbol: string | undefined
    if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
      try {
        const [nameResult, symbolResult] = await client.multicall({
          contracts: [
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'name' },
            { address: tokenAddress, abi: ERC20_ABI as any, functionName: 'symbol' },
          ],
        })
        tokenName = ok(nameResult) as string | undefined
        tokenSymbol = ok(symbolResult) as string | undefined
      } catch {}
    }

    // Decode Q96 prices to human-readable
    const floorDecimal = q96ToDecimal(ok(floorPrice)?.toString())
    const clearingDecimal = q96ToDecimal(ok(clearingPrice)?.toString())
    const clearingVsFloor = (floorBig > 0n && ok(clearingPrice))
      ? `${(Number(BigInt(ok(clearingPrice)) * 10000n / floorBig) / 100).toFixed(1)}%`
      : '?'

    const result = {
      name: auction.name,
      chain: auction.chain,
      isTest: auction.isTest,
      tokenAddress,
      tokenName,
      tokenSymbol,
      startBlock: startBlockVal?.toString(),
      endBlock: endBlockVal?.toString(),
      floorPrice_Q96: ok(floorPrice)?.toString(),
      floorPrice: floorDecimal,
      tickSpacing_Q96: ok(tickSpacing)?.toString(),
      tickSpacingAsPctOfFloor: `${tickPct}%`,
      durationBlocks,
      durationHours,
      requiredRaise: ok(requiredRaise)?.toString(),
      hasValidationHook: ok(validationHook) != null && ok(validationHook) !== '0x0000000000000000000000000000000000000000',
      currency: ok(currency) as string | undefined,
      graduated: ok(graduated) as boolean | undefined,
      finalClearingPrice_Q96: ok(clearingPrice)?.toString(),
      clearingPrice: clearingDecimal,
      clearingVsFloor,
      totalRaised: ok(totalRaised)?.toString(),
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
      const bidLogs = await getLogsChunked(client, {
        address: auction.contractAddress,
        event: parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint256 amount)'),
        fromBlock: logFromBlock,
        toBlock: logToBlock,
      })

      const uniqueBidders = new Set(bidLogs.map(log => (log.args as any).owner)).size
      const totalBids = bidLogs.length
      console.log(`Bid stats: ${totalBids} total bids, ${uniqueBidders} unique bidders`)
      return { ...result, uniqueBidders, totalBids }
    } catch (logErr: any) {
      const msg = logErr?.details || logErr?.message || ''
      if (msg.includes('block range') || msg.includes('Free tier')) {
        console.log(`Skipping bid events — RPC block range too limited.`)
      } else {
        console.log(`Skipping bid events — ${msg}`)
      }
      return result
    }

  } catch (err) {
    console.error(`Error reading ${auction.name}:`, err)
    return null
  }
}

// ─── LIVE MONITOR: Poll for new auctions across all chains (no filters) ─────
async function watchForNewAuctions() {
  console.log('\nStarting new auction monitor...')
  console.log('Watching factory on: Ethereum, Base, Arbitrum, Unichain')
  console.log('Factory address:', FACTORY_ADDRESS)
  if (process.env.WEBHOOK_URL) console.log('Webhook: enabled')
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) console.log('Telegram: enabled')
  console.log('-'.repeat(60))

  const chainNames = ['mainnet', 'base', 'arbitrum', 'unichain']
  const lastBlock: Record<string, bigint> = {}

  // Initialize last-seen block for each chain (with 10s timeout per chain)
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

  for (const name of chainNames) {
    try {
      const client = getClient(name)
      lastBlock[name] = await withTimeout(client.getBlockNumber(), 15_000)
      console.log(`  Watching ${name} (from block ${lastBlock[name]})`)
    } catch (err: any) {
      console.error(`  Skipping ${name}: ${err.message}`)
    }
  }

  console.log('\nMonitor running (polling every 30s). Press Ctrl+C to stop.\n')

  const poll = async () => {
    for (const name of chainNames) {
      if (lastBlock[name] === undefined) continue
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

          sendWebhook(detection)

          // Auto-analyze the new auction
          console.log('  Auto-analyzing...')
          const entry = { name: `NEW_${name.toUpperCase()}`, chain: name, contractAddress: auction as `0x${string}`, startBlock: 0n, notes: `Auto-detected ${timestamp}`, isTest: false }
          const result = await analyzeAuction(entry)
          if (result) appendResult(result)

          // Send Telegram alert
          const alertText = formatTelegramAlert(detection, result)
          await sendTelegram(alertText)
          console.log('  Telegram alert sent')
        }

        lastBlock[name] = currentBlock
      } catch (err: any) {
        // Silently retry on next poll — transient RPC errors are normal
      }
    }
  }

  const interval = setInterval(poll, 30_000)

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    clearInterval(interval)
    process.exit(0)
  })

  await new Promise(() => {})
}

// ─── ENTRY POINT ────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] || 'analyze'
  const includeTests = process.argv.includes('--include-tests')

  if (mode === 'watch') {
    await watchForNewAuctions()
  } else {
    console.log('CCA Historical Analysis')
    console.log('Pulling data from all known auctions...\n')

    const auctions = includeTests
      ? KNOWN_AUCTIONS
      : KNOWN_AUCTIONS.filter(a => !a.isTest)

    if (!includeTests) {
      const skipped = KNOWN_AUCTIONS.length - auctions.length
      if (skipped > 0) console.log(`(Skipping ${skipped} test auctions. Use --include-tests to include them.)\n`)
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

    // Save to file
    const output = {
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        real: real.length,
        tests: tests.length,
        graduated: results.filter(r => r.graduated).length,
        failed: results.filter(r => r.graduated === false).length,
        withHooks: results.filter(r => r.hasValidationHook).length,
      },
      auctions: results,
    }

    fs.mkdirSync('data', { recursive: true })
    fs.writeFileSync('data/results.json', JSON.stringify(output, null, 2))
    console.log(`\nResults saved to data/results.json`)
  }
}

main().catch(console.error)
