// The fixture login provider: what Privy is to the api when there is no
// Privy.
//
// **Why this is needed at all.** `requireSession` takes two steps of a
// different nature (`apps/api/src/privy.ts`): it verifies the token signature
// locally against `PRIVY_VERIFICATION_KEY`, but **asks the provider for the
// wallet addresses** — a token never has them, because a role is bound to an
// address, not to the login account (FR-034a). The demo wallets, though, are
// generated on every run, and a live Privy cannot know addresses that did not
// exist when the account was created.
//
// **Why the api does not change because of this.** `PRIVY_API_URL` was made
// a variable for exactly this — "so that a change of Privy's host is not a
// code change" (T009). Here a service comes up that answers the same request
// with the same body; the authentication code stays exactly what will go to
// production, and it is what verifies the signature, the audience and the
// expiry. No bypass of login appeared in the api.
import { createServer, type Server } from 'node:http'
import { importPKCS8, SignJWT } from 'jose'

/** Privy signs access tokens with ES256 and nothing else. */
const ALGORITHM = 'ES256'

/** `iss` in a Privy token. The api checks it by exact match. */
const ISSUER = 'privy.io'

export interface LoginFixtureOptions {
  /** The private half of the key whose public half is in `PRIVY_VERIFICATION_KEY`. */
  readonly signingKeyPem: string
  /** The token audience: the same as `PRIVY_APP_ID` in the api. */
  readonly appId: string
  /** The port `PRIVY_API_URL` points at. */
  readonly port: number
}

export interface LoginSession {
  /** The login account's DID. New on every run, so the api cache has nothing to return. */
  readonly did: string
  /** The access token for the `Authorization: Bearer` header. */
  readonly accessToken: string
  /** Stops the fixture. */
  close(): Promise<void>
}

/**
 * Brings up the fixture and issues a token for a set of addresses.
 *
 * The addresses are passed in here rather than read from the chain: the
 * login provider knows nothing about the chain, in production too — it only
 * says which addresses the person proved. What follows from them is decided
 * by the issuer's membership in `role_assignments`.
 */
export async function startLogin(
  options: LoginFixtureOptions,
  wallets: readonly string[],
): Promise<LoginSession> {
  const did = `did:privy:demo${Date.now().toString(36)}`

  const body = JSON.stringify({
    id: did,
    linked_accounts: wallets.map((address) => ({
      type: 'wallet',
      chain_type: 'solana',
      address,
    })),
  })

  const server = createServer((request, response) => {
    // The path is checked, not ignored: a fixture answering any request would
    // hide a change of the handler address in the api — and we would learn
    // about it from a live Privy, not here.
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== `/api/v1/users/${encodeURIComponent(did)}`) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"no such user"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })

  await listen(server, options.port)

  const key = await importPKCS8(options.signingKeyPem, ALGORITHM)
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setAudience(options.appId)
    .setSubject(did)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)

  return {
    did,
    accessToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Loopback only: the fixture issues tokens, and it has no business
    // listening on all interfaces even for the duration of a run.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}
