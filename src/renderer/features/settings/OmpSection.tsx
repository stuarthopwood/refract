// #1212 (spec 021): Settings > OMP. Lists every value Refract itself sets for `omp` at launch
// (the token guard overlay), each marked "Set by Refract" with a reset to the default. The
// values live in Refract's own store, never in OMP's config files; a change applies to the next
// Session that launches.
import { useEffect, useRef } from 'react'
import { useTokenGuardStore } from '@/state/token-guard-store'
import { TOKEN_GUARD_KEYS } from '../../../shared/tokenGuard'
import { OmpValueRow } from './OmpValueRow'

export function OmpSection() {
  const { values, defaults, loaded, error, load, set, reset } = useTokenGuardStore()
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
    void load()
  }, [load])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Advanced
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Values Refract sets for OMP every time it starts a Session, to keep token use down. Changes apply to Sessions started afterwards; running Sessions keep the values they launched with.
      </p>
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {loaded && (
        <div className="flex flex-col divide-y divide-divider">
          {TOKEN_GUARD_KEYS.map((info) => (
            <OmpValueRow
              key={info.key}
              info={info}
              value={values[info.key]}
              defaultValue={defaults[info.key]}
              onChange={(value) => set(info.key, value)}
              onReset={() => void reset(info.key)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
