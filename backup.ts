/**
 * Data Backup — copies data/*.json to backups/YYYY-MM-DD/, keeps 14 days
 *
 * Usage: npm run backup
 * Schedule: nightly at 3 UTC via cron or pm2
 */

import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = 'data'
const BACKUP_DIR = 'backups'
const KEEP_DAYS = 14

function main() {
  const today = new Date().toISOString().slice(0, 10)
  const destDir = path.join(BACKUP_DIR, today)

  // Create backup
  fs.mkdirSync(destDir, { recursive: true })
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))
  let copied = 0
  for (const file of files) {
    const src = path.join(DATA_DIR, file)
    const dest = path.join(destDir, file)
    fs.copyFileSync(src, dest)
    copied++
  }
  console.log(`Backed up ${copied} files to ${destDir}`)

  // Prune old backups
  if (!fs.existsSync(BACKUP_DIR)) return
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const dirs = fs.readdirSync(BACKUP_DIR).filter(d => {
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff
  })
  for (const dir of dirs) {
    const fullPath = path.join(BACKUP_DIR, dir)
    fs.rmSync(fullPath, { recursive: true })
    console.log(`Pruned old backup: ${dir}`)
  }

  const remaining = fs.readdirSync(BACKUP_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).length
  console.log(`${remaining} backup(s) retained (keeping ${KEEP_DAYS} days)`)
}

main()
