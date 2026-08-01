/**
 * Watchdog — checks pm2 processes every 5 minutes.
 * If any of the monitored processes are stopped/errored, restarts them
 * and sends a Telegram alert. Runs as a pm2 process itself.
 */

import { execSync } from 'child_process'
import * as dotenv from 'dotenv'

dotenv.config()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID
const CHECK_INTERVAL = 5 * 60_000 // 5 minutes
const ALERT_COOLDOWN = 60 * 60_000 // 1 hour between repeated alerts
const MONITORED = ['cca-watch', 'cca-bot', 'cca-intent']

let lastAlertTime = 0
let lastAlertMessage = ''

async function sendAlert(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[watchdog] No Telegram credentials — alert not sent:', text)
    return
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    })
    if (!res.ok) console.error('[watchdog] Telegram error:', await res.text())
  } catch (e) {
    console.error('[watchdog] Failed to send alert:', e)
  }
}

interface Pm2Process {
  name: string
  pm2_env: { status: string }
}

function checkAndRestart() {
  let processes: Pm2Process[]
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 30_000 })
    processes = JSON.parse(raw)
  } catch (e: any) {
    // ETIMEDOUT is transient on Windows under load — skip silently
    if (e?.code === 'ETIMEDOUT') {
      console.log('[watchdog] pm2 jlist timed out, will retry next cycle')
      return
    }
    console.error('[watchdog] Failed to read pm2 status:', e)
    const msg = 'pm2-read-fail'
    if (msg !== lastAlertMessage || Date.now() - lastAlertTime > ALERT_COOLDOWN) {
      sendAlert('⚠️ <b>Watchdog:</b> Cannot read pm2 process list — pm2 may be down.')
      lastAlertTime = Date.now()
      lastAlertMessage = msg
    }
    return
  }

  const down: string[] = []
  const missing: string[] = []

  for (const name of MONITORED) {
    const proc = processes.find(p => p.name === name)
    if (!proc) {
      missing.push(name)
    } else if (proc.pm2_env.status !== 'online') {
      down.push(`${name} (${proc.pm2_env.status})`)
    }
  }

  if (down.length === 0 && missing.length === 0) {
    return // all healthy
  }

  const problems = [...down, ...missing.map(n => `${n} (not found)`)].join(', ')
  console.log(`[watchdog] Problems detected: ${problems}`)

  // Restart everything via ecosystem config
  try {
    execSync('pm2 start ecosystem.config.cjs', { encoding: 'utf-8', timeout: 30_000 })
    console.log('[watchdog] Restarted processes')
  } catch (e) {
    console.error('[watchdog] Restart failed:', e)
  }

  if (problems !== lastAlertMessage || Date.now() - lastAlertTime > ALERT_COOLDOWN) {
    sendAlert(
      `⚠️ <b>CCA Watchdog</b>\n\n` +
      `Processes down: <code>${problems}</code>\n\n` +
      `Auto-restart triggered.`
    )
    lastAlertTime = Date.now()
    lastAlertMessage = problems
  }
}

// Initial check
console.log('[watchdog] Starting — checking every 5 min')
console.log(`[watchdog] Monitoring: ${MONITORED.join(', ')}`)
console.log(`[watchdog] Telegram alerts: ${BOT_TOKEN && CHAT_ID ? 'enabled' : 'DISABLED (no credentials)'}`)
checkAndRestart()

// Periodic check
setInterval(checkAndRestart, CHECK_INTERVAL)
