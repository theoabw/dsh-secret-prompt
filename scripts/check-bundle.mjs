/**
 * Bundle check for CI.
 *
 * The build keeps every `@deepseek-ai/*` import external, because the host
 * provides those packages at runtime, and the browser half registers itself
 * with the client module loader instead of importing it. CI cannot install the
 * host packages (the published versions do not match the harness this plugin is
 * built against), so this checks that the built output exists, imports only
 * what the host provides, and still registers its client bundle.
 *
 * Run: node scripts/check-bundle.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Entries the package publishes. */
const REQUIRED = ['lib/index.js', 'lib/client.js']

/** Specifiers the host resolves at runtime. */
const HOST_PREFIXES = ['node:', '@deepseek-ai/', './', '../']

for (const file of REQUIRED) {
  const source = readFileSync(file, 'utf8')
  assert.ok(source.length > 0, `${file} is empty`)
}

for (const match of readFileSync('lib/index.js', 'utf8').matchAll(/^\s*import\s[^;\n]*?from\s+"([^"]+)"/gm)) {
  const specifier = match[1]
  assert.ok(
    HOST_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
    `lib/index.js imports "${specifier}", which the host does not provide`,
  )
}

assert.match(
  readFileSync('lib/client.js', 'utf8'),
  /__ModuleLoader__\.load\(/,
  'lib/client.js does not register with the client module loader',
)

console.log('bundle check passed: host-only imports, client bundle registers')
