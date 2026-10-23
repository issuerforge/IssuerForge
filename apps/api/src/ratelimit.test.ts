import { describe, expect, it } from 'vitest'
import { addressFromHeaders, createBucketStore, take, WINDOW_MS } from './ratelimit.ts'

const NOW = 1_800_000_000_000

describe('the token bucket', () => {
  it('a new caller starts with a full minute of allowance', () => {
    const verdict = take(undefined, 3, NOW)
    expect(verdict.allowed).toBe(true)
    expect(verdict.bucket.tokens).toBe(2)
  })

  it('an empty bucket refuses and says when one token returns', () => {
    const verdict = take({ tokens: 0, updatedAt: NOW }, 60, NOW)
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterMs).toBe(1_000)
  })

  it('refills continuously, never past its capacity', () => {
    expect(take({ tokens: 0, updatedAt: NOW }, 60, NOW + 1_000).allowed).toBe(true)
    expect(take({ tokens: 0, updatedAt: NOW }, 60, NOW + 10 * WINDOW_MS).bucket.tokens).toBe(59)
  })

  it('a clock running backwards refills nothing', () => {
    expect(take({ tokens: 0, updatedAt: NOW }, 60, NOW - 5_000).allowed).toBe(false)
  })
})

describe('the bucket store', () => {
  it('serves the stated rate and refuses the next request', () => {
    const store = createBucketStore()
    const verdicts = Array.from({ length: 4 }, () => store.take('ip:a', 3, NOW).allowed)
    expect(verdicts).toEqual([true, true, true, false])
    expect(store.take('ip:b', 3, NOW).allowed).toBe(true)
  })

  it('stays bounded however many addresses a caller invents', () => {
    const store = createBucketStore(100)
    for (let index = 0; index < 1_000; index += 1) store.take(`ip:${index}`, 3, NOW + index)
    expect(store.size).toBeLessThanOrEqual(100)
  })
})

describe('the caller behind Render', () => {
  it('is one hop back from the platform proxy at the end', () => {
    expect(addressFromHeaders('203.0.113.7, 216.24.57.4')).toBe('203.0.113.7')
  })

  it('an address the caller writes in front changes nothing', () => {
    expect(addressFromHeaders('1.2.3.4, 203.0.113.7, 216.24.57.4')).toBe('203.0.113.7')
  })

  it('steps over private hops of our own before counting', () => {
    expect(addressFromHeaders('203.0.113.7, 216.24.57.4, 10.0.0.3')).toBe('203.0.113.7')
  })

  it('a port and IPv6 brackets do not make a new caller', () => {
    expect(addressFromHeaders('[2001:db8::1]:443, 216.24.57.4')).toBe('2001:db8::1')
    expect(addressFromHeaders('203.0.113.7:51234, 216.24.57.4')).toBe('203.0.113.7')
  })

  it('a single hop is the caller; no header is one shared bucket', () => {
    expect(addressFromHeaders('203.0.113.7')).toBe('203.0.113.7')
    expect(addressFromHeaders(undefined)).toBe('unknown')
  })
})
