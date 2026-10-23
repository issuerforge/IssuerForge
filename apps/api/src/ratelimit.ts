// A per-address limit for the routes nobody logs into (PLAN → "Rate limit").
//
// Counted in this process, in memory, and that is exact rather than
// approximate for one reason: the free Render plan runs one instance. With
// two, each would count its own callers and the effective limit would double.
//
// A token bucket rather than a counter per calendar minute: a counter lets a
// caller spend a whole minute's allowance at the end of one window and again
// at the start of the next. The bucket refills continuously, so the average
// is the stated rate and the burst is the capacity.
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from './env.ts'
import { rateLimited } from './errors.ts'

export const WINDOW_MS = 60_000

export type Bucket = { readonly tokens: number; readonly updatedAt: number }

export type Verdict = {
  readonly allowed: boolean
  /** Until one token is available; zero when allowed. */
  readonly retryAfterMs: number
  readonly bucket: Bucket
}

export function take(bucket: Bucket | undefined, perMinute: number, now: number): Verdict {
  const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.updatedAt)
  const tokens =
    bucket === undefined
      ? perMinute
      : Math.min(perMinute, bucket.tokens + (elapsed * perMinute) / WINDOW_MS)

  if (tokens >= 1) {
    return { allowed: true, retryAfterMs: 0, bucket: { tokens: tokens - 1, updatedAt: now } }
  }
  return {
    allowed: false,
    retryAfterMs: Math.ceil(((1 - tokens) * WINDOW_MS) / perMinute),
    bucket: { tokens, updatedAt: now },
  }
}

/**
 * How many buckets are kept. The keys are source addresses, which a caller
 * picks, and a map nobody sweeps is a leak.
 */
export const MAX_BUCKETS = 10_000

export function createBucketStore(maxBuckets = MAX_BUCKETS) {
  const buckets = new Map<string, Bucket>()

  /**
   * A bucket untouched for a window has refilled completely and is
   * indistinguishable from a caller never seen, so dropping it forgets
   * nothing. Only if every bucket is younger — the limit is working right
   * now — do the oldest go, handing their callers an early allowance: cheaper
   * than unbounded memory under that load.
   */
  const sweep = (now: number) => {
    for (const [id, bucket] of buckets) {
      if (now - bucket.updatedAt >= WINDOW_MS) buckets.delete(id)
    }
    if (buckets.size <= maxBuckets) return
    const oldestFirst = [...buckets].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [id] of oldestFirst.slice(0, buckets.size - maxBuckets)) buckets.delete(id)
  }

  return {
    take(id: string, perMinute: number, now: number): Verdict {
      const verdict = take(buckets.get(id), perMinute, now)
      buckets.set(id, verdict.bucket)
      if (buckets.size > maxBuckets) sweep(now)
      return verdict
    },
    get size() {
      return buckets.size
    },
  }
}

function withoutPort(hop: string): string {
  const bracketed = /^\[(.+)](?::\d+)?$/.exec(hop)
  if (bracketed?.[1] !== undefined) return bracketed[1]
  // A bare IPv6 address has several colons and no port.
  const parts = hop.split(':')
  return parts.length === 2 && parts[1] !== undefined && /^\d+$/.test(parts[1])
    ? (parts[0] ?? hop)
    : hop
}

/** Loopback, RFC 1918, link-local, CGNAT and their IPv6 kin: ours, never a caller's. */
const INTERNAL = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
]

/**
 * The routable hops Render appends after the caller's address. Measured live
 * on Render on 2026-09-25 (FairLane): the last entry is a platform proxy whose
 * address varies, so reading it gave one client several buckets.
 */
export const TRUSTED_PROXY_HOPS = 1

/**
 * The caller's address, counted **from the end** of `x-forwarded-for`:
 * whatever a caller writes into the header stays to the left of what the edge
 * appends, so no invented value becomes the one counted by. Reading the first
 * entry would hand out a fresh allowance per invented value.
 */
export function addressFromHeaders(header: string | undefined): string {
  const hops = (header ?? '')
    .split(',')
    .map((hop) => withoutPort(hop.trim()))
    .filter((hop) => hop.length > 0)
  if (hops.length === 0) return 'unknown'

  let end = hops.length
  while (end > 1 && INTERNAL.some((range) => range.test(hops[end - 1] ?? ''))) end -= 1
  return hops[Math.max(0, end - 1 - TRUSTED_PROXY_HOPS)] ?? 'unknown'
}

export interface LimitOptions {
  readonly perMinute: number
  /** Overridden in tests only. */
  readonly now?: () => number
  readonly maxBuckets?: number
}

export function limitPerAddress(options: LimitOptions) {
  const buckets = createBucketStore(options.maxBuckets)
  const clock = options.now ?? Date.now

  return createMiddleware<AppEnv>(async (c, next) => {
    const verdict = buckets.take(
      addressFromHeaders(c.req.header('x-forwarded-for')),
      options.perMinute,
      clock(),
    )
    if (!verdict.allowed) {
      const seconds = Math.ceil(verdict.retryAfterMs / 1000)
      c.header('Retry-After', String(seconds))
      throw rateLimited('too many requests from this address', { retryAfterSeconds: seconds })
    }
    await next()
  })
}
