import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Pinned to "dark", and staying that way (spec 007 research.md decision 11, confirmed moot):
// `theme="dark"` only selects Sonner's own built-in dark-mode icon/structural variant, never
// toast colours -- those already follow whichever Refract theme is active via the CSS custom
// property overrides below (`--normal-bg`, `--normal-text`, `--normal-border`, all mapped to
// `--popover`/`--popover-foreground`/`--border`, which repaint with the rest of the app on a
// theme switch). Since every built-in Refract theme is dark-toned (no light theme exists, and
// none is planned), `"dark"` is the correct literal for every preset, not a placeholder waiting
// on a `mode` field `ThemeDefinition` deliberately does not have.
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
