/**
 * Ambient types for the statically linked ui-primitives surface this plugin
 * consumes. @deepseek-ai/dsh-client-ui-primitives ships no npm copy in the dsh
 * install (it is compiled into the web shell), so the module table seeds it in
 * the browser while typechecking resolves these declarations. Signatures are
 * copied from the shipped ui-primitives surface as of dsh 0.2.2-alpha.3; the
 * `16`-suffixed icon names of earlier releases are gone (icons are now
 * `...Regular` / `...Medium`), so this plugin draws its own glyphs.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Input(props: {
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement

  export function MarkdownText(props: { text: string; className?: string }): ReactElement
}
