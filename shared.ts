/**
 * Shared helpers used by cca-collector.ts, bidder-profile.ts, postmortem.ts
 */

import { createPublicClient, http, parseAbiItem, defineChain } from 'viem'
import { mainnet, base, arbitrum } from 'viem/chains'
import * as dotenv from 'dotenv'
dotenv.config()

// ─── Unichain ────────────────────────────────────────────────────────────────
export const unichain = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } },
  blockExplorers: { default: { name: 'Uniscan', url: 'https://uniscan.xyz' } },
})

// ─── Chain config ────────────────────────────────────────────────────────────
export const CHAINS: Record<string, { chain: any, secsPerBlock: number, explorer: string }> = {
  mainnet:  { chain: mainnet,  secsPerBlock: 12,   explorer: 'https://etherscan.io' },
  base:     { chain: base,     secsPerBlock: 2,    explorer: 'https://basescan.org' },
  arbitrum: { chain: arbitrum, secsPerBlock: 0.25, explorer: 'https://arbiscan.io' },
  unichain: { chain: unichain, secsPerBlock: 1,    explorer: 'https://uniscan.xyz' },
}

// ─── RPC clients ─────────────────────────────────────────────────────────────
export const PUBLIC_RPCS: Record<string, string> = {
  mainnet:  'https://eth.blockscout.com/api/eth-rpc',
  base:     'https://base.blockscout.com/api/eth-rpc',
  arbitrum: 'https://arbitrum.blockscout.com/api/eth-rpc',
}

export function getClient(chainName: string, usePublicRpc = false) {
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

// ─── ABIs ────────────────────────────────────────────────────────────────────
export const AUCTION_ABI = [
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

export const ERC20_ABI = [
  { name: 'name',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { name: 'symbol',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string'  }] },
  { name: 'decimals',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8'   }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export const BID_EVENT = parseAbiItem('event BidSubmitted(uint256 indexed id, address indexed owner, uint256 price, uint128 amount)')

// ─── Chunked getLogs with adaptive retry ─────────────────────────────────────
const LOG_CHUNK_SIZE = 5000n
const MAX_LOG_RANGE = 50000n

export async function getLogsChunked(
  client: ReturnType<typeof getClient>,
  params: { address: `0x${string}`, event: any, fromBlock: bigint, toBlock: bigint },
  uncapped = false,
  chainName?: string,
) {
  const wasCapped = !uncapped && params.toBlock - params.fromBlock > MAX_LOG_RANGE
  const cappedTo = wasCapped ? params.fromBlock + MAX_LOG_RANGE : params.toBlock
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
        if (/too many|429/i.test(msg) && retries < 5) {
          retries++
          await new Promise(r => setTimeout(r, 1000 * retries))
          continue
        }
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
          throw err
        }
        throw err
      }
    }
    return allLogs
  }

  try {
    const logs = await doScan(client, LOG_CHUNK_SIZE)
    if (wasCapped) console.log(`  (scanned first ${MAX_LOG_RANGE} of ${params.toBlock - params.fromBlock} blocks)`)
    return { logs, wasCapped }
  } catch (primaryErr: any) {
    const msg = primaryErr?.details || primaryErr?.message || ''
    if (!chainName || !isRangeError(msg)) throw primaryErr
  }

  console.log(`  Primary RPC failed, trying public RPC fallback...`)
  loggedRangeError = false
  const publicClient = getClient(chainName, true)
  const logs = await doScan(publicClient, LOG_CHUNK_SIZE)
  console.log(`  Scan completed via public RPC fallback`)
  if (wasCapped) console.log(`  (scanned first ${MAX_LOG_RANGE} of ${params.toBlock - params.fromBlock} blocks)`)
  return { logs, wasCapped }
}

// ─── Q96 math ────────────────────────────────────────────────────────────────
const Q96 = 2n ** 96n
export function q96ToDecimal(q96: string | bigint | undefined, decimals = 8): string {
  if (!q96) return '?'
  const big = BigInt(q96)
  const whole = big / Q96
  const frac = big % Q96
  const fracDecimal = (frac * 10n ** BigInt(decimals)) / Q96
  return `${whole}.${fracDecimal.toString().padStart(decimals, '0')}`
}

export function q96ToPrice(q96: string | bigint | undefined, tokenDecimals: number, currencyDecimals: number, displayDecimals = 8): string {
  if (!q96) return '?'
  const big = BigInt(q96)
  const shift = tokenDecimals - currencyDecimals
  const shifted = shift >= 0
    ? big * 10n ** BigInt(shift)
    : big / 10n ** BigInt(-shift)
  return q96ToDecimal(shifted, displayDecimals)
}
