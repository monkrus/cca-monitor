# CCA Monitor — Operations Runbook

Quick reference for when something breaks at 11pm.

## Start / Stop / Restart

```bash
# Start all three processes
npm run start:all          # or: pm2 start ecosystem.config.cjs

# Check status
npm run status             # or: pm2 status

# Restart a single process
pm2 restart cca-watch
pm2 restart cca-bot
pm2 restart cca-intent

# Stop everything
pm2 stop all

# Delete all processes (clean slate)
pm2 delete all

# View logs (live tail)
pm2 logs cca-watch --lines 50
pm2 logs cca-bot --lines 50
pm2 logs cca-intent --lines 50
```

## Where Logs Live

| Log | Location |
|-----|----------|
| Watch stdout/stderr | `logs/watch-out.log`, `logs/watch-err.log` |
| Bot stdout/stderr | `logs/bot-out.log`, `logs/bot-err.log` |
| Intent stdout/stderr | `logs/intent-out.log`, `logs/intent-err.log` |
| Crash-loop starts | `logs/starts-cca-watch.log`, `logs/starts-cca-bot.log`, `logs/starts-cca-intent.log` |
| Crash-loop alert times | `logs/last-crash-alert-*.txt` |

## Heartbeat Warnings & Fixes

### Daily heartbeat (9 UTC, DM)

| Symbol | Meaning | Fix |
|--------|---------|-----|
| `💚 WATCHDOG HEARTBEAT` | All chains polled recently | Nothing — all good |
| `⚠️ {chain}: never polled` | Chain RPC failed on startup | Check RPC URL in `.env`, restart: `pm2 restart cca-watch` |
| `⚠️ {chain}: {time}` (stale) | Last poll >1h ago | Transient RPC issue — usually self-heals. If persistent, check RPC provider status |
| `🚦 TRIGGER MET` | 3+ real auctions in trailing 30 days | Start audit outreach (see Trigger Protocol below) |

### Crash-loop alarm

`⚠️ cca-watch is crash-looping` = 5+ restarts in 10 minutes. Throttled to 1 DM per 6 hours.

**Fix:** Check logs (`pm2 logs cca-watch`). Common causes:
- Missing `.env` variable (bot token, RPC URL)
- RPC provider down (switch to public fallback)
- Out of memory (check `pm2 monit`)

### Weekly digest (Monday 9 UTC, DM)

No action needed — informational only. Shows real auctions this week/total, subscribers, channel members, days since last real auction.

## Data Backup & Restore

### Automatic backups
`npm run backup` copies `data/*.json` to `backups/YYYY-MM-DD/`. Schedule nightly at 3 UTC:

```bash
# Add to crontab (crontab -e)
0 3 * * * cd /path/to/cca-monitor && npx tsx backup.ts >> logs/backup.log 2>&1
```

Keeps 14 days, auto-prunes older backups.

### Restore from backup

```bash
# List available backups
ls backups/

# Restore (stop processes first)
pm2 stop all
cp backups/2026-07-05/*.json data/
pm2 restart all
```

### Version-controlled data
`data/results.json` is also tracked in git. After each new real auction detection, commit:

```bash
git add data/results.json data/bidder-index.json
git commit -m "Data: new auction detected"
git push
```

## Re-running Analyze Safely

`npm run analyze` is idempotent — always processes all 15 auctions (4 real + 11 test) and writes the full dataset. Safe to run anytime.

```bash
# Default: analyze all auctions (real + test)
npm run analyze

# Fast mode: analyze only real auctions, upsert into existing file
# (preserves test records — never shrinks the dataset)
npx tsx cca-collector.ts analyze --real-only
```

**After any analyze on the live box:**
```bash
npm run verify-data        # confirms dataset integrity
git add data/*.json && git commit -m "Data: post-analyze update" && git push
```

## When the Intent Radar Fires

You'll get a Telegram DM: `🔎 CCA Intent Detected` with title, source, and link.

**Action:**
1. Open the link — verify it's a genuine CCA announcement, not noise
2. Check if the token is already in `KNOWN_AUCTIONS`
3. If new: note the project name for pitch checklist <!-- TODO: link pitch checklist -->
4. Watch for on-chain deployment (the watch process will catch it automatically)

## Trigger Protocol (🚦)

When the daily heartbeat shows `🚦 TRIGGER MET` (3+ real CCAs in trailing 30 days):

1. CCA velocity is high — market is adopting the mechanism
2. Start audit outreach to projects that might use CCAs
3. Review current dataset for patterns (clearing ratios, hook adoption)
4. Update article/analysis if published

## Process Architecture

```
ecosystem.config.cjs
├── cca-watch    — polls factory for new auctions, tracks bids, daily/weekly DMs
├── cca-bot      — Telegram subscription bot (/start, /subscribe, /stats)
└── cca-intent   — RSS feed scanner for pre-announcement signals
```

All three auto-restart on crash (5s delay, 300MB memory cap). Crash-loop detection alerts via Telegram if 5+ restarts in 10 minutes.
