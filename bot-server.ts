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
import { checkCrashLoop } from './shared.ts'
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
}

const SUBS_FILE = 'data/subscribers.json'

function loadSubscribers(): Subscriber[] {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'))
  } catch {}
  return []
}

function saveSubscribers(subs: Subscriber[]) {
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2))
}

function isSubscribed(userId: number): Subscriber | null {
  const subs = loadSubscribers()
  const sub = subs.find(s => s.userId === userId)
  if (!sub) return null
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
    `Premium subscribers get <b>auction-end intel</b>: oversubscription ratio, clearing-vs-floor %, bid count, and time remaining — at 24h and 1h before close. Plus instant deployment alerts and live bid tracking.`,
    ``,
    `<b>Free channel:</b> @cca_auctions`,
    `Deployment alerts delayed 30 min. No auction-end intel.`,
    ``,
    `<b>Premium tiers:</b>`,
    `  ${TIERS.pass.label} — ${TIERS.pass.stars} Stars / ${TIERS.pass.days} days`,
    `  ${TIERS.monthly.label} — ${TIERS.monthly.stars} Stars / ${TIERS.monthly.days} days`,
    `  ${TIERS.lifetime.label} — ${TIERS.lifetime.stars} Stars / forever`,
    ``,
    `/subscribe — Choose a plan`,
    `/stats — CCA dataset stats (free)`,
    `/status — Check your subscription`,
    ...(ARTICLE_URL ? [``, `Full analysis: ${ARTICLE_URL}`] : []),
  ].join('\n'))
}

async function handleSubscribe(chatId: number, userId: number) {
  const existing = isSubscribed(userId)
  if (existing) {
    if (existing.tier === 'lifetime') {
      await sendMessage(chatId, `You have <b>Lifetime</b> access. No need to resubscribe!`)
      return
    }
    const expires = new Date(existing.expiresAt)
    await sendMessage(chatId, `You already have an active <b>${TIERS[existing.tier]?.label || 'Premium'}</b> subscription.\n\nExpires: <b>${expires.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</b>`)
    return
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

  // Calculate expiry
  const expiresAt = tier === 'lifetime'
    ? new Date('2099-12-31T23:59:59Z').toISOString()
    : new Date(Date.now() + t.days! * 24 * 60 * 60 * 1000).toISOString()

  // Save subscription
  const subs = loadSubscribers()
  const filtered = subs.filter(s => s.userId !== userId)
  filtered.push({
    userId,
    username,
    firstName,
    tier,
    subscribedAt: new Date().toISOString(),
    expiresAt,
    paymentId,
  })
  saveSubscribers(filtered)

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
    const raw = fs.readFileSync('data/results.json', 'utf-8')
    const parsed = JSON.parse(raw)
    const allAuctions = parsed.auctions || parsed // handle both wrapped and flat formats
    const real = allAuctions.filter((a: any) => !a.isTest)
    const total = real.length
    const graduated = real.filter((a: any) => a.graduated).length
    const chains = [...new Set(real.map((a: any) => a.chain))].length
    const totalBids = real.reduce((s: number, a: any) => s + (a.totalBids || 0), 0)
    const totalBidders = real.reduce((s: number, a: any) => s + (a.uniqueBidders || 0), 0)
    await sendMessage(chatId, [
      `<b>CCA Dataset Stats</b>`,
      ``,
      `Auctions tracked: ${total}`,
      `Graduated: ${graduated}`,
      `Chains: ${chains}`,
      `Total bids: ${totalBids.toLocaleString('en-US')}`,
      `Unique bidders: ${totalBidders.toLocaleString('en-US')}`,
      ``,
      `<i>Updated live from on-chain data.</i>`,
      ...(ARTICLE_URL ? [``, `Full analysis: ${ARTICLE_URL}`] : []),
    ].join('\n'))
  } catch {
    await sendMessage(chatId, `Stats unavailable — run <code>npm run analyze</code> first.`)
  }
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

      // Commands
      if (text === '/start') await handleStart(chatId)
      else if (text === '/subscribe') await handleSubscribe(chatId, userId)
      else if (text === '/status') await handleStatus(chatId, userId)
      else if (text === '/stats') await handleStats(chatId)
    }
  } catch (err: any) {
    console.error(`Poll error: ${err.message}`)
  }
}

// ─── Expiry checker (runs every hour) ───────────────────────────────────────
async function checkExpiries() {
  const subs = loadSubscribers()
  const now = new Date()
  for (const sub of subs) {
    if (sub.tier === 'lifetime') continue
    if (new Date(sub.expiresAt) < now) {
      try {
        await api('banChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId })
        await api('unbanChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId })
        console.log(`Expired: ${sub.username || sub.userId} (${sub.tier})`)
      } catch {}
    }
  }
  const active = subs.filter(s => s.tier === 'lifetime' || new Date(s.expiresAt) >= now)
  if (active.length !== subs.length) saveSubscribers(active)
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
      { command: 'subscribe', description: 'Choose a premium plan' },
      { command: 'stats', description: 'CCA dataset stats (free)' },
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
