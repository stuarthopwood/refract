import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useActiveThemeId } from "../../state/theme-store"
import { isLightTheme } from "../../../shared/themes"

const TOAST_BOTTOM_OFFSET = 'calc(var(--refract-composer-clearance, 8rem) + 1.5rem)'

// The severity word is the non-colour cue; the icon is decorative.
function SeverityIcon({ icon: Icon, className, label }: { icon: LucideIcon; className: string; label: string }) {
  return (
    <>
      <Icon className={cn("size-4", className)} aria-hidden="true" />
      <span className="sr-only">{label}:</span>
    </>
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  const light = isLightTheme(useActiveThemeId())
  return (
    <Sonner
      theme={light ? "light" : "dark"}
      position="bottom-center"
      offset={{ bottom: TOAST_BOTTOM_OFFSET }}
      mobileOffset={{ bottom: TOAST_BOTTOM_OFFSET, left: '3.5rem', right: '3.5rem' }}
      icons={{
        success: <SeverityIcon icon={CircleCheckIcon} className="text-severity-success" label="Success" />,
        info: <SeverityIcon icon={InfoIcon} className="text-severity-info" label="Info" />,
        warning: <SeverityIcon icon={TriangleAlertIcon} className="text-severity-warning" label="Warning" />,
        error: <SeverityIcon icon={OctagonXIcon} className="text-severity-error" label="Error" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Top-right, matching the dismiss affordance elsewhere; sonner defaults to top-left.
          "--toast-close-button-start": "unset",
          "--toast-close-button-end": "0",
          "--toast-close-button-transform": "translate(35%, -35%)",
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
