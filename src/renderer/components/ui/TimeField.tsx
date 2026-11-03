import * as React from "react"
import { ClockIcon } from "lucide-react"
import { IconButton } from "@/components/IconButton"
import { Input } from "@/components/ui/input"
import { InlineStatus } from "@/components/InlineStatus"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const pad = (n: number): string => String(n).padStart(2, "0")
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i))
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i))
const TYPE_AHEAD_MS = 800

/** Normalises `H:MM` or `HH:MM` (24-hour) to `HH:MM`; anything else is `""`. */
function parseTime(text: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return ""
  const [hour, minute] = [Number(match[1]), Number(match[2])]
  return hour <= 23 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : ""
}

interface TimeColumnProps {
  label: string
  options: string[]
  selected: string | undefined
  listRef: React.RefObject<HTMLDivElement | null>
  onPick: (option: string) => void
  /** Called with -1 or 1 when the left or right arrow asks to move to a neighbouring column. */
  onSide: (direction: -1 | 1) => void
}

/** One scrollable listbox of two-digit options; the selected one is accent text with no fill. */
function TimeColumn({ label, options, selected, listRef, onPick, onSide }: TimeColumnProps) {
  const prefix = React.useId()
  const [active, setActive] = React.useState(() => Math.max(0, selected ? options.indexOf(selected) : 0))
  const typed = React.useRef({ text: "", at: 0 })
  const centred = React.useRef(false)

  // The first run centres the selection; later runs only scroll as far as needed to reveal the option.
  React.useEffect(() => {
    const list = listRef.current
    const option = document.getElementById(`${prefix}-${active}`)
    if (!list || !option) return
    const bottom = option.offsetTop + option.offsetHeight
    if (!centred.current) list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2
    else if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
    centred.current = true
  }, [active, listRef, prefix])

  const typeDigit = (digit: string) => {
    const now = Date.now()
    let text = now - typed.current.at > TYPE_AHEAD_MS ? digit : typed.current.text + digit
    let index = options.indexOf(text.length === 1 ? `0${text}` : text.slice(-2))
    if (index < 0) {
      text = digit
      index = options.indexOf(`0${digit}`)
    }
    typed.current = { text, at: now }
    if (index >= 0) setActive(index)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const last = options.length - 1
    const moves: Record<string, number> = {
      ArrowDown: Math.min(active + 1, last),
      ArrowUp: Math.max(active - 1, 0),
      Home: 0,
      End: last
    }
    const move = moves[event.key]
    if (move !== undefined) setActive(move)
    else if (event.key === "Enter" || event.key === " ") onPick(options[active] ?? "00")
    else if (event.key === "ArrowLeft") onSide(-1)
    else if (event.key === "ArrowRight") onSide(1)
    else if (/^\d$/.test(event.key)) typeDigit(event.key)
    else return
    event.preventDefault()
  }

  return (
    <div className="flex flex-col gap-1">
      <span id={`${prefix}-label`} className="px-2 text-xs text-muted-foreground">
        {label}
      </span>
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-labelledby={`${prefix}-label`}
        aria-activedescendant={`${prefix}-${active}`}
        onKeyDown={onKeyDown}
        className="group/column relative h-40 w-16 overflow-y-auto rounded-md outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        {options.map((option, index) => (
          <div
            key={option}
            id={`${prefix}-${index}`}
            role="option"
            aria-selected={option === selected}
            data-active={index === active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setActive(index)
              onPick(option)
            }}
            className="flex h-7 cursor-default items-center justify-center rounded-md text-sm tabular-nums hover:bg-muted group-focus-visible/column:data-[active=true]:bg-muted group-focus-visible/column:data-[active=true]:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] aria-selected:font-medium aria-selected:text-accent-text"
          >
            {option}
          </div>
        ))}
      </div>
    </div>
  )
}

type TimeFieldProps = Omit<React.ComponentProps<typeof Input>, "type" | "value" | "onChange" | "ref"> & {
  /** `HH:MM` (24-hour), or `""` while the typed text is not a valid time. */
  value: string
  onChange: (value: string) => void
}

/** A themed time field: type `H:MM` or `HH:MM`, or open the clock popover and pick hour then minute.
 * Replaces the native time input, whose popup the WebView draws outside the theme. */
function TimeField({ value, onChange, disabled, className, onBlur, ...props }: TimeFieldProps) {
  const [draft, setDraft] = React.useState(value)
  const [seen, setSeen] = React.useState(value)
  const [blurred, setBlurred] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const hoursRef = React.useRef<HTMLDivElement | null>(null)
  const minutesRef = React.useRef<HTMLDivElement | null>(null)
  const outsideClose = React.useRef(false)

  // A value that changed from outside the typed text (a popover pick) replaces the draft.
  if (value !== seen) {
    setSeen(value)
    if (value !== parseTime(draft)) setDraft(value)
  }

  const hour = value ? value.slice(0, 2) : undefined
  const minute = value ? value.slice(3, 5) : undefined

  const errorId = React.useId()
  const invalid = blurred && draft !== "" && !parseTime(draft)
  const describedBy = [props["aria-describedby"], invalid ? errorId : undefined].filter(Boolean).join(" ") || undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div data-slot="time-field" className="relative">
          <Input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            placeholder="HH:MM"
            disabled={disabled}
            aria-invalid={invalid ? true : undefined}
            className={`pr-10 tabular-nums${className ? ` ${className}` : ""}`}
            {...props}
            aria-describedby={describedBy}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setBlurred(false)
              onChange(parseTime(event.target.value))
            }}
            onBlur={(event) => {
              const parsed = parseTime(draft)
              if (parsed) setDraft(parsed)
              setBlurred(true)
              onBlur?.(event)
            }}
          />
          {invalid && (
            <InlineStatus id={errorId} tone="error" density="compact" className="px-0">
              Enter a time as HH:MM
            </InlineStatus>
          )}
          <PopoverTrigger asChild>
            <IconButton label="Choose time" size="icon-xs" disabled={disabled} className="absolute top-1 right-1">
              <ClockIcon aria-hidden />
            </IconButton>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        aria-label="Choose time"
        className="flex w-auto gap-1 p-2"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          outsideClose.current = false
          hoursRef.current?.focus()
        }}
        onInteractOutside={() => {
          outsideClose.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // An outside click leaves focus where the user clicked.
          if (!outsideClose.current) inputRef.current?.focus()
        }}
      >
        <TimeColumn
          label="Hours"
          options={HOURS}
          selected={hour}
          listRef={hoursRef}
          onPick={(picked) => {
            onChange(`${picked}:${minute ?? "00"}`)
            minutesRef.current?.focus()
          }}
          onSide={(direction) => direction > 0 && minutesRef.current?.focus()}
        />
        <TimeColumn
          label="Minutes"
          options={MINUTES}
          selected={minute}
          listRef={minutesRef}
          onPick={(picked) => {
            onChange(`${hour ?? "00"}:${picked}`)
            setOpen(false)
          }}
          onSide={(direction) => direction < 0 && hoursRef.current?.focus()}
        />
      </PopoverContent>
    </Popover>
  )
}

export { TimeField }
