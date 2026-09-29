import { useEffect, useId, useState, type AriaAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { EyeIcon, EyeOffIcon } from './icons'

export type FieldState = 'default' | 'error' | 'success'

function fieldClass(state: FieldState, mono: boolean): string {
  return ['field', state === 'error' ? 'field--error' : state === 'success' ? 'field--success' : '', mono ? 'field--mono' : '']
    .filter(Boolean)
    .join(' ')
}

function hintClass(state: FieldState): string {
  return `field-hint${state === 'error' ? ' field-hint--error' : state === 'success' ? ' field-hint--success' : ''}`
}

// Shared by every field: the hint (help text or error) becomes the input's
// description, and the error state is exposed as aria-invalid, not only as a red
// border. Explicit aria props from the caller are kept.
function a11yProps(fieldId: string, hint: ReactNode, state: FieldState, describedBy: string | undefined, invalid: AriaAttributes['aria-invalid']) {
  const ids = [describedBy, hint !== undefined ? `${fieldId}-hint` : undefined].filter(Boolean).join(' ')
  return { 'aria-describedby': ids === '' ? undefined : ids, 'aria-invalid': invalid ?? (state === 'error' ? true : undefined) }
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string
  hint?: ReactNode
  state?: FieldState
  mono?: boolean
}

// Labelled text input. The label is tied to the input via htmlFor/useId so it is
// announced by screen readers and clickable.
export function TextField({ label, hint, state = 'default', mono = false, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...rest }: TextFieldProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <div>
      {label !== undefined && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <input id={fieldId} className={fieldClass(state, mono)} {...rest} {...a11yProps(fieldId, hint, state, describedBy, invalid)} />
      {hint !== undefined && <div id={`${fieldId}-hint`} className={hintClass(state)}>{hint}</div>}
    </div>
  )
}

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  label?: string
  hint?: ReactNode
  state?: FieldState
}

// Password input with a self-contained show/hide toggle (its own state, so two
// instances toggle independently). The toggle is a real button with an aria-label.
export function PasswordField({ label, hint, state = 'default', id, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...rest }: PasswordFieldProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const [show, setShow] = useState(false)
  useEffect(() => {
    const hide = (): void => setShow(false)
    const visibility = (): void => { if (document.visibilityState !== 'visible') hide() }
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => { if (rest.value === '') setShow(false) }, [rest.value])
  return (
    <div>
      {label !== undefined && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className={state === 'error' ? 'field-wrap field-wrap--error' : 'field-wrap'} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setShow(false)
      }}>
        <input id={fieldId} type={show ? 'text' : 'password'} autoComplete="current-password" {...rest} {...a11yProps(fieldId, hint, state, describedBy, invalid)}
          spellCheck={false} autoCorrect="off" autoCapitalize="none"
          onCopy={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()} />
        <button
          type="button"
          className="field-affix-btn"
          aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow((v) => !v)}
        >
          {show ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>
      </div>
      {hint !== undefined && <div id={`${fieldId}-hint`} className={hintClass(state)}>{hint}</div>}
    </div>
  )
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string
  hint?: ReactNode
  state?: FieldState
  mono?: boolean
}

// Grows with its content (textarea.field uses field-sizing), so `rows` sets the
// minimum height: that many lines plus the 14px padding and 1px border each side.
export function TextArea({ label, hint, state = 'default', mono = false, id, rows, style, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...rest }: TextAreaProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const sized = rows !== undefined ? { minHeight: `calc(${rows}lh + 30px)`, ...style } : style
  return (
    <div>
      {label !== undefined && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <textarea id={fieldId} className={fieldClass(state, mono)} rows={rows} style={sized} {...rest} {...a11yProps(fieldId, hint, state, describedBy, invalid)} />
      {hint !== undefined && <div id={`${fieldId}-hint`} className={hintClass(state)}>{hint}</div>}
    </div>
  )
}

interface LabelInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'onBlur'> {
  /** Receives the edited value when editing ends (blur or Enter). */
  onCommit: (value: string) => void
  /** The smaller size used inside list rows. */
  compact?: boolean
}

// Inline editor for a short local label, mounted only while editing. It commits on
// blur; Enter commits too, except during IME composition, where Enter picks the
// candidate instead.
export function LabelInput({ onCommit, compact = false, onKeyDown, ...rest }: LabelInputProps) {
  return (
    <input
      autoFocus
      className={compact ? 'field field--label field--compact' : 'field field--label'}
      {...rest}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  )
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  label: ReactNode
}

export function Checkbox({ label, id, ...rest }: CheckboxProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <label className="checkbox-row" htmlFor={fieldId}>
      <input id={fieldId} type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  )
}
