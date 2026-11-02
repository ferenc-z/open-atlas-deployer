// The page's own confirmation dialog, in place of the browser's confirm(): `await ask(question)` resolves true on the
// confirm button and false on Cancel, Escape or a click outside; `danger` paints the confirm button red and leaves Enter
// on Cancel. One <ConfirmHost /> is mounted beside the app; a second
// question while one is open answers the first with false.
import { useEffect, useRef, useState } from "react";

type Question = { message: string; confirm: string; danger: boolean; resolve: (ok: boolean) => void };
let open: ((q: Question) => void) | null = null;

export function ask(message: string, options: { confirm?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!open) return resolve(false);
    open({ message, confirm: options.confirm ?? "Confirm", danger: options.danger ?? false, resolve });
  });
}

export function ConfirmHost() {
  const [question, setQuestion] = useState<Question | null>(null);
  const current = useRef<Question | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = (ok: boolean) => {
    current.current?.resolve(ok);
    current.current = null;
    setQuestion(null);
  };
  useEffect(() => {
    open = (q) => { current.current?.resolve(false); current.current = q; setQuestion(q); };
    return () => { open = null; };
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (question && !d.open) d.showModal();
    if (!question && d.open) d.close();
    // Enter takes the default: Cancel for a destructive action, the confirm button otherwise.
    if (question) d.querySelector<HTMLButtonElement>(question.danger ? "button" : "button.primary")?.focus();
  }, [question]);
  return (
    <dialog ref={dialog} className="confirm" onCancel={(e) => { e.preventDefault(); answer(false); }} onClick={(e) => { if (e.target === e.currentTarget) answer(false); }}>
      {question && <div className="confirm-body">
        <p>{question.message}</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => answer(false)}>Cancel</button>
          <button type="button" className={question.danger ? "primary danger" : "primary"} onClick={() => answer(true)}>{question.confirm}</button>
        </div>
      </div>}
    </dialog>
  );
}
