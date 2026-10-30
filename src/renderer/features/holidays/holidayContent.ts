import { Flame, Ghost, PartyPopper, Pi, Swords, TreePine } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HolidayId } from '../../../shared/holidays'

/** Copy and visuals for one holiday theme. */
export interface HolidayContent {
  icon: LucideIcon
  emoji: string
  startingMessages: readonly string[]
  emptyStateLine: string
  hasAmbientLoop: boolean
}

/** Content for every holiday id. */
export const HOLIDAY_CONTENT: Record<HolidayId, HolidayContent> = {
  halloween: {
    icon: Ghost,
    emoji: '🎃',
    startingMessages: ['Conjuring the agent from beyond…', "Trick-or-treating for the agent's tokens…"],
    emptyStateLine: '👻 Boo! Nothing here but ghosts.',
    hasAmbientLoop: true
  },
  'bonfire-night': {
    icon: Flame,
    emoji: '🎇',
    startingMessages: ["Lighting the agent's fuse…", "Setting off the agent's sparks…"],
    emptyStateLine: '🎇 Quiet here — save the sparks for later.',
    hasAmbientLoop: true
  },
  christmas: {
    icon: TreePine,
    emoji: '🎄',
    startingMessages: ["Wrapping up the agent's presents…", 'Sleighing the agent into gear…'],
    emptyStateLine: '🎄 Nothing under this tree yet.',
    hasAmbientLoop: true
  },
  'new-year': {
    icon: PartyPopper,
    emoji: '🎉',
    startingMessages: ["Counting down to the agent's liftoff…", "Popping the agent's cork…"],
    emptyStateLine: '🎉 A fresh, empty start to the year.',
    hasAmbientLoop: true
  },
  'star-wars-day': {
    icon: Swords,
    emoji: '⚔️',
    startingMessages: ['May the agent be with you…', 'Jumping the agent to lightspeed…'],
    emptyStateLine: '⚔️ A disturbance in the empty state.',
    hasAmbientLoop: false
  },
  'pi-day': {
    icon: Pi,
    emoji: '🥧',
    startingMessages: ['Calculating the agent to a few more decimal places…', "Baking the agent's pie…"],
    emptyStateLine: '🥧 Nothing here, as irrational as that sounds.',
    hasAmbientLoop: false
  }
}
