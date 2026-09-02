// Реєстр екранів консолі: шлях, назва, потрібна роль, вміст.
//
// Це **єдине** місце, де сказано, яка роль що відкриває. Навігація в шапці,
// ґард маршруту й екран відмови читають один і той самий список, тож «пункт
// меню є, а зайти не можна» неможливе за побудовою.
//
// Роль сюди приходить із сесії (`GET /api/session`) і виводиться сервером зі
// складу емітента за адресами гаманців (FR-034a). Консоль її не обчислює й не
// зберігає: тут вона тільки читається.
//
// Екрани, яких ще немає, стоять у списку із заглушкою, що називає свою задачу.
// Порожній пункт меню з чесним написом кращий за відсутній: на екрані видно
// повну форму повноважень, а не ту її частину, яку встигли написати.
import { ROLE, ROLE_ALL, type RoleName, roleNames } from '@forge/shared/api'
import type { ReactElement } from 'react'
import Overview from './Overview'
import Stub from './Stub'

/** Ролі, підпис яких рахується в кворум: обидві бачать комплаєнс-роботу. */
const AUTHORISING = ROLE.ADMIN | ROLE.COMPLIANCE

export interface Screen {
  /** Абсолютний шлях. Збігається з тим, що стоїть у `<Route path>`. */
  path: string
  /** Назва в навігації. Іменник, як у політиці, а не дієслово. */
  label: string
  /**
   * Маска ролей, будь-який біт якої відкриває екран.
   *
   * `ROLE_ALL` — «будь-яка відома роль»: маска сесії ніколи не порожня
   * (`roleMaskSchema` вимагає ≥ 1 біта), тож окремого значення «для всіх» не
   * потрібно, і правило доступу лишається одним виразом на весь застосунок.
   */
  requires: number
  element: ReactElement
}

export const SCREENS: readonly Screen[] = [
  {
    path: '/console',
    label: 'This issuer',
    requires: ROLE_ALL,
    element: <Overview />,
  },
  {
    path: '/console/journal',
    label: 'The journal',
    requires: ROLE_ALL,
    element: (
      <Stub task="T032" what="Export of the journal as NDJSON, and the live feed behind it" />
    ),
  },
  {
    path: '/console/holders',
    label: 'Holders',
    requires: AUTHORISING,
    element: (
      <Stub
        task="T022"
        what="The queue of accounts awaiting unblock, and this issuer’s own register of statuses"
      />
    ),
  },
  {
    path: '/console/actions',
    label: 'Compliance actions',
    requires: AUTHORISING,
    element: (
      <Stub
        task="T034"
        what="A case, its reason code, and the quorum of signatures it still needs"
      />
    ),
  },
  {
    path: '/issue',
    label: 'Issue a token',
    requires: ROLE.ADMIN,
    element: (
      <Stub
        task="T023"
        what="The issuance wizard on live rules, with scenarios simulated before signing"
      />
    ),
  },
  {
    path: '/mint',
    label: 'Issuance',
    requires: ROLE.ADMIN,
    element: (
      <Stub
        task="T043"
        what="Minting against the attested reserve: the ceiling, the fee and the full amount as separate numbers"
      />
    ),
  },
  {
    path: '/attest',
    label: 'Reserve attestation',
    requires: ROLE.ATTESTOR,
    element: <Stub task="T040" what="Publishing a reserve attestation for this token" />,
  },
  {
    path: '/settings/delegation',
    label: 'The operational key',
    requires: ROLE.ADMIN,
    element: (
      <Stub
        task="T035"
        what="What this issuer has delegated to the platform’s operational key, and revoking any of it in one action"
      />
    ),
  },
]

/** Чи відкриває маска ролей цей екран. Одне правило на весь застосунок. */
export function permits(roles: number, screen: Screen): boolean {
  return (roles & screen.requires) !== 0
}

/** Екрани, доступні цій масці, у порядку реєстру. */
export function screensFor(roles: number): Screen[] {
  return SCREENS.filter((screen) => permits(roles, screen))
}

/** Екран за точним шляхом. `undefined` означає «такого шляху немає» — 404. */
export function screenAt(path: string): Screen | undefined {
  return SCREENS.find((screen) => screen.path === path)
}

/**
 * Перший доступний екран — куди веде корінь.
 *
 * `undefined` неможливе для дійсної сесії (`/console` відкритий будь-якій
 * ролі), але тип цього не знає, і мовчазний `!` тут був би найгіршим місцем
 * для припущення.
 */
export function landingFor(roles: number): Screen | undefined {
  return screensFor(roles)[0]
}

/** Імена ролей, будь-яка з яких відкриває екран. Для екрана відмови. */
export function rolesOpening(screen: Screen): RoleName[] {
  return roleNames(screen.requires)
}
