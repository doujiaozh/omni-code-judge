#!/usr/bin/env node
/**
 * omni-judge — CLI launcher.
 *
 * Delegates to the compiled TypeScript entry (dist/src/cli/main.js). If the
 * build is missing or stale, it rebuilds on demand so a fresh clone works
 * right after `npm install`.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const compiled = join(root, 'dist', 'src', 'cli', 'main.js')

if (!existsSync(compiled)) {
  process.stdout.write('ℹ omni-judge: compiled entry missing — building (npm run build)…\n')
  const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (build.status !== 0) {
    process.stderr.write('✖ build failed — run `npm run build` manually, then retry.\n')
    process.exit(1)
  }
}

await import(pathToFileURL(compiled).href)
