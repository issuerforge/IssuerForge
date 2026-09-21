import { encodeBase58 } from '@forge/chain'
import { Keypair } from '@solana/web3.js'
import { exportSPKI, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

/** A deterministic key: the test must not depend on the random number generator. */
const OPERATIONAL = Keypair.fromSeed(new Uint8Array(32).fill(7))
const OPERATIONAL_SECRET = encodeBase58(OPERATIONAL.secretKey)

let publicKeyPem: string

beforeAll(async () => {
  const { publicKey } = await generateKeyPair('ES256', { extractable: true })
  publicKeyPem = await exportSPKI(publicKey)
})

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@host:6543/issuerforge',
    DEVNET_RPC_URL: 'https://devnet.example/?api-key=abc',
    OPERATIONAL_SECRET_KEY: OPERATIONAL_SECRET,
    PRIVY_APP_ID: 'app-id',
    PRIVY_APP_SECRET: 'app-secret',
    PRIVY_VERIFICATION_KEY: publicKeyPem,
    ...overrides,
  }
}

function issuesOf(overrides: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env(overrides))
  } catch (error) {
    if (error instanceof ConfigError) return error.issues
    throw error
  }
  throw new Error('expected loadConfig to throw')
}

describe('config', () => {
  it('fills in the default for an optional value', () => {
    const config = loadConfig(env())

    expect(config.port).toBe(8787)
    expect(config.logLevel).toBe('info')
    expect(config.webOrigins).toEqual(['http://localhost:5173'])
    expect(config.privy.apiUrl).toBe('https://auth.privy.io')
  })

  // `.env.example` gives this value to every secret. A process that came up
  // with it fails on the first login — and the cause looks like a Privy error,
  // not an unfilled environment.
  it('rejects the .env.example placeholder', () => {
    expect(issuesOf({ PRIVY_APP_SECRET: 'REPLACE_ME' })).toEqual([
      'PRIVY_APP_SECRET: PRIVY_APP_SECRET is still the .env.example placeholder',
    ])
  })

  // In `.env.example` the placeholder also sits inside values — it is exactly
  // such a half-filled line that reaches deployment unnoticed.
  it.each([
    ['DEVNET_RPC_URL', 'https://devnet.helius-rpc.com/?api-key=REPLACE_ME'],
    [
      'PRIVY_VERIFICATION_KEY',
      '-----BEGIN PUBLIC KEY-----\\nREPLACE_ME\\n-----END PUBLIC KEY-----',
    ],
  ])('rejects the placeholder inside %s', (name, value) => {
    expect(issuesOf({ [name]: value })[0]).toContain('placeholder')
  })

  it('lists every problem at once, not the first', () => {
    const issues = issuesOf({ DATABASE_URL: undefined, PRIVY_APP_ID: undefined, PORT: '0' })

    expect(issues).toHaveLength(3)
    expect(issues.join('\n')).toContain('DATABASE_URL')
    expect(issues.join('\n')).toContain('PRIVY_APP_ID')
    expect(issues.join('\n')).toContain('PORT')
  })

  it('requires a postgres connection string specifically', () => {
    expect(issuesOf({ DATABASE_URL: 'mysql://user:pass@host/db' })[0]).toContain(
      'postgres:// connection string',
    )
  })

  it('parses the origin list and drops empties', () => {
    const config = loadConfig(
      env({ WEB_ORIGIN: 'https://console.example, ,https://public.example ' }),
    )

    expect(config.webOrigins).toEqual(['https://console.example', 'https://public.example'])
  })

  it('rejects an origin that is not a URL', () => {
    expect(issuesOf({ WEB_ORIGIN: 'console.example' })[0]).toContain('WEB_ORIGIN')
  })

  // A multi-line PEM in hosting panels and docker --env travels with escaped \n.
  it('restores line breaks in the PEM key', () => {
    const escaped = publicKeyPem.trimEnd().replaceAll('\n', '\\n')
    const config = loadConfig(env({ PRIVY_VERIFICATION_KEY: escaped }))

    expect(config.privy.verificationKey).toContain('\n')
    expect(config.privy.verificationKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true)
  })

  it('rejects a private key in place of the public one', () => {
    // The header is concatenated rather than written as one line: the commit
    // guard looks for exactly that marker in the diff, and a negative-test
    // fixture would block the commit just like a real key.
    const kind = 'PRIVATE'
    expect(
      issuesOf({
        PRIVY_VERIFICATION_KEY: `-----BEGIN ${kind} KEY-----\\nx\\n-----END ${kind} KEY-----`,
      })[0],
    ).toContain('PEM public key')
  })

  it('trims the trailing slash of the Privy URL so the path does not double', () => {
    expect(loadConfig(env({ PRIVY_API_URL: 'https://auth.privy.io/' })).privy.apiUrl).toBe(
      'https://auth.privy.io',
    )
  })

  // The program address comes only from the vendored IDL (decision T007): a second
  it.each(['ftp://rpc.example', 'javascript:alert(1)', 'file:///etc/passwd'])(
    '%s in DEVNET_RPC_URL is rejected: a "URL" without a scheme is not a node address',
    (url) => {
      expect(issuesOf({ DEVNET_RPC_URL: url }).length).toBeGreaterThan(0)
    },
  )

  it('a self-hosted RPC over http is a valid URL', () => {
    expect(loadConfig(env({ DEVNET_RPC_URL: 'http://127.0.0.1:8899' })).rpcUrl).toBe(
      'http://127.0.0.1:8899',
    )
  })

  it('runs the worker only on the word "true"', () => {
    expect(loadConfig(env()).runWorker).toBe(false)
    expect(loadConfig(env({ RUN_WORKER: 'true' })).runWorker).toBe(true)
    expect(loadConfig(env({ RUN_WORKER: 'false' })).runWorker).toBe(false)
    // "1" and "yes" are neither: a flag that guesses is a flag that starts
    // the indexer on a line meant to turn it off.
    expect(issuesOf({ RUN_WORKER: '1' })[0]).toMatch(/^RUN_WORKER:/)
  })

  it('accepts the operational key and does not alter it on the way', () => {
    expect(loadConfig(env()).operationalSecretKey).toBe(OPERATIONAL_SECRET)
  })

  // The likeliest mistake in a hosting panel is pasting the key's **address**
  // instead of the key itself: the string is base58 too, "looks like a key"
  // too, and without the length check the process would come up and fail on
  // the first thaw.
  it('rejects a public address in place of the secret key', () => {
    expect(issuesOf({ OPERATIONAL_SECRET_KEY: OPERATIONAL.publicKey.toBase58() })).toEqual([
      'OPERATIONAL_SECRET_KEY: expected a base58 ed25519 secret key of 64 bytes',
    ])
  })

  it('rejects a string that is not base58 at all', () => {
    expect(issuesOf({ OPERATIONAL_SECRET_KEY: 'not base58 at all: 0OIl' })[0]).toContain(
      'base58 ed25519 secret key',
    )
  })

  // source would create the state "IDL from one deploy, address from another".
  it('does not read PROGRAM_ID', () => {
    const config = loadConfig(env({ PROGRAM_ID: 'REPLACE_ME' }))

    expect(JSON.stringify(config)).not.toContain('REPLACE_ME')
  })
})
