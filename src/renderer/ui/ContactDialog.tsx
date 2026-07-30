import { useEffect, useState } from 'react'
import { Button } from './Button'
import { TextField } from './fields'
import { TrashIcon } from './icons'
import { Modal } from './Modal'

// Add/edit-contact modal. Presentational: the caller supplies onSubmit (which may
// throw to surface a validation error) and owns persistence. When onDelete is
// given the dialog is in edit mode and shows a delete (trash) action. Fields
// reset to the initial values each time the dialog opens. The address hint is a
// prop (not read from brand here) because it depends on the build network — the
// ui layer stays free of the data cache that knows it.
export function ContactDialog({
  open,
  onClose,
  onSubmit,
  onDelete,
  addressPlaceholder,
  title = 'Add contact',
  initialName = '',
  initialAddress = '',
  submitLabel = 'Save',
}: {
  open: boolean
  onClose: () => void
  onSubmit: (name: string, address: string) => Promise<void>
  onDelete?: () => Promise<void>
  addressPlaceholder: string
  title?: string
  initialName?: string
  initialAddress?: string
  submitLabel?: string
}) {
  const [name, setName] = useState(initialName)
  const [address, setAddress] = useState(initialAddress)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initialName)
      setAddress(initialAddress)
      setError(null)
      setBusy(false)
    }
  }, [open, initialName, initialAddress])

  async function save(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await onSubmit(name.trim(), address.trim())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (onDelete === undefined) return
    setError(null)
    setBusy(true)
    try {
      await onDelete()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {onDelete !== undefined && (
        <button
          type="button"
          aria-label="Delete contact"
          title="Delete"
          disabled={busy}
          onClick={() => void remove()}
          style={{ flex: 'none', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border-s)', background: 'transparent', borderRadius: 10, color: 'var(--danger)', cursor: 'pointer' }}
        >
          <TrashIcon size={16} />
        </button>
      )}
      <Button variant="secondary" style={{ flex: 1 }} disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button style={{ flex: 1 }} disabled={busy || name.trim().length === 0 || address.trim().length === 0} onClick={() => void save()}>
        {busy ? 'Saving…' : submitLabel}
      </Button>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title={title} width={420} footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 4 }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice" aria-label="Contact name" />
        <TextField
          label="Address"
          mono
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={addressPlaceholder}
          aria-label="Contact address"
          state={error !== null ? 'error' : 'default'}
          hint={error ?? undefined}
        />
      </div>
    </Modal>
  )
}
