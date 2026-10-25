import Link from "next/link"
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react"

/**
 * Thin wrappers over the Sarib design system's classes (src/sarib/components.css, sarib-design DESIGN.md §12).
 * They only map props to s- classes: no styles of their own. Layout classes (margins, flex) may be passed in
 * `className`; colour, size, radius and padding come from the s- classes alone.
 */

export type IconName =
  | "arrow-left" | "arrow-up" | "arrow-down" | "arrow-right" | "arrow-up-right" | "chart-column" | "check" | "chevron-down" | "chevron-left"
  | "chevron-right" | "chevron-up" | "circle-alert" | "circle-check" | "close" | "copy" | "download" | "edit" | "ellipsis" | "eye" | "eye-off"
  | "file" | "file-text" | "folder" | "folder-open" | "image" | "info" | "link" | "list" | "loader-circle" | "lock" | "log-out" | "menu"
  | "message-square" | "minus" | "moon" | "panel-close" | "panel-open" | "plus" | "refresh-cw" | "retry" | "search" | "settings" | "shell"
  | "sliders-horizontal" | "sparkle" | "star" | "sun" | "trash-2" | "triangle-alert" | "upload" | "user" | "x"

/** A Lucide glyph drawn as a CSS mask in currentColor. Decorative: the control around it carries the label. */
export function Icon({ name, size, className = "" }: { name: IconName; size?: 12 | 14 | 16 | 18 | 20 | 24 | 28 | 32; className?: string }) {
  return <span aria-hidden="true" data-icon={name} className={`s-icon${size ? ` s-icon--${size}` : ""}${className ? ` ${className}` : ""}`} />
}

export type ButtonVariant = "brand" | "primary" | "secondary" | "tertiary" | "outline" | "ghost" | "brand-tone" | "brand-ghost" | "success" | "warning" | "error" | "link-neutral" | "link-brand"
export type ButtonSize = "sm" | "md" | "lg" | "xl"

type Look = { variant?: ButtonVariant; size?: ButtonSize; pill?: boolean; block?: boolean; className?: string }

export function btnClass({ variant = "primary", size = "md", pill, block, className }: Look & { icon?: boolean }, icon = false): string {
  // Touch screens: the library gives every s-btn (icon ones included) its 44px floor (sarib-design v2.1).
  return ["s-btn", variant !== "primary" && `s-btn--${variant}`, size !== "md" && `s-btn--${size}`, pill && "s-btn--pill", block && "s-btn--block", icon && "s-btn--icon", className].filter(Boolean).join(" ")
}

type ButtonProps = Look & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { icon?: IconName; iconEnd?: IconName; busy?: boolean }

/** `s-btn`: label in `s-btn__label`, optional leading/trailing glyphs, loading via aria-busy. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, pill, block, className, icon, iconEnd, busy, children, type = "button", disabled, ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={btnClass({ variant, size, pill, block, className })} {...rest}>
      {icon && <Icon name={icon} />}
      {children !== undefined && children !== null && children !== false && <span className="s-btn__label">{children}</span>}
      {iconEnd && <Icon name={iconEnd} />}
      {busy && <Icon name="loader-circle" className="s-btn__spinner" />}
    </button>
  )
})

type IconButtonProps = Omit<Look, "block"> & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-label"> & { icon: IconName; label: string; children?: ReactNode }

/** Icon-only `s-btn--icon`: a square 36 / 40 / 44 with its label for assistive tech. `title` (default: the label) is the
 * library label tip (`data-s-tip`, ui/tips.tsx), not a native title tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ variant = "ghost", size = "sm", pill, className, icon, label, title, children, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} data-s-tip={title ?? label} className={btnClass({ variant, size, pill, className }, true)} {...rest}>
      <Icon name={icon} />
      {children}
    </button>
  )
})

type LinkButtonProps = Look & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "href"> & { href: string; icon?: IconName; label?: string; prefetch?: boolean }

/** A link drawn as a button (`New chat`). With `label` and no children it is icon-only. */
export function LinkButton({ variant, size, pill, block, className, icon, label, children, href, prefetch, ...rest }: LinkButtonProps) {
  const iconOnly = !children && !!label
  return (
    <Link href={href} prefetch={prefetch} aria-label={iconOnly ? label : undefined} data-s-tip={iconOnly ? label : undefined} className={btnClass({ variant, size, pill, block, className }, iconOnly)} {...rest}>
      {icon && <Icon name={icon} />}
      {children && <span className="s-btn__label">{children}</span>}
    </Link>
  )
}
