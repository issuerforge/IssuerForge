// A stub for a screen not written yet.
//
// A blank page saying "coming soon" lies twice: it says neither what exactly
// will be here nor when. Here stands the task number from `docs/TASKS.md` —
// the same list the work is accepted against — and one sentence about what
// will appear on this screen. The role let the person in here: they must see
// that the power exists and the screen does not yet.
export default function Stub({ task, what }: { task: string; what: string }) {
  return (
    <div className="max-w-[620px] py-10">
      <h1 className="section-head block">Not built yet</h1>
      <p className="mt-5 text-[13px] leading-relaxed">{what}.</p>
      <p className="mono12 muted mt-5">
        arrives with task <span className="num">{task}</span>
      </p>
      <p className="muted mt-8 text-[12px] leading-relaxed">
        Your role opens this screen. Nothing here is hidden from you — there is nothing here yet.
      </p>
    </div>
  )
}
