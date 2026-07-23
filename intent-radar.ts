/**
 * CCA Intent Radar
 *
 * Detects projects ANNOUNCING a CCA launch before on-chain deployment.
 * Polls RSS/Atom feeds, matches dual keyword groups, DMs matches.
 * Runs as its own pm2 process alongside bot-server and cca-collector.
 *
 * Run: npm run intent
 */

import * as dotenv from 'dotenv'
import * as fs from 'fs'
import { checkCrashLoop, writeJsonAtomic, readJsonSafe } from './shared.ts'
dotenv.config()

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID // DM only

const POLL_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

// ─── Feed sources ───────────────────────────────────────────────────────────
const DEFAULT_FEEDS = [
  'https://gov.uniswap.org/latest.rss',
  'https://cryptopanic.com/news/rss/',
]

function getFeeds(): string[] {
  const extra = process.env.INTENT_FEEDS?.split(',').map(s => s.trim()).filter(Boolean) || []
  return [...DEFAULT_FEEDS, ...extra]
}

// ─── Keyword matching ───────────────────────────────────────────────────────
const GROUP_A = ['cca', 'clearing auction', 'continuous clearing', 'uniswap auction']
const GROUP_B = ['launch', 'token sale', 'auction', 'tge', 'raise', 'announce', 'upcoming']

function matchKeywords(text: string): { a: string; b: string } | null {
  const lower = text.toLowerCase()
  const hitA = GROUP_A.find(k => lower.includes(k))
  const hitB = GROUP_B.find(k => lower.includes(k))
  if (hitA && hitB) return { a: hitA, b: hitB }
  return null
}

// ─── Seen-item persistence ──────────────────────────────────────────────────
const SEEN_FILE = 'data/intent-seen.json'

function loadSeen(): Set<string> {
  return new Set(readJsonSafe<string[]>(SEEN_FILE, []))
}

function saveSeen(seen: Set<string>) {
  writeJsonAtomic(SEEN_FILE, [...seen])
}

// ─── Telegram DM ────────────────────────────────────────────────────────────
async function sendDM(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch (err: any) {
    console.error(`Telegram DM failed: ${err.message}`)
  }
}

// ─── Minimal RSS/Atom parser ────────────────────────────────────────────────
interface FeedItem {
  id: string
  title: string
  summary: string
  link: string
  source: string
}

function extractTag(xml: string, tag: string): string {
  // Handles both <tag>content</tag> and <tag><![CDATA[content]]></tag>
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i')
  const m = xml.match(re)
  return m ? m[1].trim() : ''
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i')
  const m = xml.match(re)
  return m ? m[1] : ''
}

function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const items: FeedItem[] = []
  const sourceName = feedUrl.replace(/^https?:\/\//, '').split('/')[0]

  // RSS <item> blocks
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []
  for (const block of rssItems) {
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    const description = extractTag(block, 'description')
    const guid = extractTag(block, 'guid') || link || title
    if (!guid) continue
    items.push({ id: guid, title, summary: description.slice(0, 500), link, source: sourceName })
  }

  // Atom <entry> blocks
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
  for (const block of atomEntries) {
    const title = extractTag(block, 'title')
    const link = extractAttr(block, 'link', 'href') || extractTag(block, 'link')
    const summary = extractTag(block, 'summary') || extractTag(block, 'content')
    const id = extractTag(block, 'id') || link || title
    if (!id) continue
    items.push({ id, title, summary: summary.slice(0, 500), link, source: sourceName })
  }

  return items
}

// ─── Main poll cycle ────────────────────────────────────────────────────────
async function pollFeeds() {
  const feeds = getFeeds()
  const seen = loadSeen()
  let totalScanned = 0
  let matches = 0

  for (const feedUrl of feeds) {
    try {
      const resp = await fetch(feedUrl, {
        headers: { 'User-Agent': 'CCA-Intent-Radar/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!resp.ok) {
        console.log(`  Feed ${feedUrl} returned ${resp.status}`)
        continue
      }
      const xml = await resp.text()
      const items = parseFeed(xml, feedUrl)

      for (const item of items) {
        totalScanned++
        if (seen.has(item.id)) continue

        seen.add(item.id)
        const searchText = `${item.title} ${item.summary}`
        const hit = matchKeywords(searchText)
        if (!hit) continue

        matches++
        console.log(`  MATCH: "${item.title}" [${hit.a} + ${hit.b}]`)

        await sendDM([
          `🔎 <b>CCA Intent Detected</b>`,
          ``,
          `<b>Title:</b> ${item.title}`,
          `<b>Source:</b> ${item.source}`,
          `<b>Link:</b> ${item.link}`,
          `<b>Matched:</b> "${hit.a}" + "${hit.b}"`,
        ].join('\n'))
      }
    } catch (err: any) {
      console.log(`  Feed error (${feedUrl}): ${err.message}`)
    }
  }

  saveSeen(seen)
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] Intent radar: ${totalScanned} items scanned, ${matches} matches, ${feeds.length} feeds`)
}

// ─── Entry point ────────────────────────────────────────────────────────────
async function main() {
  await checkCrashLoop('cca-intent')
  console.log('CCA Intent Radar starting...')
  console.log(`Feeds: ${getFeeds().length}`)
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 60000} min`)
  console.log(`DM target: ${TELEGRAM_CHAT_ID || 'not set'}`)
  console.log('-'.repeat(60))

  // First poll immediately
  await pollFeeds()

  // Then poll on interval
  setInterval(pollFeeds, POLL_INTERVAL_MS)

  // Keep alive
  await new Promise(() => {})
}

main().catch(console.error)
