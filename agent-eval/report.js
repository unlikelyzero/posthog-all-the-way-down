#!/usr/bin/env node
// Summarizes agent-eval/results.jsonl: successes/trials with a Wilson 95% interval, per task and condition.
//   node agent-eval/report.js [agent-eval/results.jsonl] [--svg out/pilot.svg]
import { readFileSync, writeFileSync } from 'node:fs'

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

// Dot-and-whisker SVG: pass@1 per task, with MCP vs without, Wilson 95% whiskers. The static slide fallback
// for the PostHog dashboard. Colors: categorical slots 1-2 of the dataviz reference palette (validated, light).
const CONDITIONS = [
  { key: 'with-k6-mcp', label: 'with k6 MCP', color: '#2a78d6' },
  { key: 'no-mcp', label: 'shell k6 only', color: '#eb6834' },
]

export function svg(rows) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const tasks = [...new Set(rows.map((r) => r.task))]
  const W = 1200, left = 300, right = 60, top = 90, rowH = 110
  const H = top + tasks.length * rowH + 60
  const x = (p) => left + p * (W - left - right)
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" role="img" aria-label="Agent eval pass rate by task, with and without the k6 MCP">`,
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>`,
  ]
  CONDITIONS.forEach((c, i) => {
    const lx = left + i * 260
    out.push(`<circle cx="${lx + 8}" cy="36" r="8" fill="${c.color}"/><text x="${lx + 24}" y="43" font-size="22" fill="#3d3d3a">${c.label}</text>`)
  })
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(`<line x1="${x(p)}" y1="${top - 10}" x2="${x(p)}" y2="${H - 50}" stroke="#e5e4df" stroke-width="1"/>`)
    out.push(`<text x="${x(p)}" y="${H - 20}" font-size="18" fill="#6b6a63" text-anchor="middle">${p * 100}%</text>`)
  }
  tasks.forEach((task, ti) => {
    const cy = top + ti * rowH + rowH / 2
    out.push(`<text x="${left - 24}" y="${cy + 7}" font-size="22" fill="#1f1f1d" text-anchor="end">${esc(task)}</text>`)
    CONDITIONS.forEach((c, ci) => {
      const rs = rows.filter((r) => r.task === task && r.condition === c.key)
      if (!rs.length) return
      const k = rs.filter((r) => r.pass).length
      const [lo, hi] = wilson(k, rs.length)
      const y = cy + (ci === 0 ? -16 : 16)
      const tip = `${c.label}, ${task}: ${k}/${rs.length} passed, 95% interval ${Math.round(lo * 100)}-${Math.round(hi * 100)}%`
      out.push(
        `<g><title>${esc(tip)}</title>`,
        `<line x1="${x(lo)}" y1="${y}" x2="${x(hi)}" y2="${y}" stroke="${c.color}" stroke-width="2" stroke-linecap="round"/>`,
        `<circle cx="${x(k / rs.length)}" cy="${y}" r="8" fill="${c.color}" stroke="#fcfcfb" stroke-width="2"/>`,
        `<text x="${x(hi) + 14}" y="${y + 6}" font-size="18" fill="#3d3d3a">${k}/${rs.length}</text>`,
        `<rect x="${x(lo) - 10}" y="${y - 14}" width="${x(hi) - x(lo) + 60}" height="28" fill="transparent"/></g>`
      )
    })
  })
  out.push('</svg>')
  return out.join('\n')
}

function main(file, svgFile) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  if (svgFile) writeFileSync(svgFile, svg(rows.filter((r) => r.task)))
  const groups = {}
  for (const r of rows) for (const key of [`${r.task} / ${r.condition}`, `ALL / ${r.condition}`]) (groups[key] ||= []).push(r)
  const pct = (x) => Math.round(x * 100) + '%'
  console.log('pilot: pass@1 as successes/trials, Wilson 95% interval')
  for (const [key, rs] of Object.entries(groups).sort()) {
    const k = rs.filter((r) => r.pass).length
    const [lo, hi] = wilson(k, rs.length)
    const validated = rs.filter((r) => r.validate_before_run).length
    console.log(`${key.padEnd(36)} ${k}/${rs.length}  [${pct(lo)}, ${pct(hi)}]  validate_script before run: ${validated}/${rs.length}`)
  }
}

if (process.argv[2] === '--selftest') {
  const [lo, hi] = wilson(4, 5)
  if (!(Math.abs(lo - 0.3755) < 1e-3 && Math.abs(hi - 0.9638) < 1e-3)) throw new Error(`wilson(4,5) = ${lo}, ${hi}`)
  if (wilson(0, 5)[0] !== 0) throw new Error('wilson(0,5) lower bound')
  console.log('selftest: ok')
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--svg')
  const svgFile = i >= 0 ? args.splice(i, 2)[1] : null
  main(args[0] || 'agent-eval/results.jsonl', svgFile)
}
