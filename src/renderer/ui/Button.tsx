import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'md' | 'sm' | 'cta'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}

// The single button primitive. Defaults to type="button" so it never submits a
// form by accident; hover/active/focus states come from the .btn* classes.
// Sizes: md (default 44px), sm (compact 38px rows), cta (48px onboarding/unlock).
export function Button({ variant = 'primary', size = 'md', fullWidth = false, type = 'button', className, children, ...rest }: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size !== 'md' ? `btn--${size}` : '', fullWidth ? 'btn--full' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  )
}
