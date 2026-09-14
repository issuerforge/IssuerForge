import { describe, expect, it } from 'vitest'
import {
  type Draft,
  EMPTY_DRAFT,
  parsedPolicy,
  parseJurisdictions,
  problemsAt,
  toCreateTokenBody,
  toInteger,
  toSmallestUnit,
  warningsFor,
} from './draft.ts'

const ADDRESS = 'SysvarC1ock11111111111111111111111111111111'
const TREASURY = 'SysvarRent111111111111111111111111111111111'
const SCHEMA = 'So11111111111111111111111111111111111111112'
const NOW = 1_780_000_000

/** Повна чернетка, яку приймає схема. Тести псують по одному полю. */
const complete = (overrides: Partial<Draft> = {}): Draft => ({
  ...EMPTY_DRAFT,
  name: 'Vantara Naira',
  symbol: 'vNGN',
  uri: 'https://vantara.example/vngn.json',
  decimals: '2',
  initialSupply: '25,000,000.00',
  ackSymbol: true,
  ackDecimals: true,
  ackPolicy: true,
  jurisdictions: 'NG, GH',
  founderJurisdiction: 'NG',
  reserveAmount: '25,400,000.00',
  reserveCurrency: 'NGN',
  credential: ADDRESS,
  schema: SCHEMA,
  treasury: TREASURY,
  ...overrides,
})

describe('суми', () => {
  // Найдорожча помилка цього файла була б тихою: `25000000.07 * 100` дає
  // 2500000006.9999995, і копійка зникає без жодного повідомлення.
  it('рахує рядками, а не числами з рухомою комою', () => {
    expect(toSmallestUnit('25000000.07', 2)).toBe('2500000007')
    expect(toSmallestUnit('0.07', 2)).toBe('7')
    expect(toSmallestUnit('1', 9)).toBe('1000000000')
  })

  it('дозволяє коми й пробіли як роздільники розрядів', () => {
    expect(toSmallestUnit('25,000,000.00', 2)).toBe('2500000000')
    expect(toSmallestUnit('25 000 000', 2)).toBe('2500000000')
  })

  // Зайва точність — це або одруківка, або людина думає, що знаків більше.
  // Обрізати хвіст мовчки означало б підписати не те число.
  it('відхиляє точність, якої в токена немає', () => {
    expect(toSmallestUnit('1.234', 2)).toBeUndefined()
    expect(toSmallestUnit('1.5', 0)).toBeUndefined()
  })

  it.each(['', '—', '1.2.3', '-5', 'abc', '1e3'])('«%s» не є сумою', (input) => {
    expect(toSmallestUnit(input, 2)).toBeUndefined()
  })

  it('нуль лишається нулем, а не порожнім рядком', () => {
    expect(toSmallestUnit('0', 2)).toBe('0')
    expect(toSmallestUnit('0.00', 2)).toBe('0')
  })

  it('ціле число з поля — це не «нуль за замовчуванням»', () => {
    expect(toInteger('24')).toBe(24)
    expect(toInteger('')).toBeUndefined()
    expect(toInteger('2.5')).toBeUndefined()
  })
})

describe('юрисдикції', () => {
  it('розбираються з рядка через кому й підводяться до верхнього регістру', () => {
    expect(parseJurisdictions(' ng, GH ,ke ')).toEqual(['NG', 'GH', 'KE'])
  })

  it('порожній рядок означає «правила немає», а не порожній перелік', () => {
    expect(parseJurisdictions('')).toEqual([])
    expect(parsedPolicy(complete({ jurisdictions: '' }))?.jurisdictions).toBeUndefined()
  })

  it('дублікат відхиляється, а не мовчки зникає', () => {
    expect(problemsAt(2, complete({ jurisdictions: 'NG, NG' }))).toContain(
      'a jurisdiction is named twice',
    )
  })
})

describe('чернетка → політика', () => {
  it('порожній ліміт — це відсутнє правило, а не нуль', () => {
    const policy = parsedPolicy(complete())

    expect(policy?.transferLimit).toBeUndefined()
    expect(policy?.periodLimit).toBeUndefined()
  })

  it('заповнений ліміт переводиться в найменші одиниці', () => {
    const policy = parsedPolicy(complete({ transferLimit: '500,000.00', periodLimit: '2,000,000' }))

    expect(policy?.transferLimit).toBe('50000000')
    expect(policy?.periodLimit).toEqual({ amount: '200000000', windowSeconds: 24 * 3600 })
  })

  // Політика, яка приймає атестації провайдера й не називає їх строку, — це
  // верифікація, чинна назавжди (FR-008a2). Модель це відхиляє; майстер не має
  // навіть дати такий стан зібрати.
  it('строк атестації зникає разом із джерелом, а не лишається нулем', () => {
    const policy = parsedPolicy(complete({ sources: ['register'] }))

    expect(policy?.status.maxAttestationAgeSeconds).toBeUndefined()
    expect(policy?.status.sources).toEqual(['register'])
  })

  it('чернетка без жодного джерела статусу політикою не стає', () => {
    expect(parsedPolicy(complete({ sources: [] }))).toBeUndefined()
  })
})

describe('готовність кроків', () => {
  it('повна чернетка не має проблем на жодному кроці', () => {
    for (const step of [1, 2, 3, 4, 5]) {
      expect(problemsAt(step, complete())).toEqual([])
    }
  })

  // FR-005: три незмінні параметри підтверджуються явно, і без цього крок 1 не
  // закінчується. Це не оздоблення — це те, чого не можна змінити потім.
  it('без трьох підтверджень крок 1 не закінчується', () => {
    expect(problemsAt(1, complete({ ackDecimals: false }))).toContain(
      'all three fixed parameters must be acknowledged',
    )
  })

  it('крок 1 не питає про резерв, якого на ньому ще немає', () => {
    expect(problemsAt(1, complete({ reserveAmount: '' }))).toEqual([])
  })

  it('нульовий ліміт — це не ліміт, і так і сказано', () => {
    expect(problemsAt(3, complete({ transferLimit: '0' }))[0]).toContain('stops every transfer')
  })

  // Наскрізне правило: обіг нульовий, тож уся емісія мусить уміститись у
  // резерв. Перевіряє його схема тіла — та сама, що на сервері.
  it('емісія понад резерв ловиться до підпису', () => {
    const problems = problemsAt(5, complete({ reserveAmount: '1.00' }))

    expect(problems.join(' ')).toContain('exceeds the attested reserve')
  })
})

describe('чернетка → тіло запиту', () => {
  it('збирається тією самою схемою, що валідує сервер', () => {
    const built = toCreateTokenBody(complete(), NOW)

    expect(built.ok).toBe(true)
    expect(built.body).toMatchObject({
      name: 'Vantara Naira',
      symbol: 'vNGN',
      decimals: 2,
      initialSupply: '2500000000',
      reserve: { amount: '2540000000', currency: 'NGN', attestedAt: NOW },
      founderStatus: { tier: 1, jurisdiction: 'NG', expiresAt: 0 },
    })
  })

  it('називає поле, у якому проблема, а не просто «невірно»', () => {
    const built = toCreateTokenBody(complete({ symbol: '' }), NOW)

    expect(built.ok).toBe(false)
    expect(built.problems.join(' ')).toContain('symbol')
  })
})

describe('попередження про засновника', () => {
  // Програма цього не перевіряє й не має: політика стосується переказів, а не
  // того, кому дістався початковий випуск. Наслідок при цьому реальний — токен,
  // який нікуди не рухається.
  it('юрисдикція засновника поза дозволеними — попередження, а не відмова', () => {
    const draft = complete({ founderJurisdiction: 'PL' })

    expect(warningsFor(draft)[0]).toContain('cannot send')
    expect(problemsAt(5, draft)).toEqual([])
  })

  it('рівень засновника нижчий за мінімальний — теж попередження', () => {
    expect(warningsFor(complete({ founderTier: 0, minTier: 2 }))[0]).toContain('below the minimum')
  })

  it('узгоджена чернетка попереджень не має', () => {
    expect(warningsFor(complete())).toEqual([])
  })
})
