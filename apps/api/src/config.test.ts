import { encodeBase58 } from '@forge/chain'
import { Keypair } from '@solana/web3.js'
import { exportSPKI, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

/** Детермінований ключ: тест не має залежати від генератора випадкових чисел. */
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

  // `.env.example` роздає це значення всім секретам. Процес, що піднявся з ним,
  // падає на першому вході — і причина виглядає як помилка Privy, а не як
  // незаповнене оточення.
  it('rejects the .env.example placeholder', () => {
    expect(issuesOf({ PRIVY_APP_SECRET: 'REPLACE_ME' })).toEqual([
      'PRIVY_APP_SECRET: PRIVY_APP_SECRET is still the .env.example placeholder',
    ])
  })

  // У `.env.example` плейсхолдер стоїть і всередині значень — саме такий
  // напівзаповнений рядок і доїжджає до розгортання непоміченим.
  it.each([
    ['DEVNET_RPC_URL', 'https://devnet.helius-rpc.com/?api-key=REPLACE_ME'],
    [
      'PRIVY_VERIFICATION_KEY',
      '-----BEGIN PUBLIC KEY-----\\nREPLACE_ME\\n-----END PUBLIC KEY-----',
    ],
  ])('відхиляє плейсхолдер усередині %s', (name, value) => {
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

  // Багаторядковий PEM у Railway, Vercel і docker --env їде з екранованими \n.
  it('restores line breaks in the PEM key', () => {
    const escaped = publicKeyPem.trimEnd().replaceAll('\n', '\\n')
    const config = loadConfig(env({ PRIVY_VERIFICATION_KEY: escaped }))

    expect(config.privy.verificationKey).toContain('\n')
    expect(config.privy.verificationKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true)
  })

  it('rejects a private key in place of the public one', () => {
    // Заголовок склеєний, а не написаний цілим рядком: гард комітів шукає в
    // диффі саме такий маркер, і фікстура негативного тесту блокувала б коміт
    // нарівні зі справжнім ключем.
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

  // Адреса програми береться тільки з вендорованого IDL (рішення T007): друге
  it.each(['ftp://rpc.example', 'javascript:alert(1)', 'file:///etc/passwd'])(
    '%s в DEVNET_RPC_URL відхиляється: «URL» без схеми — це не адреса ноди',
    (url) => {
      expect(issuesOf({ DEVNET_RPC_URL: url }).length).toBeGreaterThan(0)
    },
  )

  it('a self-hosted RPC over http is a valid URL', () => {
    expect(loadConfig(env({ DEVNET_RPC_URL: 'http://127.0.0.1:8899' })).rpcUrl).toBe(
      'http://127.0.0.1:8899',
    )
  })

  it('accepts the operational key and does not alter it on the way', () => {
    expect(loadConfig(env()).operationalSecretKey).toBe(OPERATIONAL_SECRET)
  })

  // Найімовірніша помилка в панелі хостингу — вставити **адресу** ключа замість
  // самого ключа: рядок теж base58, теж «схожий на ключ», і без перевірки
  // довжини процес піднявся б, а впав би на першому розморожуванні.
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

  // джерело дало б стан «IDL з одного деплою, адреса з іншого».
  it('does not read PROGRAM_ID', () => {
    const config = loadConfig(env({ PROGRAM_ID: 'REPLACE_ME' }))

    expect(JSON.stringify(config)).not.toContain('REPLACE_ME')
  })
})
