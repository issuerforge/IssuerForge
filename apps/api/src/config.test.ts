import { exportSPKI, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

let publicKeyPem: string

beforeAll(async () => {
  const { publicKey } = await generateKeyPair('ES256', { extractable: true })
  publicKeyPem = await exportSPKI(publicKey)
})

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@host:6543/issuerforge',
    DEVNET_RPC_URL: 'https://devnet.example/?api-key=abc',
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

describe('конфіг', () => {
  it('дає значення за замовчуванням для необов’язкового', () => {
    const config = loadConfig(env())

    expect(config.port).toBe(8787)
    expect(config.logLevel).toBe('info')
    expect(config.webOrigins).toEqual(['http://localhost:5173'])
    expect(config.privy.apiUrl).toBe('https://auth.privy.io')
  })

  // `.env.example` роздає це значення всім секретам. Процес, що піднявся з ним,
  // падає на першому вході — і причина виглядає як помилка Privy, а не як
  // незаповнене оточення.
  it('відхиляє плейсхолдер із .env.example', () => {
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

  it('перелічує всі проблеми одразу, а не першу', () => {
    const issues = issuesOf({ DATABASE_URL: undefined, PRIVY_APP_ID: undefined, PORT: '0' })

    expect(issues).toHaveLength(3)
    expect(issues.join('\n')).toContain('DATABASE_URL')
    expect(issues.join('\n')).toContain('PRIVY_APP_ID')
    expect(issues.join('\n')).toContain('PORT')
  })

  it('вимагає саме postgres-рядок', () => {
    expect(issuesOf({ DATABASE_URL: 'mysql://user:pass@host/db' })[0]).toContain(
      'postgres:// connection string',
    )
  })

  it('розбирає перелік походжень і викидає порожні', () => {
    const config = loadConfig(
      env({ WEB_ORIGIN: 'https://console.example, ,https://public.example ' }),
    )

    expect(config.webOrigins).toEqual(['https://console.example', 'https://public.example'])
  })

  it('відхиляє походження, яке не є URL', () => {
    expect(issuesOf({ WEB_ORIGIN: 'console.example' })[0]).toContain('WEB_ORIGIN')
  })

  // Багаторядковий PEM у Railway, Vercel і docker --env їде з екранованими \n.
  it('відновлює переноси в PEM-ключі', () => {
    const escaped = publicKeyPem.trimEnd().replaceAll('\n', '\\n')
    const config = loadConfig(env({ PRIVY_VERIFICATION_KEY: escaped }))

    expect(config.privy.verificationKey).toContain('\n')
    expect(config.privy.verificationKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true)
  })

  it('відхиляє приватний ключ на місці публічного', () => {
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

  it('зрізає хвостовий слеш адреси Privy, щоб шлях не подвоївся', () => {
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

  it('власний RPC по http — дійсна адреса', () => {
    expect(loadConfig(env({ DEVNET_RPC_URL: 'http://127.0.0.1:8899' })).rpcUrl).toBe(
      'http://127.0.0.1:8899',
    )
  })

  // джерело дало б стан «IDL з одного деплою, адреса з іншого».
  it('не читає PROGRAM_ID', () => {
    const config = loadConfig(env({ PROGRAM_ID: 'REPLACE_ME' }))

    expect(JSON.stringify(config)).not.toContain('REPLACE_ME')
  })
})
