// Заглушка екрана, який ще не написаний.
//
// Порожня сторінка з написом «скоро» бреше двічі: не каже, що саме буде, і не
// каже, коли. Тут стоїть номер задачі з `docs/TASKS.md` — того самого списку,
// за яким приймається робота, — і одне речення про те, що на цьому екрані
// з'явиться. Роль людину сюди пустила: вона має бачити, що повноваження є, а
// екрана ще немає.
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
