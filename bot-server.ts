/**
 * CCA Monitor Telegram Bot Server
 *
 * Handles subscription payments via Telegram Stars.
 * Runs alongside the monitor (separate pm2 process).
 *
 * Commands:
 *   /start    — Welcome + info
 *   /subscribe — Pay for premium access
 *   /status   — Check subscription status
 */

import * as dotenv from 'dotenv'
import * as fs from 'fs'
import { checkCrashLoop, writeJsonAtomic, readJsonSafe } from './shared.ts'
dotenv.config()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const PREMIUM_CHANNEL_ID = process.env.TELEGRAM_PREMIUM_CHANNEL_ID!
const ARTICLE_URL = process.env.ARTICLE_URL || ''
const API = `https://api.telegram.org/bot${BOT_TOKEN}`

// ─── Pricing tiers ──────────────────────────────────────────────────────────
const TIERS = {
  pass:     { label: 'Auction Pass',  stars: 100,  days: 14,   description: '14-day access to instant CCA alerts and auction-end intel.' },
  monthly:  { label: 'Monthly',       stars: 250,  days: 30,   description: '30-day access to instant CCA alerts, bid tracking, and auction-end intel.' },
  lifetime: { label: 'Lifetime',      stars: 1000, days: null,  description: 'Permanent access to all CCA premium alerts. Never expires.' },
} as const
type TierKey = keyof typeof TIERS

// ─── Subscriber storage ─────────────────────────────────────────────────────
interface Subscriber {
  userId: number
  username?: string
  firstName?: string
  tier: TierKey
  subscribedAt: string
  expiresAt: string
  paymentId: string
  status?: 'active' | 'expired' | 'refunded'
}

const SUBS_FILE = 'data/subscribers.json'

function loadSubscribers(): Subscriber[] {
  return readJsonSafe<Subscriber[]>(SUBS_FILE, [])
}

function saveSubscribers(subs: Subscriber[]) {
  writeJsonAtomic(SUBS_FILE, subs)
}

function isSubscribed(userId: number): Subscriber | null {
  const subs = loadSubscribers()
  const sub = subs.find(s => s.userId === userId && s.status !== 'refunded')
  if (!sub) return null
  if (sub.status === 'expired') return null
  if (sub.tier === 'lifetime') return sub
  if (new Date(sub.expiresAt) < new Date()) return null
  return sub
}

// ─── Telegram API helpers ───────────────────────────────────────────────────
async function api(method: string, body?: Record<string, any>) {
  const resp = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return resp.json() as Promise<any>
}

async function sendMessage(chatId: number | string, text: string, extra?: Record<string, any>) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })
}

// ─── Command handlers ───────────────────────────────────────────────────────
async function handleStart(chatId: number) {
  await sendMessage(chatId, [
    `<b>CCA Monitor</b>`,
    ``,
    `Know how every Uniswap CCA ends before the crowd does.`,
    ``,
    `<b>What premium subscribers see:</b>`,
    `  Instant new-auction alerts (free gets 30-min delay)`,
    `  Live bid tracking with whale alerts`,
    `  Auction-end intel at 24h and 1h before close`,
    `  Price movement alerts for graduated tokens`,
    ``,
    `<b>Free channel:</b> @cca_auctions`,
    `Deployment alerts delayed 30 min. No bid tracking or intel.`,
    ``,
    `<b>Commands:</b>`,
    `/auction — Current live auction status`,
    `/bid — Bid placement helper (premium)`,
    `/stats — CCA dataset stats`,
    `/sample — See a sample premium alert`,
    `/subscribe — Choose a premium plan`,
    `/status — Check your subscription`,
    ...(ARTICLE_URL ? [``, `Full analysis: ${ARTICLE_URL}`] : []),
  ].join('\n'))
}

async function handleSubscribe(chatId: number, userId: number) {
  const existing = isSubscribed(userId)
  if (existing?.tier === 'lifetime') {
    await sendMessage(chatId, `You have <b>Lifetime</b> access. No need to resubscribe!`)
    return
  }

  if (existing) {
    const expires = new Date(existing.expiresAt)
    const daysLeft = Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    await sendMessage(chatId, `You have an active <b>${TIERS[existing.tier]?.label || 'Premium'}</b> subscription (${daysLeft} days left).\n\nYou can renew now — the new time will be added to your remaining days.`)
  }

  await sendMessage(chatId, `<b>Choose your plan:</b>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `${TIERS.pass.label} — ${TIERS.pass.stars} Stars (${TIERS.pass.days}d)`, callback_data: 'tier_pass' }],
        [{ text: `${TIERS.monthly.label} — ${TIERS.monthly.stars} Stars (${TIERS.monthly.days}d)`, callback_data: 'tier_monthly' }],
        [{ text: `${TIERS.lifetime.label} — ${TIERS.lifetime.stars} Stars (forever)`, callback_data: 'tier_lifetime' }],
      ],
    },
  })
}

async function handleTierCallback(callbackQueryId: string, chatId: number, userId: number, tier: TierKey) {
  await api('answerCallbackQuery', { callback_query_id: callbackQueryId })
  const t = TIERS[tier]
  await api('sendInvoice', {
    chat_id: chatId,
    title: `CCA Premium — ${t.label}`,
    description: t.description,
    payload: `${tier}_${userId}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: t.label, amount: t.stars }],
  })
}

async function handleStatus(chatId: number, userId: number) {
  const sub = isSubscribed(userId)
  if (sub) {
    const tierLabel = TIERS[sub.tier]?.label || 'Premium'
    if (sub.tier === 'lifetime') {
      await sendMessage(chatId, [
        `<b>Subscription Active</b>`,
        ``,
        `Tier: ${tierLabel}`,
        `Expires: never`,
      ].join('\n'))
    } else {
      const expires = new Date(sub.expiresAt)
      const daysLeft = Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      await sendMessage(chatId, [
        `<b>Subscription Active</b>`,
        ``,
        `Tier: ${tierLabel}`,
        `Expires: ${expires.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
        `Days remaining: ${daysLeft}`,
      ].join('\n'))
    }
  } else {
    await sendMessage(chatId, `No active subscription.\n\nUse /subscribe to choose a plan.`)
  }
}

async function handleSuccessfulPayment(chatId: number, userId: number, username: string | undefined, firstName: string | undefined, paymentId: string, invoicePayload: string) {
  // Parse tier from payload (e.g. "monthly_12345_1699999999")
  const tierKey = (invoicePayload.split('_')[0] || 'monthly') as TierKey
  const tier = TIERS[tierKey] ? tierKey : 'monthly' as TierKey
  const t = TIERS[tier]

  // Calculate expiry — extend if there's remaining time
  let expiresAt: string
  if (tier === 'lifetime') {
    expiresAt = new Date('2099-12-31T23:59:59Z').toISOString()
  } else {
    const existing = isSubscribed(userId)
    const base = existing && new Date(existing.expiresAt) > new Date()
      ? new Date(existing.expiresAt).getTime()
      : Date.now()
    expiresAt = new Date(base + t.days! * 24 * 60 * 60 * 1000).toISOString()
  }

  // Save subscription (keep old records for history)
  const subs = loadSubscribers()
  for (const s of subs) {
    if (s.userId === userId && s.status !== 'refunded') {
      s.status = 'expired'
    }
  }
  subs.push({
    userId,
    username,
    firstName,
    tier,
    subscribedAt: new Date().toISOString(),
    expiresAt,
    paymentId,
    status: 'active',
  })
  saveSubscribers(subs)

  const durationText = tier === 'lifetime' ? 'forever' : `${t.days} days`

  // Create invite link for premium channel
  try {
    const inviteResult = await api('createChatInviteLink', {
      chat_id: PREMIUM_CHANNEL_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 86400,
      name: `sub_${userId}`,
    })

    if (inviteResult.ok) {
      await sendMessage(chatId, [
        `<b>Payment successful! Welcome to Premium.</b>`,
        ``,
        `Plan: <b>${t.label}</b>`,
        `Access: ${durationText}`,
        ``,
        `Join the premium channel:`,
        `${inviteResult.result.invite_link}`,
        ``,
        `<i>This link expires in 24 hours and can only be used once.</i>`,
      ].join('\n'))
    } else {
      await sendMessage(chatId, `Payment received! Contact @monkrus for your invite link.`)
    }
  } catch {
    await sendMessage(chatId, `Payment received! Contact @monkrus for your invite link.`)
  }

  // Notify admin
  const adminId = process.env.TELEGRAM_CHAT_ID
  if (adminId) {
    await sendMessage(Number(adminId), `<b>New subscriber!</b>\n\nUser: ${firstName || 'Unknown'} (@${username || 'no_username'})\nID: ${userId}\nTier: ${t.label}\nExpires: ${tier === 'lifetime' ? 'never' : expiresAt}`)
  }

  console.log(`New subscriber: ${username || userId} — ${t.label} (expires ${tier === 'lifetime' ? 'never' : expiresAt})`)
}

// ─── /stats command (free) ──────────────────────────────────────────────────
async function handleStats(chatId: number) {
  try {
    const parsed = readJsonSafe('data/results.json', { auctions: [] as any[] })
    const allAuctions = parsed.auctions || parsed
    const real = allAuctions.filter((a: any) => !a.isTest)
    const total = real.length
    const graduated = real.filter((a: any) => a.graduated).length
    const chains = [...new Set(real.map((a: any) => a.chain))].length
    const totalBids = real.reduce((s: number, a: any) => s + (a.totalBids || 0), 0)
    const totalBidders = real.reduce((s: number, a: any) => s + (a.uniqueBidders || 0), 0)
    const avgBidders = total > 0 ? Math.round(totalBidders / total) : 0
    const gradRate = total > 0 ? Math.round((graduated / total) * 100) : 0
    await sendMessage(chatId, [
      `<b>CCA Dataset Stats</b>`,
      ``,
      `Auctions tracked: <b>${total}</b>`,
      `Graduated: <b>${graduated}</b> (${gradRate}% success rate)`,
      `Chains: ${chains}`,
      `Total bids: ${totalBids.toLocaleString('en-US')}`,
      `Unique bidders: ${totalBidders.toLocaleString('en-US')} (avg ${avgBidders}/auction)`,
      ``,
      `<i>Updated live from on-chain data.</i>`,
      ``,
      `Premium subscribers get instant alerts, bid tracking, and auction-end intel.`,
      `/subscribe — Choose a plan`,
      ...(ARTICLE_URL ? [``, `Full analysis: ${ARTICLE_URL}`] : []),
    ].join('\n'))
  } catch {
    await sendMessage(chatId, `Stats unavailable — run <code>npm run analyze</code> first.`)
  }
}

// ─── /auction command (free — live auction status) ───────────────────────────
async function handleAuction(chatId: number) {
  const parsed = readJsonSafe('data/results.json', { auctions: [] as any[] })
  const allAuctions = parsed.auctions || parsed
  const real = allAuctions.filter((a: any) => !a.isTest)

  // Find active auctions (not graduated, endBlock in the future or recent)
  const active = real.filter((a: any) => !a.graduated && a.totalBids !== undefined)
  // Also find the most recent completed auction for context
  const completed = real.filter((a: any) => a.graduated || a.totalBids > 0)

  if (active.length === 0 && completed.length === 0) {
    await sendMessage(chatId, [
      `<b>No Active Auctions</b>`,
      ``,
      `There are no CCA auctions running right now.`,
      `You'll be alerted when a new one launches.`,
      ``,
      `<b>Free channel:</b> @cca_auctions (30-min delay)`,
      `<b>Instant alerts:</b> /subscribe`,
    ].join('\n'))
    return
  }

  const lines: string[] = []

  if (active.length > 0) {
    for (const a of active) {
      const label = a.tokenSymbol || a.name
      const chain = a.chain || '?'
      lines.push(
        `<b>${label}</b> (${chain})`,
        ``,
        `Status: ${a.totalBids > 0 ? 'Accepting bids' : 'Open — no bids yet'}`,
        `Total bids: ${(a.totalBids || 0).toLocaleString('en-US')}`,
        `Unique bidders: ${(a.uniqueBidders || 0).toLocaleString('en-US')}`,
        `Duration: ${Math.round((a.durationHours || 0) / 24)} days`,
      )
      if (a.clearingPrice && a.clearingPrice !== '0.00000000') {
        lines.push(`Clearing price: ${a.clearingPrice} ${a.currencySymbol || ''}`)
      }
      lines.push(``)
    }
    lines.push(
      `<i>Premium subscribers see: whale alerts, bid velocity, and auction-end intel with clearing predictions.</i>`,
      `/subscribe — Get the full picture`,
    )
  } else {
    // No active, show latest completed
    const latest = completed[completed.length - 1]
    const label = latest.tokenSymbol || latest.name
    lines.push(
      `<b>No Active Auctions</b>`,
      ``,
      `Last completed: <b>${label}</b> (${latest.chain})`,
      `Result: ${latest.graduated ? 'Graduated' : 'Did not graduate'}`,
      `Final bids: ${(latest.totalBids || 0).toLocaleString('en-US')}`,
      `Unique bidders: ${(latest.uniqueBidders || 0).toLocaleString('en-US')}`,
      ``,
      `You'll be alerted when a new auction launches.`,
      `<b>Free:</b> @cca_auctions | <b>Instant:</b> /subscribe`,
    )
  }

  await sendMessage(chatId, lines.join('\n'))
}

// ─── /sample command (free — sample premium alert) ───────────────────────────
async function handleSample(chatId: number) {
  const sampleAlert = [
    `<b>Here's what premium alerts look like:</b>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `<b>New Auction Alert (instant):</b>`,
    ``,
    `  🚨 <b>NEW CCA DETECTED</b>`,
    `  Token: EXAMPLE`,
    `  Chain: Ethereum`,
    `  Duration: 7 days`,
    `  Floor price: 0.00005000 ETH`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `<b>Whale Bid Alert:</b>`,
    ``,
    `  🐋 <b>Whale Bid — EXAMPLE</b>`,
    `  Amount: 50.00 ETH`,
    `  Bidder: 0x1a2b...3c4d`,
    `  Total bids: 342`,
    `  Bidders: 189`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `<b>Auction-End Intel (24h before close):</b>`,
    ``,
    `  ⏳ <b>EXAMPLE — 24h Left</b>`,
    `  Clearing: 0.00012 ETH (240% of floor)`,
    `  Raised: 1,250.00 ETH`,
    `  Bids: 892 from 456 bidders`,
    `  Verdict: likely to graduate`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Free channel gets deployment alerts with a 30-min delay.`,
    `Premium gets everything above — instantly.`,
    ``,
    `/subscribe — Start from ${TIERS.pass.stars} Stars`,
  ].join('\n')

  await sendMessage(chatId, sampleAlert)
}

// ─── /bid command (premium — bid placement helper) ───────────────────────────
async function handleBid(chatId: number, userId: number) {
  const sub = isSubscribed(userId)
  if (!sub) {
    await sendMessage(chatId, [
      `<b>Bid Placement Helper</b> (Premium)`,
      ``,
      `This tool analyzes historical CCA data to suggest optimal bid ranges for live auctions.`,
      ``,
      `What you get:`,
      `  Conservative / moderate / aggressive ranges`,
      `  Clearing/floor ratio analysis by auction type`,
      `  Concentration metrics (HHI, top-5 share)`,
      `  Sizing guidance based on bidder patterns`,
      ``,
      `<i>Available to premium subscribers only.</i>`,
      `/subscribe — Unlock from ${TIERS.pass.stars} Stars`,
    ].join('\n'))
    return
  }

  const parsed = readJsonSafe('data/results.json', { auctions: [] as any[] })
  const allAuctions = parsed.auctions || parsed
  const real = allAuctions.filter((a: any) => !a.isTest && a.graduated)

  // Parse clearing/floor ratios
  const withRatios = real.map((a: any) => {
    const m = (a.clearingVsFloor || '').match(/([\d.]+)%/)
    return { ...a, ratio: m ? parseFloat(m[1]) : null }
  }).filter((a: any) => a.ratio !== null)

  if (withRatios.length === 0) {
    await sendMessage(chatId, `No graduated auctions with clearing data yet.`)
    return
  }

  const ratios = withRatios.map((a: any) => a.ratio as number).sort((a, b) => a - b)
  const min = ratios[0]
  const max = ratios[ratios.length - 1]
  const median = ratios.length % 2 === 0
    ? (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
    : ratios[Math.floor(ratios.length / 2)]

  const hookedRatios = withRatios.filter((a: any) => a.hasValidationHook).map((a: any) => a.ratio as number)
  const openRatios = withRatios.filter((a: any) => !a.hasValidationHook).map((a: any) => a.ratio as number)
  const hookedAvg = hookedRatios.length > 0 ? hookedRatios.reduce((s, r) => s + r, 0) / hookedRatios.length : null
  const openAvg = openRatios.length > 0 ? openRatios.reduce((s, r) => s + r, 0) / openRatios.length : null

  const conservative = min * 0.95
  const aggressive = max * 1.1

  // Concentration data
  const withConc = withRatios.filter((a: any) => a.concentration)
  let concLines: string[] = []
  if (withConc.length > 0) {
    concLines = [
      ``,
      `<b>Concentration:</b>`,
      ...withConc.map((a: any) => {
        const c = a.concentration
        return `  ${a.name}: HHI=${c.hhi} | Top-5=${c.top5Pct}% | Late=${c.lateBidPct}%`
      }),
    ]
  }

  // Find active auctions for context
  const active = allAuctions.filter((a: any) => !a.isTest && !a.graduated && a.totalBids !== undefined)
  const activeLine = active.length > 0
    ? `\n<b>Active now:</b> ${active.map((a: any) => a.tokenSymbol || a.name).join(', ')}`
    : '\n<i>No active auctions right now.</i>'

  await sendMessage(chatId, [
    `<b>Bid Placement Helper</b>`,
    ``,
    `<b>Historical Clearing/Floor Ratios:</b>`,
    ...withRatios.map((a: any) => {
      const hook = a.hasValidationHook ? 'KYC' : 'Open'
      return `  ${a.name}: <b>${a.ratio.toFixed(1)}%</b> (${hook}, ${a.currencySymbol})`
    }),
    ``,
    `<b>Recommended Ranges</b> (% of floor price):`,
    ``,
    `  <b>Conservative</b> (max value):`,
    `  ${conservative.toFixed(0)}–${min.toFixed(0)}% of floor`,
    `  <i>Risk: may not fill if clearing is higher</i>`,
    ``,
    `  <b>Moderate</b> (balanced):`,
    `  ${min.toFixed(0)}–${median.toFixed(0)}% of floor`,
    `  <i>Based on historical median</i>`,
    ``,
    `  <b>Aggressive</b> (max fill chance):`,
    `  ${median.toFixed(0)}–${aggressive.toFixed(0)}% of floor`,
    `  <i>Covers full historical range + 10%</i>`,
    ...(hookedAvg !== null && openAvg !== null ? [
      ``,
      `<b>By auction type:</b>`,
      `  KYC/hooked avg: ${hookedAvg.toFixed(1)}% (${hookedRatios.length} auctions)`,
      `  Open avg: ${openAvg.toFixed(1)}% (${openRatios.length} auctions)`,
    ] : []),
    ...concLines,
    ``,
    `<b>Tips:</b>`,
    `  Place 2-3 bids at different price levels`,
    `  CCA is uniform-price — all winners pay the same clearing price`,
    `  Bidding higher only increases fill probability, not cost`,
    activeLine,
    ``,
    `<i>Based on ${withRatios.length} graduated auctions. Past ratios don't predict future ones.</i>`,
  ].join('\n'))
}

// ─── Pre-checkout handler (required by Telegram) ────────────────────────────
async function handlePreCheckout(preCheckoutQueryId: string) {
  await api('answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok: true,
  })
}

// ─── Polling loop ───────────────────────────────────────────────────────────
let offset = 0

async function poll() {
  try {
    const result = await api('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['message', 'pre_checkout_query', 'callback_query'],
    })

    if (!result.ok || !result.result?.length) return

    for (const update of result.result) {
      offset = update.update_id + 1

      // Handle pre-checkout (must respond within 10 seconds)
      if (update.pre_checkout_query) {
        await handlePreCheckout(update.pre_checkout_query.id)
        continue
      }

      // Handle tier selection callback
      if (update.callback_query) {
        const cb = update.callback_query
        const data = cb.data as string
        if (data?.startsWith('tier_')) {
          const tier = data.replace('tier_', '') as TierKey
          if (TIERS[tier]) {
            await handleTierCallback(cb.id, cb.message.chat.id, cb.from.id, tier)
          }
        }
        continue
      }

      const msg = update.message
      if (!msg) continue

      const chatId = msg.chat.id
      const userId = msg.from?.id
      const text = msg.text?.trim()

      // Successful payment
      if (msg.successful_payment) {
        await handleSuccessfulPayment(
          chatId,
          userId,
          msg.from?.username,
          msg.from?.first_name,
          msg.successful_payment.telegram_payment_charge_id,
          msg.successful_payment.invoice_payload,
        )
        continue
      }

      // Refunded payment
      if (msg.refunded_payment) {
        const subs = loadSubscribers()
        const refundChargeId = msg.refunded_payment.telegram_payment_charge_id
        for (const s of subs) {
          if (s.paymentId === refundChargeId) {
            s.status = 'refunded'
          }
        }
        saveSubscribers(subs)
        console.log(`Refund processed: user ${userId}, charge ${refundChargeId}`)
        try {
          await api('banChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: userId })
          await api('unbanChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: userId })
        } catch {}
        continue
      }

      // Commands
      if (text === '/start') await handleStart(chatId)
      else if (text === '/subscribe') await handleSubscribe(chatId, userId)
      else if (text === '/status') await handleStatus(chatId, userId)
      else if (text === '/stats') await handleStats(chatId)
      else if (text === '/auction') await handleAuction(chatId)
      else if (text === '/sample') await handleSample(chatId)
      else if (text === '/bid') await handleBid(chatId, userId)
    }
  } catch (err: any) {
    console.error(`Poll error: ${err.message}`)
    await new Promise(r => setTimeout(r, 5000))
  }
}

// ─── Expiry checker (runs every hour) ───────────────────────────────────────
async function checkExpiries() {
  const subs = loadSubscribers()
  const now = new Date()
  let changed = false
  for (const sub of subs) {
    if (sub.tier === 'lifetime') continue
    if (sub.status === 'expired' || sub.status === 'refunded') continue
    if (new Date(sub.expiresAt) < now) {
      try {
        await api('banChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId })
        await api('unbanChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId })
        console.log(`Expired: ${sub.username || sub.userId} (${sub.tier})`)
      } catch {}
      sub.status = 'expired'
      changed = true
    }
  }
  if (changed) saveSubscribers(subs)
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  await checkCrashLoop('cca-bot')
  console.log('CCA Monitor Bot Server starting...')
  console.log(`Tiers: ${Object.entries(TIERS).map(([k, t]) => `${t.label}=${t.stars}*`).join(', ')}`)
  console.log(`Premium channel: ${PREMIUM_CHANNEL_ID}`)

  // Set bot commands
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Welcome & info' },
      { command: 'auction', description: 'Live auction status' },
      { command: 'bid', description: 'Bid placement helper (premium)' },
      { command: 'stats', description: 'CCA dataset stats' },
      { command: 'sample', description: 'See a sample premium alert' },
      { command: 'subscribe', description: 'Choose a premium plan' },
      { command: 'status', description: 'Check subscription status' },
    ],
  })

  console.log('Bot is running. Listening for commands...\n')

  // Poll loop
  while (true) {
    await poll()
  }
}

// Check expiries every hour
setInterval(checkExpiries, 60 * 60 * 1000)

main().catch(console.error)
