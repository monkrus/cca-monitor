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
dotenv.config()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const PREMIUM_CHANNEL_ID = process.env.TELEGRAM_PREMIUM_CHANNEL_ID!
const API = `https://api.telegram.org/bot${BOT_TOKEN}`

// Subscription price in Telegram Stars
const PRICE_STARS = parseInt(process.env.SUBSCRIPTION_PRICE_STARS || '50')
const SUBSCRIPTION_DAYS = parseInt(process.env.SUBSCRIPTION_DAYS || '30')

// ─── Subscriber storage ─────────────────────────────────────────────────────
interface Subscriber {
  userId: number
  username?: string
  firstName?: string
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
    `<b>CCA Monitor Bot</b>`,
    ``,
    `Track every Uniswap Continuous Clearing Auction the moment it deploys.`,
    ``,
    `<b>Free channel:</b> @cca_auctions`,
    `Alerts delayed 30 minutes.`,
    ``,
    `<b>Premium access (${PRICE_STARS} Stars/month):</b>`,
    `  - Instant deployment alerts`,
    `  - Live bid tracking updates`,
    `  - Auction end summaries`,
    `  - Full analysis (supply, raised, clearing ratio)`,
    ``,
    `/subscribe - Get premium access`,
    `/status - Check your subscription`,
  ].join('\n'))
}

async function handleSubscribe(chatId: number, userId: number) {
  const existing = isSubscribed(userId)
  if (existing) {
    const expires = new Date(existing.expiresAt)
    await sendMessage(chatId, `You already have an active subscription!\n\nExpires: <b>${expires.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</b>`)
    return
  }

  await api('sendInvoice', {
    chat_id: chatId,
    title: 'CCA Premium Alerts',
    description: `${SUBSCRIPTION_DAYS}-day access to instant CCA auction alerts, live bid tracking, and full analysis.`,
    payload: `premium_${userId}_${Date.now()}`,
    currency: 'XTR', // Telegram Stars
    prices: [{ label: `${SUBSCRIPTION_DAYS}-Day Premium Access`, amount: PRICE_STARS }],
  })
}

async function handleStatus(chatId: number, userId: number) {
  const sub = isSubscribed(userId)
  if (sub) {
    const expires = new Date(sub.expiresAt)
    const daysLeft = Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    await sendMessage(chatId, [
      `<b>Subscription Active</b>`,
      ``,
      `Expires: ${expires.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
      `Days remaining: ${daysLeft}`,
    ].join('\n'))
  } else {
    await sendMessage(chatId, `No active subscription.\n\nUse /subscribe to get premium access for ${PRICE_STARS} Stars/month.`)
  }
}

async function handleSuccessfulPayment(chatId: number, userId: number, username: string | undefined, firstName: string | undefined, paymentId: string) {
  // Save subscription
  const subs = loadSubscribers()
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Remove old entry if exists
  const filtered = subs.filter(s => s.userId !== userId)
  filtered.push({
    userId,
    username,
    firstName,
    subscribedAt: new Date().toISOString(),
    expiresAt,
    paymentId,
  })
  saveSubscribers(filtered)

  // Create invite link for premium channel
  try {
    const inviteResult = await api('createChatInviteLink', {
      chat_id: PREMIUM_CHANNEL_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 86400, // 24h to use
      name: `sub_${userId}`,
    })

    if (inviteResult.ok) {
      await sendMessage(chatId, [
        `<b>Payment successful! Welcome to Premium.</b>`,
        ``,
        `Your access is active for ${SUBSCRIPTION_DAYS} days.`,
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

  // Notify you
  const adminId = process.env.TELEGRAM_CHAT_ID
  if (adminId) {
    await sendMessage(Number(adminId), `<b>New subscriber!</b>\n\nUser: ${firstName || 'Unknown'} (@${username || 'no_username'})\nID: ${userId}\nExpires: ${expiresAt}`)
  }

  console.log(`New subscriber: ${username || userId} (expires ${expiresAt})`)
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
      allowed_updates: ['message', 'pre_checkout_query'],
    })

    if (!result.ok || !result.result?.length) return

    for (const update of result.result) {
      offset = update.update_id + 1

      // Handle pre-checkout (must respond within 10 seconds)
      if (update.pre_checkout_query) {
        await handlePreCheckout(update.pre_checkout_query.id)
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
        )
        continue
      }

      // Commands
      if (text === '/start') await handleStart(chatId)
      else if (text === '/subscribe') await handleSubscribe(chatId, userId)
      else if (text === '/status') await handleStatus(chatId, userId)
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
    if (new Date(sub.expiresAt) < now) {
      // Try to kick from premium channel
      try {
        await api('banChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId })
        await api('unbanChatMember', { chat_id: PREMIUM_CHANNEL_ID, user_id: sub.userId }) // unban so they can resubscribe
        console.log(`Expired: ${sub.username || sub.userId}`)
      } catch {}
    }
  }
  // Keep only active subs
  const active = subs.filter(s => new Date(s.expiresAt) >= now)
  if (active.length !== subs.length) saveSubscribers(active)
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('CCA Monitor Bot Server starting...')
  console.log(`Premium price: ${PRICE_STARS} Stars / ${SUBSCRIPTION_DAYS} days`)
  console.log(`Premium channel: ${PREMIUM_CHANNEL_ID}`)

  // Set bot commands
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Welcome & info' },
      { command: 'subscribe', description: 'Get premium access' },
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
