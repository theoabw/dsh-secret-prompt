/**
 * tsdown build for @tabw/dsh-secret-prompt.
 *
 * The node half (lib/index.js) is an ordinary ESM plugin the dsh host loader
 * imports; every @deepseek-ai/* import stays external and resolves from the
 * dsh install's node_modules (see scripts/link-deps.sh).
 *
 * The browser half replicates the contract the dsh client module system
 * expects from a `dsh.client` bundle (packages/client/tsdown.client.ts in
 * deepseek-harness): a classic script that only REGISTERS its factory via
 * window.__ModuleLoader__.load({ id, factory }), resolves the seeded module
 * table (react, cordis, ui-primitives, ui-slots, client-runtime) through the
 * injected require, and inlines everything else. The bundle is served by the
 * host under /plugins/<id>/client.js and executed at materialization.
 */
import { isBuiltin } from 'node:module'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { readFile } from 'node:fs/promises'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = '@tabw/dsh-secret-prompt'

/** Module-table specifiers the browser half requests (seeded platform rows). */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

/* CSS Modules inlining, ported from the deepseek-harness clientBundle preset:
   `x.module.css` yields its hashed class map and injects a tagged style at
   factory execution (the loader owns style teardown on HMR). */

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(id: string, fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    const exportEntries = Object.entries(cssExports ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    for (const [local, exp] of exportEntries) classMap[local] = exp.name
    return styleInjectionModule(ID, fileId, code.toString(), classMap)
  },
}

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      // The host profile provides every @deepseek-ai runtime dependency; node
      // builtins keep tsdown's own external handling.
      neverBundle: (specifier) => specifier.startsWith('@deepseek-ai/'),
      alwaysBundle: (specifier) => !isBuiltin(specifier) && !specifier.startsWith('@deepseek-ai/'),
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    plugins: [cssModulesPlugin],
    deps: {
      neverBundle: (specifier) => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: (specifier) => !CLIENT_EXTERNALS.has(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
