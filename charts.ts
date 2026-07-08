/**
 * Article Charts — generates publication-ready PNGs via QuickChart API
 *
 * Run: npm run charts
 * Output: charts/*.png (1600×900, dark background)
 *
 * Data read live from data/results.json and data/bidder-index.json
 */

import * as fs from 'fs'

const WIDTH = 1600
const HEIGHT = 900
const BG_COLOR = '#1a1a2e'
const GRID_COLOR = '#2a2a4a'
const TEXT_COLOR = '#e0e0e0'
const ACCENT = ['#00d4ff', '#ff6b6b', '#ffd93d', '#6bcb77']
const FOOTER = 'data: cca-monitor / github.com/monkrus/cca-monitor'

function loadResults(): any {
  return JSON.parse(fs.readFileSync('data/results.json', 'utf-8'))
}

function loadBidderIndex(): Array<{ address: string; auctionCount: number; auctions: string[] }> {
  return JSON.parse(fs.readFileSync('data/bidder-index.json', 'utf-8'))
}

async function renderChart(config: any, filename: string) {
  const body = {
    version: '2',
    backgroundColor: BG_COLOR,
    width: WIDTH,
    height: HEIGHT,
    chart: config,
  }

  const resp = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    console.error(`  Failed ${filename}: ${resp.status} ${resp.statusText}`)
    return
  }

  fs.mkdirSync('charts', { recursive: true })
  const buffer = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(`charts/${filename}`, buffer)
  console.log(`  charts/${filename} (${(buffer.length / 1024).toFixed(0)} KB)`)
}

const defaultScales = {
  x: { ticks: { color: TEXT_COLOR, font: { size: 14 } }, grid: { color: GRID_COLOR } },
  y: { ticks: { color: TEXT_COLOR, font: { size: 14 } }, grid: { color: GRID_COLOR } },
}

const defaultPlugins = (title: string, subtitle: string) => ({
  title: { display: true, text: title, color: TEXT_COLOR, font: { size: 24, weight: 'bold' as const }, padding: { bottom: 4 } },
  subtitle: { display: true, text: subtitle, color: '#888', font: { size: 15 }, padding: { bottom: 20 } },
  legend: { display: false },
  datalabels: { color: TEXT_COLOR, font: { size: 14, weight: 'bold' as const } },
})

// ─── Chart A: Clearing vs Floor ─────────────────────────────────────────────
async function chartClearingVsFloor(real: any[]) {
  // Filter out wOCT with its astronomical ratio
  const filtered = real.filter(a => {
    const cvf = parseFloat(a.clearingVsFloor)
    return !isNaN(cvf) && cvf < 10000
  })
  const labels = filtered.map((a: any) => a.name)
  const values = filtered.map((a: any) => parseFloat(a.clearingVsFloor) || 0)

  await renderChart({
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{
        label: 'Clearing vs Floor %',
        data: values,
        backgroundColor: ACCENT.slice(0, labels.length),
        borderWidth: 0,
      }],
    },
    options: {
      plugins: {
        ...defaultPlugins(
          'Clearing Price as % of Floor',
          'How far above minimum each CCA cleared — higher = stronger demand'
        ),
        annotation: {
          annotations: [{
            type: 'line',
            mode: 'vertical',
            scaleID: 'x-axis-0',
            value: 100,
            borderColor: '#ff6b6b',
            borderWidth: 2,
            borderDash: [6, 4],
            label: { enabled: true, content: 'floor (100%)', fontColor: '#ff6b6b', position: 'top', fontSize: 12 },
          }],
        },
        datalabels: {
          color: TEXT_COLOR,
          anchor: 'end',
          align: 'right',
          font: { size: 18, weight: 'bold' },
          formatter: (v: number) => `${v.toFixed(0)}%`,
        },
      },
      scales: {
        xAxes: [{ ticks: { fontColor: TEXT_COLOR, fontSize: 14, callback: (v: number) => `${v}%` }, gridLines: { color: GRID_COLOR } }],
        yAxes: [{ ticks: { fontColor: TEXT_COLOR, fontSize: 16, fontStyle: 'bold' }, gridLines: { display: false } }],
      },
    },
  }, 'clearing-vs-floor.png')
}

// ─── Chart B: Bidder Recurrence Funnel ──────────────────────────────────────
async function chartBidderRecurrence(index: any[]) {
  const total = index.length
  const twoPlus = index.filter(e => e.auctionCount >= 2).length
  const threePlus = index.filter(e => e.auctionCount >= 3).length
  const fourPlus = index.filter(e => e.auctionCount >= 4).length

  const labels = ['Total unique', 'In 2+ auctions', 'In 3+ auctions', 'In all 4']
  const values = [total, twoPlus, threePlus, fourPlus]
  const pcts = values.map(v => ((v / total) * 100).toFixed(2))

  await renderChart({
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Addresses',
        data: values,
        backgroundColor: ['#00d4ff', '#ffd93d', '#ff6b6b', '#6bcb77'],
        borderWidth: 0,
      }],
    },
    options: {
      plugins: {
        ...defaultPlugins(
          'Bidder Recurrence Funnel',
          'How many unique addresses bid in multiple CCA auctions'
        ),
        datalabels: {
          color: TEXT_COLOR,
          anchor: 'end',
          align: 'top',
          font: { size: 15, weight: 'bold' },
          formatter: (v: number, ctx: any) => `${v.toLocaleString('en-US')} (${pcts[ctx.dataIndex]}%)`,
        },
      },
      scales: {
        xAxes: [{ ticks: { fontColor: TEXT_COLOR, fontSize: 14 }, gridLines: { display: false } }],
        yAxes: [{ type: 'logarithmic', ticks: { fontColor: TEXT_COLOR, fontSize: 14 }, gridLines: { color: GRID_COLOR } }],
      },
    },
  }, 'bidder-recurrence.png')
}

// ─── Chart C: Repeat-Bidder Share per Auction ───────────────────────────────
async function chartRepeatShare(real: any[]) {
  const labels = real.map((a: any) => a.name)
  const values = real.map((a: any) => {
    const total = a.uniqueBidders || 1
    const repeat = a.repeatBidders || 0
    return parseFloat(((repeat / total) * 100).toFixed(1))
  })

  const colors = labels.map((n: string) => n === 'CAP' ? '#ffd93d' : '#00d4ff')

  await renderChart({
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Repeat bidder %',
        data: values,
        backgroundColor: colors,
        borderWidth: 0,
      }],
    },
    options: {
      plugins: {
        ...defaultPlugins(
          'Repeat-Bidder Share by Auction',
          '% of bidders in each auction who also bid in another CCA'
        ),
        datalabels: {
          color: TEXT_COLOR,
          anchor: 'end',
          align: 'top',
          font: { size: 18, weight: 'bold' },
          formatter: (v: number) => `${v}%`,
        },
      },
      scales: {
        xAxes: [{ ticks: { fontColor: TEXT_COLOR, fontSize: 16, fontStyle: 'bold' }, gridLines: { display: false } }],
        yAxes: [{ ticks: { fontColor: TEXT_COLOR, fontSize: 14, callback: (v: number) => `${v}%` }, gridLines: { color: GRID_COLOR }, scaleLabel: { display: true, labelString: 'repeat bidders %', fontColor: '#888' } }],
      },
    },
  }, 'repeat-share.png')
}

// ─── Chart D: Hook Split ────────────────────────────────────────────────────
async function chartHookSplit(summary: any) {
  const insights = summary.bidderInsights
  if (!insights) { console.log('  No bidderInsights in summary — skipping hook-split'); return }

  const repeatPct = parseFloat(insights.repeatHookedPct)
  const singlePct = parseFloat(insights.singleHookedPct)

  const openRepeat = Math.round((100 - repeatPct) * 10) / 10
  const openSingle = Math.round((100 - singlePct) * 10) / 10

  await renderChart({
    type: 'bar',
    data: {
      labels: ['Repeat bidders (2+ auctions)', 'Single-auction bidders'],
      datasets: [
        { label: 'Hooked (KYC)', data: [repeatPct, singlePct], backgroundColor: '#00d4ff' },
        { label: 'Open (no KYC)', data: [openRepeat, openSingle], backgroundColor: '#ff6b6b' },
      ],
    },
    options: {
      plugins: {
        ...defaultPlugins(
          'Participation in Hooked vs Open Auctions',
          'Do experienced bidders prefer KYC-gated or open auctions?'
        ),
        legend: { display: true, labels: { fontColor: TEXT_COLOR, fontSize: 14 } },
        datalabels: {
          color: TEXT_COLOR,
          font: { size: 18, weight: 'bold' },
          formatter: (v: number) => `${v.toFixed(1)}%`,
        },
      },
      scales: {
        xAxes: [{ stacked: true, ticks: { fontColor: TEXT_COLOR, fontSize: 14 }, gridLines: { display: false } }],
        yAxes: [{ stacked: true, ticks: { fontColor: TEXT_COLOR, fontSize: 14, callback: (v: number) => `${v}%`, max: 100 }, gridLines: { color: GRID_COLOR } }],
      },
    },
  }, 'hook-split.png')
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Generating article charts...\n')

  const data = loadResults()
  const real = (data.auctions as any[]).filter((a: any) => !a.isTest)
  const index = loadBidderIndex()

  await chartClearingVsFloor(real)
  await chartBidderRecurrence(index)
  await chartRepeatShare(real)
  await chartHookSplit(data.summary)

  console.log(`\nDone. ${fs.readdirSync('charts').filter(f => f.endsWith('.png')).length} charts in charts/`)
}

main().catch(console.error)
