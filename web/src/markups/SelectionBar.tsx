interface Props {
  count: number
  canPaste: boolean
  multi: boolean
  onMulti: (v: boolean) => void
  onCopy: () => void
  onPaste: () => void
  onDuplicate: () => void
  onDelete: () => void
}

/** Floating actions for the current selection, so touch users get copy/paste/duplicate/delete. */
export function SelectionBar({ count, canPaste, multi, onMulti, onCopy, onPaste, onDuplicate, onDelete }: Props) {
  const has = count > 0
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions" onPointerDown={e => e.stopPropagation()}>
      {has && <span className="selection-count">{count}</span>}
      {has && <button onClick={onCopy} title="Copy (Ctrl+C)">Copy</button>}
      {canPaste && <button onClick={onPaste} title="Paste (Ctrl+V)">Paste</button>}
      {has && <button onClick={onDuplicate} title="Duplicate">Duplicate</button>}
      {has && <button className="danger" onClick={onDelete} title="Delete">Delete</button>}
      {(has || multi) && (
        <label className="check selection-multi">
          <input type="checkbox" checked={multi} onChange={e => onMulti(e.target.checked)} /> Select multiple
        </label>
      )}
    </div>
  )
}
