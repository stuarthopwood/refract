import * as React from 'react'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { Input } from '@/components/ui/input'

type SecretInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>

/** A masked Input with a reveal toggle. Starts masked; the toggle keeps one label and flips `aria-pressed`. */
export function SecretInput({ className, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = React.useState(false)
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        {...props}
        type={revealed ? 'text' : 'password'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        className={`pr-9 ${className ?? ''}`}
      />
      <IconButton
        label="Show secret"
        aria-pressed={revealed}
        disabled={props.disabled}
        className="absolute right-1 top-1/2 -translate-y-1/2"
        onClick={() => setRevealed((value) => !value)}
      >
        {revealed ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
      </IconButton>
    </div>
  )
}
