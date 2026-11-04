import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useActiveThemeId } from "../../state/theme-store"
import { isLightTheme } from "../../../shared/themes"

const TOAST_BOTTOM_OFFSET = 'calc(var(--refract-composer-clearance, 8rem) + 1.5rem)'

const Toaster = ({ ...props }: ToasterProps) => {
  const light = isLightTheme(useActiveThemeId())
  return (
    <Sonner
      theme={light ? "light" : "dark"}
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
