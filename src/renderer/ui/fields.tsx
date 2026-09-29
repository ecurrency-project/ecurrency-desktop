import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { EyeIcon } from './icons'

export type FieldState = 'default' | 'error' | 'success'

function fieldClass(state: FieldState, mono: boolean): string {
  return ['field', state === 'error' ? 'field--error' : state === 'success' ? 'field--success' : '', mono ? 'field--mono' : '']
    .filter(Boolean)
    .join(' ')
}

function hintClass(state: FieldState): string {
  return `field-hint${state === 'error' ? ' field-hint--error' : state === 'success' ? ' field-hint--success' : ''}`
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string
  hint?: ReactNode
  state?: FieldState
  mono?: boolean
}

// Labelled text input. The label is tied to the input via htmlFor/useId so it is
// announced by screen readers and clickable.
export function TextField({ label, hint, state = 'default', mono = false, id, ...rest }: TextFieldProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <div>
      {label !== undefined && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <input id={fieldId} className={fieldClass(state, mono)} {...rest} />
      {hint !== undefined && <div className={hintClass(state)}>{hint}</div>}
    </div>
  )
}

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  label?: string
}

// Password input with a self-contained show/hide toggle (its own state, so two
// instances toggle independently). The toggle is a real button with an aria-label.
export function PasswordField({ label, id, ...rest }: PasswordFieldProps) {
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
      <div className="field-wrap" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setShow(false)
      }}>
        <input id={fieldId} type={show ? 'text' : 'password'} autoComplete="current-password" {...rest}
          spellCheck={false} autoCorrect="off" autoCapitalize="none"
          onCopy={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()} />
        <button
          type="button"
          className="field-affix-btn"
          aria-label={show ? 'Hide password' : 'Show password'}
          onClick={() => setShow((v) => !v)}
        >
          <EyeIcon size={16} />
        </button>
      </div>
    </div>
  )
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string
  hint?: ReactNode
  state?: FieldState
  mono?: boolean
}

export function TextArea({ label, hint, state = 'default', mono = false, id, ...rest }: TextAreaProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <div>
      {label !== undefined && (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <textarea id={fieldId} className={fieldClass(state, mono)} {...rest} />
      {hint !== undefined && <div className={hintClass(state)}>{hint}</div>}
    </div>
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
