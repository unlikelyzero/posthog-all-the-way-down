#!/usr/bin/env node
// Inlines a k6 script's local imports into one file, for the k6 MCP: validate_script and run_script copy the
// script to a temp file, so relative imports like './auth.js' can't resolve there.
// run_script can't pass env vars either, so BUNDLE_ENV names variables to bake in as __ENV defaults. Baked
// values (test credentials included) end up in the file: write it under out/, which is gitignored.
//   BUNDLE_ENV=BASE_URL,PH_EMAIL,PH_PASSWORD node k6/bundle.js k6/api.js > out/stage/api.bundle.js
// ponytail: line-based, handles this repo's one-line imports only; use esbuild if the modules grow.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const external = new Set()
const seen = new Set()
function inline(file, entry) {
  if (seen.has(file)) return ''
  seen.add(file)
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^import .* from '(.+)'$/.exec(line)
    if (m && m[1].startsWith('.')) out.unshift(inline(join(dirname(file), m[1]), false))
    else if (m) external.add(line)
    else out.push(entry ? line : line.replace(/^export (?=const|function)/, ''))
  }
  return out.join('\n')
}
const body = inline(process.argv[2], true)
const baked = (process.env.BUNDLE_ENV || '').split(',').filter(Boolean)
  .map((k) => `__ENV[${JSON.stringify(k)}] = __ENV[${JSON.stringify(k)}] || ${JSON.stringify(process.env[k] || '')}`)
console.log([...external, ...baked].join('\n') + '\n' + body)
