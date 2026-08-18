import { Toaster as Sonner } from "sonner"
import { useTheme } from "@/lib/theme"

// The application's toast surface.
//
// Almost every panel in DashFlo reports what it just did through `toast` from
// sonner. Nothing rendered this component, so none of those calls drew anything:
// sonner's toast() posts to an observer, and with no <Toaster /> subscribed the
// message is discarded. Export and import, integrations, users, webhooks and the
// owner migration import all reported success and failure into that void. See
// App.jsx, which mounts this.
//
// Theme comes from lib/theme, the application's own manager, rather than from
// next-themes. next-themes was never mounted here either, so its useTheme
// returned "system" whatever the operator had chosen and a dark app would draw a
// light toast.

const Toaster = ({
  ...props
}) => {
  const { theme = "dark" } = useTheme()

  return (
    (<Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props} />)
  );
}

export { Toaster }
