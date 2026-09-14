// П'ять кроків майстра. Форма — і тільки форма: жодного рішення тут не
// ухвалюється, усе зважене живе в `draft.ts` і перевіряється без DOM.
//
// **Складу кроків більше немає в прототипі M0.** Там четвертим кроком стояли
// «повноваження» — заморозка, вилучення, пауза, кворум і делегація, — але
// нічого з цього випуск не задає: кворум і склад належать емітенту, а делегація
// має власний екран (T035). Показувати перемикачі, які нічого не змінюють,
// означало б повторити рівно ту помилку, через яку в T020 записаний борг «екран
// показує один підпис замість трьох». Замість них четвертим кроком стоїть
// резерв: без нього випуск не збереться взагалі.
import { MAX_DECIMALS, MAX_FEE_BPS } from '@forge/api/contracts'
import { STATUS_SOURCES, type StatusSource } from '@forge/policy/model'
import { Block, Field, Segmented, Tick, Toggle } from '@/components/controls'
import { parseJurisdictions } from './draft.ts'
import { useWizard } from './WizardContext.tsx'

const TIERS = [0, 1, 2, 3].map((value) => ({ value, label: String(value) }))

export function Step1Token() {
  const { draft, set } = useWizard()

  return (
    <>
      <Field label="Token name" value={draft.name} onChange={(v) => set('name', v)} />
      <Field label="Symbol" value={draft.symbol} onChange={(v) => set('symbol', v)} mono />
      <Field
        label="Decimals"
        value={draft.decimals}
        onChange={(v) => set('decimals', v)}
        mono
        hint={`Whole number from 0 to ${MAX_DECIMALS}. Fixed for the life of the token.`}
      />
      <Field
        label="Metadata URI"
        value={draft.uri}
        onChange={(v) => set('uri', v)}
        hint="Where the token’s name, symbol and icon are published."
      />
      <Field
        label="Initial issuance"
        value={draft.initialSupply}
        onChange={(v) => set('initialSupply', v)}
        mono
        hint={`Denominated in ${draft.symbol.trim() || 'the symbol above'}. It goes to the founder’s account.`}
      />

      <Block heading="Fixed at issuance">
        <p className="muted mb-2 text-[13px]">
          Three things can never change after the policy is signed. Tick each one to continue.
        </p>
        <Tick checked={draft.ackSymbol} onChange={(v) => set('ackSymbol', v)}>
          The symbol <span className="num">{draft.symbol.trim() || '—'}</span> is fixed for the life
          of the token.
        </Tick>
        <Tick checked={draft.ackDecimals} onChange={(v) => set('ackDecimals', v)}>
          The number of decimals, <span className="num">{draft.decimals || '0'}</span>, is fixed for
          the life of the token.
        </Tick>
        <Tick checked={draft.ackPolicy} onChange={(v) => set('ackPolicy', v)}>
          Every transfer is checked against a policy. That check cannot be removed later, only
          rewritten under the quorum this issuer already holds.
        </Tick>
      </Block>
    </>
  )
}

const SOURCE_LABEL: Record<StatusSource, string> = {
  provider: 'An external verification provider',
  register: 'This issuer’s own register',
}

const SOURCE_NOTE: Record<StatusSource, string> = {
  provider: 'Attestations published on chain by a provider. They carry an expiry.',
  register: 'Statuses this issuer writes itself. A denial here overrides any provider allowance.',
}

export function Step2Holders() {
  const { draft, set } = useWizard()
  const codes = parseJurisdictions(draft.jurisdictions)

  const toggle = (source: StatusSource, on: boolean) => {
    // Порядок нормалізує сама модель (він впливає на `rules_hash`), тож тут
    // важливий тільки склад множини.
    set(
      'sources',
      on ? [...draft.sources, source] : draft.sources.filter((kept) => kept !== source),
    )
  }

  return (
    <>
      <Block heading="Where a status may come from">
        {STATUS_SOURCES.map((source) => (
          <Toggle
            key={source}
            checked={draft.sources.includes(source)}
            onChange={(v) => toggle(source, v)}
            label={SOURCE_LABEL[source]}
            description={SOURCE_NOTE[source]}
          />
        ))}
        {draft.sources.length === 0 && (
          <p className="mt-3 text-[12px]" style={{ color: 'var(--refuse)' }}>
            With no accepted source, every transfer of this token is refused.
          </p>
        )}
      </Block>

      <Block heading="What that status must say">
        <Segmented
          label="Minimum tier of verification"
          options={TIERS}
          value={draft.minTier}
          onChange={(v) => set('minTier', v)}
        />
        {draft.sources.includes('provider') && (
          <Field
            label="A provider attestation stays current for"
            value={draft.attestationAgeHours}
            onChange={(v) => set('attestationAgeHours', v)}
            mono
            hint="Hours, from 1 to 8760. An older attestation counts as absent, not as a refusal."
          />
        )}
        <Field
          label="Jurisdictions allowed"
          value={draft.jurisdictions}
          onChange={(v) => set('jurisdictions', v)}
          mono
          hint={
            codes.length === 0
              ? 'Two-letter codes, comma separated. Leave empty and jurisdiction is not checked at all.'
              : `Allowed: ${codes.join(', ')}`
          }
        />
      </Block>

      <Block heading="The founder’s own status">
        <p className="muted mb-2 text-[13px]">
          The whole initial issuance lands in the founder’s account, and that account is checked by
          the same rules as anyone else.
        </p>
        <Segmented
          label="Founder’s tier"
          options={TIERS}
          value={draft.founderTier}
          onChange={(v) => set('founderTier', v)}
        />
        <Field
          label="Founder’s jurisdiction"
          value={draft.founderJurisdiction}
          onChange={(v) => set('founderJurisdiction', v)}
          mono
          hint="Two-letter code, like NG."
        />
      </Block>
    </>
  )
}

export function Step3Limits() {
  const { draft, set } = useWizard()
  const unit = draft.symbol.trim() || 'the token'

  return (
    <>
      <p className="muted text-[13px] leading-relaxed">
        A limit left empty is a check that does not exist. There is no way to write “no limit” as a
        number: zero would stop every transfer, and that is what a pause is for.
      </p>

      <Block heading="Per transfer">
        <Field
          label="Largest single transfer"
          value={draft.transferLimit}
          onChange={(v) => set('transferLimit', v)}
          mono
          hint={`In ${unit}. Empty means a single transfer is not capped.`}
        />
      </Block>

      <Block heading="Per period">
        <Field
          label="Most one holder may move"
          value={draft.periodLimit}
          onChange={(v) => set('periodLimit', v)}
          mono
          hint={`In ${unit}. Empty means there is no period cap.`}
        />
        {draft.periodLimit.trim() !== '' && (
          <Field
            label="Counted over"
            value={draft.periodHours}
            onChange={(v) => set('periodHours', v)}
            mono
            hint="Hours, from 1 to 744 (31 days)."
          />
        )}
      </Block>
    </>
  )
}

export function Step4Reserve() {
  const { draft, set } = useWizard()

  return (
    <>
      <p className="muted text-[13px] leading-relaxed">
        The token cannot be issued above a reserve someone attested to. This is the first
        attestation, and it is signed by the attestor in this issuer’s roster — a second wallet,
        alongside the founder’s.
      </p>

      <Block heading="The attested reserve">
        <Field
          label="Amount attested"
          value={draft.reserveAmount}
          onChange={(v) => set('reserveAmount', v)}
          mono
          hint="Must be at least the initial issuance from step 1."
        />
        <Field
          label="Currency"
          value={draft.reserveCurrency}
          onChange={(v) => set('reserveCurrency', v)}
          mono
          hint="Three to eight upper-case letters, like NGN or USD."
        />
        <Field
          label="An attestation stays current for"
          value={draft.reserveAgeHours}
          onChange={(v) => set('reserveAgeHours', v)}
          mono
          hint="Hours. Past that, further issuance stops. Transfers are not affected."
        />
      </Block>

      <Block heading="Where a holder’s verification is read from">
        <Field
          label="Credential"
          value={draft.credential}
          onChange={(v) => set('credential', v)}
          mono
          hint="Address of the verification provider’s credential in the attestation service."
        />
        <Field
          label="Schema"
          value={draft.schema}
          onChange={(v) => set('schema', v)}
          mono
          hint="Address of the attestation schema. Both are fixed on the token at issuance."
        />
      </Block>

      <Block heading="Platform fee">
        <Field
          label="Fee, basis points"
          value={draft.feeBps}
          onChange={(v) => set('feeBps', v)}
          mono
          hint={`0 to ${MAX_FEE_BPS}. Charged on issuance, not on transfers.`}
        />
        <Field
          label="Treasury"
          value={draft.treasury}
          onChange={(v) => set('treasury', v)}
          mono
          hint="Address the fee is minted to."
        />
      </Block>
    </>
  )
}
