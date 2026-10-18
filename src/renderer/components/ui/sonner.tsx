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
// Issue #980: the default `bottom-right` placed every toast directly over the composer's own
// Send button (`MessageInput.tsx`'s `absolute right-1.5 top-1/2` icon button) -- a toast could
// block the one control a user most needs while it is still visible. `bottom-right` (even
// offset upward) and `top-right` both also sit adjacent to the permanent 40px-wide right rail
// (`IconRail.tsx`, spec 013 FR-001, full window height) and `top-right` additionally sits under
// the OS caption-button corner (`TITLE_BAR_OVERLAY_HEIGHT`); either would need both an X-inset
// (past the rail) and, for `top-right`, a Y-inset (past the title bar) just to clear window
// chrome, on top of the Send-button problem itself -- and in split-pane mode (spec 005) a
// `bottom-right` toast still lands on the RIGHT pane's own Send button regardless. `bottom-center`
// has no horizontal relationship to the rail (far right edge) or the session list (far left
// edge), and in split mode falls on the pane splitter, clear of both composers -- decided
// (Skippy, delegated by Stuart 2026-10-18, ui-architect-v3 ruling) as the one placement that
// clears every conflict with a single static offset. The vertical offset below clears the
// composer's own resting height (outer `py-3` padding + the box's `pt-1` + the textarea's
// `min-h-16` + the `gap-1` row divider + the bottom picker row's `pb-2` plus its icon-sm
// buttons, `MessageInput.tsx`) with headroom for a few extra wrapped lines of typed text.
const TOAST_BOTTOM_OFFSET = '10rem'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="bottom-center"
      offset={{ bottom: TOAST_BOTTOM_OFFSET }}
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
