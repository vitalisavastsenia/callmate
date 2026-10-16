import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toneOptions } from '../contacts';

export function ToneFields({ tone, notes, onChange, hideHeading = false }: { tone: string[]; notes: string; onChange: (tone: string[], notes: string) => void; hideHeading?: boolean }) {
  return <fieldset className="tone-fields"><legend className={hideHeading ? 'sr-only' : 'section-title'}>Tone &amp; manner</legend>
    <div className="mb-4 flex flex-wrap gap-2">{[...new Set([...toneOptions, ...tone])].map(option => <button key={option} type="button" className="secondary template-chip" aria-pressed={tone.includes(option)} onClick={() => onChange(tone.includes(option) ? tone.filter(t => t !== option) : [...tone, option], notes)}>{option === 'Formal "usted"' ? 'Formal' : option}</button>)}</div>
    <label>Notes for Zeus<textarea data-gramm="false" aria-label="Notes for Zeus" value={notes} onChange={e => onChange(tone, e.target.value)} maxLength={2000} rows={2} placeholder="Grumpy guy, be extra polite and patient" /></label>
  </fieldset>;
}
export function Modal({ title, onClose, children, className = '', headerActions }: { title: string; onClose: () => void; children: ReactNode; className?: string; headerActions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return createPortal(<dialog ref={ref} className={'contact-dialog ' + className} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="modal-header mb-5 flex items-start justify-between gap-3"><h2 id={titleId}>{title}</h2><div className="modal-header-actions">{headerActions}<button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div></div>
    <div className="modal-body">{children}</div>
  </dialog>, document.body);
}
