// The reason code and the case reference — the two fields every compliance
// action carries (FR-017), in one place for every form that asks for them.
import { REASON_CODES, reasonCodeEntry } from '@forge/shared/reasons'

export interface ReasonValue {
  reasonCode: string
  otherCode: string
  caseRef: string
}

export function ReasonFields({
  value,
  onChange,
  errors = {},
}: {
  value: ReasonValue
  onChange: (next: ReasonValue) => void
  errors?: { reason?: string | undefined; caseRef?: string | undefined }
}) {
  const entry = reasonCodeEntry(Number(value.reasonCode))

  return (
    <>
      <label className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 sm:grid-cols-[13rem_1fr]">
        <span className="smallcaps muted">Reason code</span>
        <span>
          <select
            className="w-full bg-transparent text-[14px]"
            value={value.reasonCode}
            onChange={(e) => onChange({ ...value, reasonCode: e.target.value })}
          >
            <option value="">— choose the reason —</option>
            {REASON_CODES.map((code) => (
              <option key={code.code} value={String(code.code)}>
                {code.code} · {code.label}
              </option>
            ))}
            <option value="other">Another code…</option>
          </select>
          {value.reasonCode === 'other' && (
            <input
              type="text"
              inputMode="numeric"
              className="num mt-2 text-[14px]"
              placeholder="the issuer’s own code, 1…65535"
              value={value.otherCode}
              onChange={(e) => onChange({ ...value, otherCode: e.target.value })}
            />
          )}
          {entry && <span className="muted mt-1 block text-[12px]">{entry.use}</span>}
          {errors.reason && <span className="refuse mt-1 block text-[12px]">{errors.reason}</span>}
        </span>
      </label>

      <label className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 sm:grid-cols-[13rem_1fr]">
        <span className="smallcaps muted">Case reference</span>
        <span>
          <input
            type="text"
            className="num text-[14px]"
            spellCheck={false}
            maxLength={32}
            placeholder="REG-2026-0412"
            value={value.caseRef}
            onChange={(e) => onChange({ ...value, caseRef: e.target.value })}
          />
          <span className="muted mt-1 block text-[12px]">
            Stored on chain with the action: up to 32 printable ASCII characters.
          </span>
          {errors.caseRef && (
            <span className="refuse mt-1 block text-[12px]">{errors.caseRef}</span>
          )}
        </span>
      </label>
    </>
  )
}
