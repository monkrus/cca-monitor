/**
 * Whale Profile — deep-dive a single bidder across all real CCA auctions
 *
 * Usage: npm run profile [address]
 * Default: the address that bid in the most auctions (from bidder-index.json)
 */

import * as fs from 'fs'
import { getClient, getLogsChunked, AUCTION_ABI, ERC20_ABI, BID_EVENT, CHAINS, q96ToPrice } from './shared.ts'

// ─── Load data ──────────────────────────────────────────────────────────────
function loadResults(): any {
  return JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
}

function loadBidderIndex(): Array<{ address: string; auctionCount: number; auctions: string[] }> {
  return JSON.parse(fs.readFileSync('data/bidder-index.json', 'utf-8'))
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  let targetAddr = process.argv[2]?.toLowerCase()

  if (!targetAddr) {
    const index = loadBidderIndex()
    const top = index[0]
    if (!top) { console.error('No bidder-index.json found. Run npm run analyze first.'); process.exit(1) }
    targetAddr = top.address
    console.log(`No address provided — defaulting to top whale: ${targetAddr} (${top.auctionCount} auctions)`)
  }

  console.log(`\nPROFILE: ${targetAddr}`)
  console.log('='.repeat(70))

  const data = loadResults()
  const auctions = (data.auctions as any[]).filter((a: any) => !a.isTest)

  // Find which auctions this bidder participated in
  const index = loadBidderIndex()
  const entry = index.find(e => e.address === targetAddr)
  if (!entry) {
    console.log('Address not found in bidder index.')
    process.exit(1)
  }

  console.log(`Participated in ${entry.auctionCount} auction(s): ${entry.auctions.join(', ')}\n`)

  const summaryRows: string[] = []

  for (const auctionName of entry.auctions) {
    const auctionData = auctions.find((a: any) => a.name === auctionName)
    if (!auctionData) { console.log(`  ${auctionName}: not in results.json, skipping`); continue }

    const chain = auctionData.chain
    const address = auctionData.tokenAddress ? auctionData.name : auctionData.name // for logging
    const contractAddr = findContractAddress(auctionData)
    if (!contractAddr) { console.log(`  ${auctionName}: no contract address found, skipping`); continue }

    console.log(`── ${auctionName} (${chain}) ──`)

    const client = getClient(chain)
    const startBlock = BigInt(auctionData.startBlock)
    const endBlock = BigInt(auctionData.endBlock)

    // Fetch all BidSubmitted events for this auction
    console.log(`  Scanning bids (blocks ${startBlock}–${endBlock})...`)
    const { logs: allBids } = await getLogsChunked(client, {
      address: contractAddr as `0x${string}`,
      event: BID_EVENT,
      fromBlock: startBlock,
      toBlock: endBlock,
    }, true, chain)

    // Filter to this bidder
    const myBids = allBids.filter((log: any) => (log.args.owner as string).toLowerCase() === targetAddr)
    if (myBids.length === 0) {
      console.log(`  No bids found (may be event parsing issue)`)
      continue
    }

    // Get currency info
    const currencyDecimals = auctionData.currencySymbol === 'USDC' || auctionData.currencySymbol === 'USDT' ? 6 : 18
    const currencySymbol = auctionData.currencySymbol || 'ETH'
    const tokenDecimals = 18 // default; could read from chain but not worth RPC

    // Total amount
    let totalAmount = 0n
    const bidBlocks: bigint[] = []
    const bidPrices: bigint[] = []
    for (const bid of myBids) {
      const args = bid.args as any
      totalAmount += BigInt(args.amount || 0)
      bidBlocks.push(bid.blockNumber)
      bidPrices.push(BigInt(args.price || 0))
    }

    // Format total amount
    const divisor = 10n ** BigInt(currencyDecimals)
    const amtWhole = totalAmount / divisor
    const amtFrac = (totalAmount % divisor).toString().padStart(currencyDecimals, '0').slice(0, 4)
    const amtStr = `${amtWhole.toLocaleString('en-US')}.${amtFrac} ${currencySymbol}`

    // Timing as % of auction duration
    const duration = Number(endBlock - startBlock)
    const firstBidBlock = bidBlocks.reduce((a, b) => a < b ? a : b)
    const lastBidBlock = bidBlocks.reduce((a, b) => a > b ? a : b)
    const entryPct = ((Number(firstBidBlock - startBlock) / duration) * 100).toFixed(1)
    const exitPct = ((Number(lastBidBlock - startBlock) / duration) * 100).toFixed(1)

    // Price analysis vs floor and clearing
    const floorQ96 = auctionData.floorPrice_Q96 ? BigInt(auctionData.floorPrice_Q96) : 0n
    const clearingQ96 = auctionData.finalClearingPrice_Q96 ? BigInt(auctionData.finalClearingPrice_Q96) : 0n

    const minPrice = bidPrices.reduce((a, b) => a < b ? a : b)
    const maxPrice = bidPrices.reduce((a, b) => a > b ? a : b)

    let priceAnalysis = ''
    if (clearingQ96 > 0n) {
      const allAboveClearing = minPrice >= clearingQ96
      const allBelowClearing = maxPrice < clearingQ96
      if (allAboveClearing) priceAnalysis = 'all bids >= clearing (likely filled)'
      else if (allBelowClearing) priceAnalysis = 'all bids < clearing (likely NOT filled)'
      else priceAnalysis = 'mixed — some above, some below clearing'
    }

    const minPriceDecoded = q96ToPrice(minPrice.toString(), tokenDecimals, currencyDecimals)
    const maxPriceDecoded = q96ToPrice(maxPrice.toString(), tokenDecimals, currencyDecimals)
    const floorDecoded = auctionData.floorPrice || '?'
    const clearingDecoded = auctionData.clearingPrice || '?'

    console.log(`  Bids: ${myBids.length}`)
    console.log(`  Total committed: ${amtStr}`)
    console.log(`  Timing: entered at ${entryPct}% elapsed, last bid at ${exitPct}%`)
    console.log(`  Bid price range: ${minPriceDecoded} – ${maxPriceDecoded}`)
    console.log(`  Floor: ${floorDecoded} | Clearing: ${clearingDecoded}`)
    if (priceAnalysis) console.log(`  Fill estimate: ${priceAnalysis}`)
    console.log(`  Graduated: ${auctionData.graduated ? 'yes' : 'no'}`)
    console.log()

    summaryRows.push(
      `${auctionName.padEnd(8)} ${String(myBids.length).padStart(4)} bids  ${amtStr.padStart(22)}  entry ${entryPct.padStart(5)}%  last ${exitPct.padStart(5)}%  ${priceAnalysis || ''}`
    )
  }

  console.log('SUMMARY')
  console.log('='.repeat(70))
  console.log(`Address: ${targetAddr}`)
  console.log(`Auctions: ${entry.auctionCount}`)
  console.log()
  for (const row of summaryRows) console.log(`  ${row}`)
}

// ─── Helper: find contract address from results or known auctions ───────────
function findContractAddress(auctionData: any): string | null {
  // results.json doesn't store contractAddress directly, but we can find it
  // from the known auctions list or look it up
  const knownMap: Record<string, string> = {
    AZTEC:  '0x608c4e792c65f5527b3f70715dea44d3b302f4ee',
    STRATO: '0xfFDab1083fCbBCEE32997795388B3D61Ebab786E',
    wOCT:   '0xb3079Ec6b82f22A1ABfDCA1A22659aB07Cdf2f0F',
    CAP:    '0x20eebd78151eae9ed2380ac613204aaf5ca0cd24',
  }
  return knownMap[auctionData.name] || null
}

main().catch(console.error)
