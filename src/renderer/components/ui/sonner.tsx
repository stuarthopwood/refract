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
// Send button (`MessageInput.tsx`'s `absolute right-1.5 top-1/2` icon button). `position=
// "bottom-center"` (decided Skippy, delegated by Stuart 2026-10-18, ui-architect-v3 ruling) keeps
// every toast centred on the window ON PURPOSE: that is what clears the permanent full-height
// right rail (`IconRail.tsx`) and the Session list header, which both only ever sit at the
// window's left/right edges, never its centre -- this holds regardless of which pane is
// focused or how a split (spec 005) happens to be divided; it is not "the toast falls on the
// splitter", and this is not a single static offset clearing every conflict -- the protection
// this story actually needs is VERTICAL. That part is NOT a fixed number: the textarea alone
// grows from `min-h-16` to `max-h-48` (`MessageInput.tsx`), and split panes (spec 005) mount TWO
// independent composers that can each be a different height at once. Gate round 1 fix (High,
// product/visual): `offset`/`mobileOffset` below read a live CSS custom property instead of a
// guessed static value -- `composerHeightVar.ts` tracks every mounted composer's own measured
// CLEARANCE (gate round 2 rename, Medium: not just height -- `StatusBar.tsx` renders BELOW the
// whole chat workspace, `App.tsx`, so a composer's own bottom edge never touches the window's
// bottom edge; clearance is measured from the composer's own TOP to the viewport bottom, which
// folds that in without hardcoding the StatusBar's height here) and publishes the MAX across
// however many composers are mounted, dropping an instance's entry on unmount, and re-measuring
// on window resize (the viewport height can change independently of any composer's own size).
// `mobileOffset` carries the SAME clearance value for `bottom`: Sonner's own
// `@media (max-width:600px)` rule (`node_modules/sonner`'s own CSS) switches `bottom` onto
// `--mobile-offset-bottom` instead of `--offset-bottom` -- leaving it unset would silently fall
// back to Sonner's bare 16px floor below 600px width, right back onto Send. Gate round 2 fix
// (High, Test): below 600px Sonner also makes the toast viewport-wide minus `2 * mobileOffset.
// left` (its own CSS: `width:calc(100% - var(--mobile-offset-left) * 2)`, confirmed in
// `node_modules/sonner`'s own dist), so with no `left`/`right` set that full-width toast
// overlapped the 40px right rail (`IconRail.tsx`); `left`/`right` both now `3.5rem` clear it on
// both edges (the toast's own width maths off `left` alone, but `right` is set too so the
// toaster's OWN box -- not just the individual toast -- is symmetric).
const TOAST_BOTTOM_OFFSET = 'calc(var(--refract-composer-clearance, 8rem) + 1.5rem)'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="bottom-center"
      offset={{ bottom: TOAST_BOTTOM_OFFSET }}
      mobileOffset={{ bottom: TOAST_BOTTOM_OFFSET, left: '3.5rem', right: '3.5rem' }}
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
