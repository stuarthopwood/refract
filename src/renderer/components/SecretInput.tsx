import * as React from 'react'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { InputActionButton, InputWithAction } from '@/components/ui/input-with-action'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type SecretInputProps = Omit<React.ComponentProps<typeof InputWithAction>, 'type'>

/** A masked field with a reveal toggle. Starts masked; the button keeps one accessible name and flips `aria-pressed`, while the tooltip names the next action. */
export function SecretInput({ className, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = React.useState(false)
  return (
    <InputWithAction
      {...props}
      type={revealed ? 'text' : 'password'}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-secret-input
      className={className}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <InputActionButton
            aria-label="Show secret"
            aria-pressed={revealed}
            disabled={props.disabled}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </InputActionButton>
        </TooltipTrigger>
        <TooltipContent>{revealed ? 'Hide secret' : 'Show secret'}</TooltipContent>
      </Tooltip>
    </InputWithAction>
  )
}