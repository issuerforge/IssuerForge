// SC-006 is "a third-party script that trusts only on-chain data". The
// script's own code is where that promise can quietly break — one import of
// the api client or the worker's decoder and the verification checks the
// issuer's systems against themselves. This test reads the shipped sources.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const FORBIDDEN_IMPORT = /from '@forge\/(api|worker|db)(\/[^']*)?'/
const HTTP = /\bfetch\(/
/** The one seam to the network: the transport behind `Connection`, to the `--rpc` address only. */
const RPC_SEAM = 'chain.ts'

function shipped(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : shipped(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('the verifier stands apart from the issuer', () => {
  it('ships no import of the api, the worker or the database', () => {
    const files = shipped(SRC)
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files.filter((path) => FORBIDDEN_IMPORT.test(readFileSync(path, 'utf8')))).toEqual([])
  })

  it('makes HTTP requests only through the RPC seam', () => {
    const outside = shipped(SRC).filter(
      (path) => !path.endsWith(RPC_SEAM) && HTTP.test(readFileSync(path, 'utf8')),
    )
    expect(outside).toEqual([])
  })

  it('depends on none of them at run time', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(
      Object.keys(pkg.dependencies).filter((name) => /^@forge\/(api|worker|db)$/.test(name)),
    ).toEqual([])
  })

  it('would notice an import of the worker', () => {
    expect(FORBIDDEN_IMPORT.test("import { x } from '@forge/worker/indexer/decode'")).toBe(true)
    expect(FORBIDDEN_IMPORT.test("import { x } from '@forge/chain'")).toBe(false)
  })
})
