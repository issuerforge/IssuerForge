// Фікстурний постачальник входу: те, чим для api є Privy, коли Privy немає.
//
// **Чому це взагалі потрібно.** `requireSession` робить два кроки різної
// природи (`apps/api/src/privy.ts`): підпис токена перевіряє локально проти
// `PRIVY_VERIFICATION_KEY`, а **адреси гаманців питає в постачальника** —
// у токені їх немає ніколи, бо роль прив'язана до адреси, а не до акаунта
// входу (FR-034a). Гаманці ж демо генеруються на кожен прогін, і живий Privy
// не може знати адрес, яких не існувало, коли акаунт створювався.
//
// **Чому api від цього не міняється.** `PRIVY_API_URL` винесений у змінну
// саме для цього — «щоб зміна хоста Privy не була правкою коду» (T009). Тут
// піднімається сервіс, який відповідає на той самий запит тим самим тілом;
// код автентифікації лишається рівно тим, що поїде в продакшн, і саме він
// перевіряє підпис, аудиторію й строк. Обходу входу в api не з'явилось.
import { createServer, type Server } from 'node:http'
import { importPKCS8, SignJWT } from 'jose'

/** Privy підписує токени доступу ES256 і тільки ним. */
const ALGORITHM = 'ES256'

/** `iss` у токені Privy. Api звіряє його точним збігом. */
const ISSUER = 'privy.io'

export interface LoginFixtureOptions {
  /** Приватна половина ключа, чия публічна частина стоїть у `PRIVY_VERIFICATION_KEY`. */
  readonly signingKeyPem: string
  /** Аудиторія токена: те саме, що `PRIVY_APP_ID` у api. */
  readonly appId: string
  /** Порт, на який дивиться `PRIVY_API_URL`. */
  readonly port: number
}

export interface LoginSession {
  /** DID акаунта входу. Свій на кожен прогін, тож кеш api не має чого віддати. */
  readonly did: string
  /** Токен доступу для заголовка `Authorization: Bearer`. */
  readonly accessToken: string
  /** Зупиняє фікстуру. */
  close(): Promise<void>
}

/**
 * Піднімає фікстуру й видає токен для набору адрес.
 *
 * Адреси передаються сюди, а не читаються з ланцюга: постачальник входу нічого
 * про ланцюг не знає й у продакшні теж — він лише каже, які адреси людина
 * довела. Що з них випливає, вирішує склад емітента в `role_assignments`.
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
    // Шлях звіряється, а не ігнорується: фікстура, що відповідає на будь-який
    // запит, приховала б зміну адреси ручки в api — і ми б дізнались про неї
    // від живого Privy, а не тут.
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
    // Тільки петля: фікстура видає токени, і слухати на всіх інтерфейсах їй
    // нема чого навіть на час прогону.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}
