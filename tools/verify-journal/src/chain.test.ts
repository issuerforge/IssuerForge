import { afterEach, describe, expect, it, vi } from 'vitest'
import { patientFetch } from './chain.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function answers(...statuses: number[]) {
  const calls: number[] = []
  vi.stubGlobal('fetch', async () => {
    const status = statuses[calls.length] ?? 200
    calls.push(status)
    return new Response('{}', { status, headers: { 'retry-after': '0.01' } })
  })
  return calls
}

describe('patientFetch', () => {
  it('waits out a 429 and a 503 instead of giving the read up', async () => {
    const calls = answers(429, 503, 200)
    const response = await patientFetch(1000)('https://rpc.example')
    expect(response.status).toBe(200)
    expect(calls).toEqual([429, 503, 200])
  })

  it('returns a client error at once — it is an answer, not throttling', async () => {
    const calls = answers(400)
    expect((await patientFetch(1000)('https://rpc.example')).status).toBe(400)
    expect(calls).toEqual([400])
  })

  it('gives the last answer back when the node never relents', async () => {
    const calls = answers(429, 429, 429)
    expect((await patientFetch(1000, 3)('https://rpc.example')).status).toBe(429)
    expect(calls).toHaveLength(3)
  })
})
