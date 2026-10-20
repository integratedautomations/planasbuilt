import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'

/** One row of the viewer's ⋯ menu. A check mark column shows toggled state; the hint is the hotkey. */
export function MenuItemBtn({ icon, label, hint, checked, disabled, title, onClick }: {
  icon?: IconName; label: ReactNode; hint?: string; checked?: boolean; disabled?: boolean; title?: string; onClick?: () => void
}) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked} className="vmenu-item" disabled={disabled} title={title} onClick={onClick}>
      <span className="vmenu-ico">{checked ? <Icon name="check" size={16} /> : icon ? <Icon name={icon} size={16} /> : null}</span>
      <span className="vmenu-label">{label}</span>
      {hint && <kbd className="vmenu-hint">{hint}</kbd>}
    </button>
  )
}

export const MenuHeading = ({ children }: { children: ReactNode }) => <div className="vmenu-heading" role="presentation">{children}</div>
export const MenuSep = () => <div className="vmenu-sep" role="separator" />
