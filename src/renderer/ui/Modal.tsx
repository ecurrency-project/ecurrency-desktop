import { useId, type ReactNode } from 'react'
import { CloseIcon } from './icons'

// Centered overlay modal. Renders nothing when closed. Clicking the backdrop or
// the close button calls onClose; clicks inside the card don't propagate.
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  width = 440,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  width?: number
  footer?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width, maxWidth: '92%' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          {icon}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title" id={titleId}>
              {title}
            </div>
            {subtitle !== undefined && <div className="modal-sub">{subtitle}</div>}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
