import type { ThinkingLevel } from '../../shared/ipc-model'
import { THINKING_LEVELS } from '@/lib/modelDisplay'

const LEVELS: readonly ThinkingLevel[] = THINKING_LEVELS.filter((lvl): lvl is Exclude<ThinkingLevel, 'inherit'> => lvl !== 'inherit')
const ARC_START_DEG = 150
const ARC_SWEEP_DEG = 240
const CENTER_X = 12
const CENTER_Y = 14
const NEEDLE_LENGTH = Math.hypot(4, 4)
const MEDIUM_INDEX = LEVELS.indexOf('medium')

function needleAngleDeg(level: string | null | undefined): number {
  const index = level ? (LEVELS as readonly string[]).indexOf(level) : -1
  const stepIndex = index === -1 ? MEDIUM_INDEX : index
  return ARC_START_DEG + (stepIndex * ARC_SWEEP_DEG) / (LEVELS.length - 1)
}

export function ReasoningGaugeIcon({ level, className }: { level?: string | null; className?: string }) {
  const angleRad = (needleAngleDeg(level) * Math.PI) / 180
  const needleX = CENTER_X + NEEDLE_LENGTH * Math.cos(angleRad)
  const needleY = CENTER_Y + NEEDLE_LENGTH * Math.sin(angleRad)
  return (
    <svg
      aria-hidden
      data-slot="reasoning-gauge"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={`M${CENTER_X} ${CENTER_Y}L${needleX.toFixed(2)} ${needleY.toFixed(2)}`} />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  )
}
