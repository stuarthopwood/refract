import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Pinned to "dark": Refract is dark-only (Stuart, 2026-10-02 -- see docs/DESIGN.md "Look and
// feel"), and there is no next-themes `ThemeProvider` anywhere in the render tree for `useTheme()`
// to read real app state from, so calling it here always silently fell back to its "system"
// default -- meaning toasts independently followed the OS's light/dark setting via
// `prefers-color-scheme`, regardless of the app's own (always-dark) appearance. Once spec 007
// ships real theme presets, this reads the active theme's `mode` instead of a hardcoded literal.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
