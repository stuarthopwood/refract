// Issue #1048 (Holiday touches): per-holiday content, kept in one place (renderer-only, unlike
// `shared/holidays.ts`'s pure calendar -- this imports lucide-react icon components, a
// renderer-only dependency) so every placement (watermark, start messages, sidebar accessory,
// empty states, the spinner glyph) reads from the same six-entry table instead of six
// hand-copied switch statements. Icon names checked against the installed lucide-react version
// (1.49.0, `pnpm ls lucide-react`) before use (issue's own "Technical notes and risks").
import { Flame, Ghost, PartyPopper, Pi, Swords, TreePine } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HolidayId } from '../../../shared/holidays'

export interface HolidayContent {
  id: HolidayId
  /** Shown nowhere on screen; only in comments/dev tooling. */
  name: string
  /** The glyph reused, unchanged, across the watermark, the sidebar accessory and the spinner
   * (decision 1's three icon-shaped placements) -- one icon per holiday, not three. Rendered
   * directly as a themed React icon (`color`/`stroke` set to a theme token at the call site),
   * never through a hand-made SVG asset or a CSS `mask-image` -- simpler, and every lucide icon
   * is already a flat, single-colour-ready line glyph. */
  icon: LucideIcon
  /** The leading emoji start-message lines use, `aria-hidden` by the same convention
   * `STARTING_MESSAGE_EMOJI` already uses (never embedded in the announced text). */
  emoji: string
  /** Appended to `STARTING_MESSAGES`/`STARTING_MESSAGE_EMOJI` in season (never announced, same
   * as every other entry in that pool, `startingMessages.ts`'s own header comment). */
  startingMessages: readonly string[]
  /** A short, purely decorative line shown alongside (never replacing) an empty state's own
   * guidance text -- `aria-hidden`, since it carries no information the sr-only description
   * does not already carry. */
  emptyStateLine: string
  /** `true` for the four holidays the issue's own "Ambient loops" section names an effect for
   * (snow/pumpkin-flicker/sparks); Star Wars Day and Pi Day get static artwork only -- the issue
   * never names an effect for either. */
  hasAmbientLoop: boolean
}

export const HOLIDAY_CONTENT: Record<HolidayId, HolidayContent> = {
  halloween: {
    id: 'halloween',
    name: 'Halloween',
    icon: Ghost,
    emoji: '🎃',
    startingMessages: ['Conjuring the agent from beyond…', "Trick-or-treating for the agent's tokens…"],
    emptyStateLine: '👻 Boo! Nothing here but ghosts.',
    hasAmbientLoop: true
  },
  'bonfire-night': {
    id: 'bonfire-night',
    name: 'Bonfire Night',
    icon: Flame,
    emoji: '🎇',
    startingMessages: ["Lighting the agent's fuse…", "Setting off the agent's sparks…"],
    emptyStateLine: '🎇 Quiet here -- save the sparks for later.',
    hasAmbientLoop: true
  },
  christmas: {
    id: 'christmas',
    name: 'Christmas',
    icon: TreePine,
    emoji: '🎄',
    startingMessages: ["Wrapping up the agent's presents…", 'Sleighing the agent into gear…'],
    emptyStateLine: '🎄 Nothing under this tree yet.',
    hasAmbientLoop: true
  },
  'new-year': {
    id: 'new-year',
    name: 'New Year',
    icon: PartyPopper,
    emoji: '🎉',
    startingMessages: ["Counting down to the agent's liftoff…", "Popping the agent's cork…"],
    emptyStateLine: '🎉 A fresh, empty start to the year.',
    hasAmbientLoop: true
  },
  'star-wars-day': {
    id: 'star-wars-day',
    name: 'Star Wars Day',
    icon: Swords,
    emoji: '⚔️',
    startingMessages: ['May the agent be with you…', 'Jumping the agent to lightspeed…'],
    emptyStateLine: '⚔️ A disturbance in the empty state.',
    hasAmbientLoop: false
  },
  'pi-day': {
    id: 'pi-day',
    name: 'Pi Day',
    icon: Pi,
    emoji: '🥧',
    startingMessages: ['Calculating the agent to a few more decimal places…', "Baking the agent's pie…"],
    emptyStateLine: '🥧 Nothing here, as irrational as that sounds.',
    hasAmbientLoop: false
  }
}
