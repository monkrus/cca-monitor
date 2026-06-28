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

import { createPublicClient, http, parseAbiItem, decodeEventLog, formatUnits } from 'viem'
import { mainnet, base, arbitrum } from 'viem/chains'
import * as dotenv from 'dotenv'
dotenv.config()

// ─── Factory address (same across all chains) ───────────────────────────────
const FACTORY_ADDRESS = '0x0000ccaDF55C911a2FbC0BB9d2942Aa77c6FAa1D' as const

// ─── Known completed auctions (add more as they happen) ─────────────────────
const KNOWN_AUCTIONS = [
  {
    name: 'AZTEC',
    chain: 'mainnet',
    contractAddress: '0x4b00c30ceba3f188407c6e6741cc5b43561f1f6e' as `0x${string}`, // VirtualAztecToken / auction contract
    startBlock: 23790741n,  // contributor period start block (from validation hook args)
    notes: '$59M raised, 17,000 bidders, Nov-Dec 2025. Concluded block 23,955,276. Token: 0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2. Validation hook: 0x2DD6e0E331DE9743635590F6c8BC5038374CAc9D (ZK Passport + contributor allowlist).'
  },
  {
    name: 'STRATO',
    chain: 'mainnet',                        // ✅ confirmed Ethereum mainnet
    contractAddress: '0xfFDab1083fCbBCEE32997795388B3D61Ebab786E' as `0x${string}`,
    startBlock: 0n,                          // TODO: fill in from Etherscan
    notes: '1,016 ETH raised, 577 bids, 292 unique wallets, Jun 3-11 2026. 4th largest CCA by volume. HardFi/gold platform. 2.5% supply auctioned.'
  },
  {
    name: 'CAP',
    chain: 'base',                           // ✅ confirmed Base
    contractAddress: '0x' as `0x${string}`, // TODO: find via Basescan — one of the May 26 cluster
    startBlock: 46499907n,                   // earliest of May 26 cluster — refine once confirmed
    notes: '1,002 bids, 5.5x oversubscribed, $106M FDV, $16.4M raised in USDC, floor $75M FDV, cleared at $0.011/CAP. Jun 8-17 2026.'
  },
  // ── Unidentified Base auctions from factory internal txns ─────────────────
  // Dec 2025 cluster (likely test/early auctions)
  { name: 'UNKNOWN_DEC08', chain: 'base', contractAddress: '0x090e15d1807e2173c6e9531cfd4701fcd3c04ede' as `0x${string}`, startBlock: 39206206n, notes: 'Dec 8 2025 — unknown project' },
  { name: 'UNKNOWN_DEC18', chain: 'base', contractAddress: '0x4d147d5e6f1cf4af6cd50933eae37f4660743c35' as `0x${string}`, startBlock: 39624912n, notes: 'Dec 18 2025 — unknown project' },
  { name: 'UNKNOWN_DEC23', chain: 'base', contractAddress: '0x58bedc5577044c4f3ca7b2a76ce411ca02ba394b' as `0x${string}`, startBlock: 39869623n, notes: 'Dec 23 2025 — unknown project' },
  { name: 'UNKNOWN_DEC26A', chain: 'base', contractAddress: '0xc1390b7131fce0e96a5ccea739df3016d9a70313' as `0x${string}`, startBlock: 39992861n, notes: 'Dec 26 2025 — unknown project' },
  { name: 'UNKNOWN_DEC26B', chain: 'base', contractAddress: '0x44c18e14fa976cde87f702aa564df28f33ee9d36' as `0x${string}`, startBlock: 39995131n, notes: 'Dec 26 2025 — unknown project' },
  { name: 'UNKNOWN_JAN05',  chain: 'base', contractAddress: '0xcf984ee5001acc3707926d6cc9597fdddc771193' as `0x${string}`, startBlock: 40426331n, notes: 'Jan 5 2026 — unknown project' },
  { name: 'UNKNOWN_JAN19',  chain: 'base', contractAddress: '0x86cc18d5943cb81e10f3b4dea96762433a823047' as `0x${string}`, startBlock: 41019521n, notes: 'Jan 19 2026 — unknown project' },
  // May 26 cluster — likely CAP + related test deployments
  { name: 'MAY26_A', chain: 'base', contractAddress: '0x85e34f170f6f89e377e23531246c727ede55775e' as `0x${string}`, startBlock: 46499907n, notes: 'May 26 2026 — likely CAP or test' },
  { name: 'MAY26_B', chain: 'base', contractAddress: '0x8175727b13e020d0811ced94a8863b7f49e417b1' as `0x${string}`, startBlock: 46500844n, notes: 'May 26 2026 — unknown' },
  { name: 'MAY26_C', chain: 'base', contractAddress: '0x1cdadeeceb6017d19e64b4dc23377d003d174867' as `0x${string}`, startBlock: 46501079n, notes: 'May 26 2026 — unknown' },
  { name: 'MAY26_D', chain: 'base', contractAddress: '0x5107cc753cc9d246de31ec999d549257cde3ae6d' as `0x${string}`, startBlock: 46501539n, notes: 'May 26 2026 — unknown' },
]

// ─── ABI fragments we care about ────────────────────────────────────────────

// Factory emits this when a new auction is deployed
const FACTORY_ABI = [
  parseAbiItem('event AuctionCreated(address indexed auction, address indexed token, uint256 totalSupply)'),
] as const

// Individual auction contract — the params we want to read
const AUCTION_ABI = [
  {
    name: 'parameters',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'currency', type: 'address' },
      { name: 'tokensRecipient', type: 'address' },
      { name: 'fundsRecipient', type: 'address' },
      { name: 'startBlock', type: 'uint64' },
      { name: 'endBlock', type: 'uint64' },
      { name: 'claimBlock', type: 'uint64' },
      { name: 'tickSpacing', type: 'uint256' },
      { name: 'validationHook', type: 'address' },
      { name: 'floorPrice', type: 'uint256' },
      { name: 'requiredCurrencyRaised', type: 'uint128' },
    ],
  },
  {
    name: 'clearingPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isGraduated',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'totalCurrencyRaised',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
  parseAbiItem('event CheckpointUpdated(uint256 indexed blockNumber, uint256 clearingPrice, uint24 cumulativeMps)'),
  parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint256 amount)'),
] as const

// ─── RPC clients ────────────────────────────────────────────────────────────
function getClient(chainName: string) {
  const rpcUrl = process.env[`RPC_URL_${chainName.toUpperCase()}`]
  const chain = chainName === 'mainnet' ? mainnet : chainName === 'base' ? base : arbitrum
  return createPublicClient({
    chain,
    transport: http(rpcUrl || undefined), // falls back to public RPC if not set
  })
}

// ─── HISTORICAL: Pull params + outcomes from a known auction ────────────────
async function analyzeAuction(auction: typeof KNOWN_AUCTIONS[0]) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Analyzing: ${auction.name}`)
  console.log(`Notes: ${auction.notes}`)
  console.log('='.repeat(60))

  if (auction.contractAddress === '0x') {
    console.log('⚠  Contract address not set yet — fill in KNOWN_AUCTIONS')
    return null
  }

  const client = getClient(auction.chain)

  try {
    // Read all config parameters in one multicall
    const [params, clearingPrice, graduated, totalRaised] = await client.multicall({
      contracts: [
        { address: auction.contractAddress, abi: AUCTION_ABI as any, functionName: 'parameters' },
        { address: auction.contractAddress, abi: AUCTION_ABI as any, functionName: 'clearingPrice' },
        { address: auction.contractAddress, abi: AUCTION_ABI as any, functionName: 'isGraduated' },
        { address: auction.contractAddress, abi: AUCTION_ABI as any, functionName: 'totalCurrencyRaised' },
      ],
    })

    const p = params.result as any
    const durationBlocks = p ? Number(p.endBlock - p.startBlock) : 0
    // Ethereum/Base: ~12s per block
    const durationHours = Math.round(durationBlocks * 12 / 3600)

    // Tick spacing as % of floor price (Q96 math simplified)
    // floorPrice and tickSpacing are both Q96 fixed-point
    const floorNum = p?.floorPrice ? Number(p.floorPrice) : 0
    const tickNum = p?.tickSpacing ? Number(p.tickSpacing) : 0
    const tickPct = floorNum > 0 ? ((tickNum / floorNum) * 100).toFixed(4) : '?'

    const result = {
      name: auction.name,
      chain: auction.chain,
      // Config params
      floorPrice_Q96: p?.floorPrice?.toString(),
      tickSpacing_Q96: p?.tickSpacing?.toString(),
      tickSpacingAsPctOfFloor: `${tickPct}%`,
      durationBlocks,
      durationHours,
      requiredRaise: p?.requiredCurrencyRaised?.toString(),
      hasValidationHook: p?.validationHook !== '0x0000000000000000000000000000000000000000',
      currency: p?.currency,
      // Outcomes
      graduated: graduated.result,
      finalClearingPrice_Q96: clearingPrice.result?.toString(),
      totalRaised: totalRaised.result?.toString(),
      // Risk flags (this is your audit logic)
      flags: [] as string[],
    }

    // ── Risk flag logic ──────────────────────────────────────────────────
    // Flag 1: tick spacing below 1bp of floor (DoS risk)
    if (parseFloat(tickPct) < 0.01) {
      result.flags.push('⚠  TICK_TOO_SMALL: tick spacing below 0.01% of floor — DoS risk')
    }

    // Flag 2: auction too short (< 4 hours = sniper-friendly window)
    if (durationHours < 4) {
      result.flags.push('⚠  DURATION_SHORT: auction under 4 hours — limited participation window')
    }

    // Flag 3: auction too long (> 7 days = attention decay)
    if (durationHours > 168) {
      result.flags.push('⚠  DURATION_LONG: auction over 7 days — bidder attention typically decays')
    }

    // Flag 4: no validation hook (no sybil protection)
    if (!result.hasValidationHook) {
      result.flags.push('ℹ  NO_HOOK: no validation hook — open to sybil participation')
    }

    // Flag 5: graduated check
    if (result.graduated === false) {
      result.flags.push('🔴 DID_NOT_GRADUATE: auction failed to reach required raise — all bids refunded')
    }

    console.log(JSON.stringify(result, null, 2))

    // Count unique bidders from BidSubmitted events
    console.log('\nFetching bid events (may take a moment)...')
    const bidLogs = await client.getLogs({
      address: auction.contractAddress,
      event: parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint256 amount)'),
      fromBlock: auction.startBlock,
      toBlock: 'latest',
    })

    const uniqueBidders = new Set(bidLogs.map(log => (log.args as any).owner)).size
    const totalBids = bidLogs.length
    console.log(`\nBid stats: ${totalBids} total bids, ${uniqueBidders} unique bidders`)

    // Oversubscription ratio (bids placed vs tokens available — rough proxy)
    // Real calc needs auctionStepsData decode, but this gives signal
    console.log(`Flags: ${result.flags.length === 0 ? '✅ None' : result.flags.join('\n  ')}`)

    return { ...result, uniqueBidders, totalBids }

  } catch (err) {
    console.error(`Error reading ${auction.name}:`, err)
    return null
  }
}

// ─── LIVE MONITOR: Watch factory for new auctions across all chains ──────────
async function watchForNewAuctions() {
  console.log('\n🔭 Starting new auction monitor...')
  console.log('Watching factory on: Ethereum, Base, Arbitrum')
  console.log('Factory address:', FACTORY_ADDRESS)
  console.log('─'.repeat(60))

  const chains = [
    { name: 'mainnet', client: getClient('mainnet') },
    { name: 'base', client: getClient('base') },
    { name: 'arbitrum', client: getClient('arbitrum') },
  ]

  for (const { name, client } of chains) {
    // watchContractEvent returns an unsubscribe function
    const unwatch = client.watchContractEvent({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      eventName: 'AuctionCreated',
      onLogs: (logs) => {
        for (const log of logs) {
          const { auction, token, totalSupply } = log.args as any
          const timestamp = new Date().toISOString()

          console.log(`\n🚀 NEW CCA DETECTED on ${name.toUpperCase()}`)
          console.log(`  Time:          ${timestamp}`)
          console.log(`  Auction addr:  ${auction}`)
          console.log(`  Token addr:    ${token}`)
          console.log(`  Total supply:  ${totalSupply?.toString()}`)
          console.log(`  Etherscan:     https://${name === 'mainnet' ? '' : name + '.'}etherscan.io/address/${auction}`)
          console.log(`  Action:        Add to KNOWN_AUCTIONS and run analyzeAuction()`)

          // In production: send webhook, email, Telegram bot message here
          // e.g. await sendTelegramAlert({ auction, token, chain: name })
        }
      },
      onError: (err) => {
        console.error(`Watch error on ${name}:`, err.message)
      },
    })

    console.log(`✅ Watching ${name}`)
  }

  // Keep process alive
  console.log('\nMonitor running. Press Ctrl+C to stop.\n')
  await new Promise(() => {}) // run forever
}

// ─── ENTRY POINT ────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] || 'analyze'

  if (mode === 'watch') {
    await watchForNewAuctions()
  } else {
    // Analyze all known auctions, build dataset
    console.log('CCA Historical Analysis')
    console.log('Pulling data from all known auctions...\n')

    const results = []
    for (const auction of KNOWN_AUCTIONS) {
      const result = await analyzeAuction(auction)
      if (result) results.push(result)
    }

    console.log('\n\n📊 DATASET SUMMARY')
    console.log('='.repeat(60))
    console.log(`Total auctions analyzed: ${results.length}`)
    console.log(`Graduated: ${results.filter(r => r.graduated).length}`)
    console.log(`Failed: ${results.filter(r => r.graduated === false).length}`)
    console.log(`With validation hooks: ${results.filter(r => r.hasValidationHook).length}`)
    console.log('\nFull dataset:')
    console.log(JSON.stringify(results, null, 2))
  }
}

main().catch(console.error)