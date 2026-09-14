import { describe, expect, it } from 'vitest'
import { readWebEnv, WebEnvError } from './env'

const good = {
  VITE_API_URL: 'http://localhost:8787',
  VITE_PRIVY_APP_ID: 'clz0privyapp',
  VITE_DEVNET_RPC_URL: 'https://api.devnet.solana.com',
}

const problems = (source: unknown): string[] => {
  try {
    readWebEnv(source)
  } catch (error) {
    if (error instanceof WebEnvError) return [...error.problems]
    throw error
  }
  return []
}

describe('readWebEnv', () => {
  it('accepts a filled environment', () => {
    expect(readWebEnv(good)).toEqual(good)
  })

  it('strips the trailing slash so paths do not double it', () => {
    const env = readWebEnv({ ...good, VITE_API_URL: 'https://api.example.com//' })
    expect(env.VITE_API_URL).toBe('https://api.example.com')
  })

  it('names every missing variable at once, not the first one', () => {
    expect(problems({})).toHaveLength(3)
  })

  it('rejects the .env.example placeholder', () => {
    expect(problems({ ...good, VITE_PRIVY_APP_ID: 'REPLACE_ME' })).toEqual([
      'VITE_PRIVY_APP_ID: VITE_PRIVY_APP_ID is still the .env.example placeholder',
    ])
  })

  it('rejects a placeholder hidden inside a value', () => {
    expect(problems({ ...good, VITE_API_URL: 'https://REPLACE_ME.example.com' })).toHaveLength(1)
  })

  it('rejects an api url that is not a url', () => {
    expect(problems({ ...good, VITE_API_URL: 'localhost:8787' })).toHaveLength(1)
  })

  it('ignores variables it does not read', () => {
    expect(readWebEnv({ ...good, MODE: 'development', DEV: true })).toEqual(good)
  })
})
