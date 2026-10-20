import * as React from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

// Catches a render error anywhere below it (e.g. a malformed TranscriptItem or PendingRequest
// from main, or a future component bug) so one bad item cannot blank the whole session list or
// chat pane; shows a compact recoverable Alert instead of a white screen. A plain class
// component: `getDerivedStateFromError`/`componentDidCatch` have no Hook equivalent.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[refract] render error', error, info.componentStack)
    // THROWAWAY (Main's decisive-run spec, item 3): a distinctive, grep-able marker separate
    // from the line above, captured by `verify-700-todo-pin.mjs`'s own `Runtime.consoleAPICalled`
    // listener -- proves or disproves an ErrorBoundary catch-and-reset cycle during the #700
    // live todo update. Revert with the rest of that throwaway diagnostic once decided.
    console.error('[EB]', error.message, info.componentStack)
  }

  private reload = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <Alert variant="destructive" className="max-w-md">
            <AlertTriangleIcon />
            <AlertTitle>Something went wrong rendering this view</AlertTitle>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={this.reload}>
                Reload view
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )
    }
    return this.props.children
  }
}
