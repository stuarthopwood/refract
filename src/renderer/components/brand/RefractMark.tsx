import { useId } from 'react'
import type { SVGProps } from 'react'
import geometry from './mark-geometry.json'

/** The Refract brand mark: a refracted "pi" (one Pi, every angle) -- a single beam entering the
 * glyph and fanning into five coloured rays. Pure SVG so it stays crisp at any display size.
 *
 * `mark-geometry.json` is the single source of truth for the design (colours, positions): both
 * this component and `resources/brand/build-icons.mjs` (which rasterises the Windows app icon
 * and regenerates `resources/brand/*.svg`) read it, so the in-app mark and the app icon can never
 * drift apart. See `resources/brand/README.md` for how to regenerate the icon. */
export function RefractMark(props: SVGProps<SVGSVGElement>) {
  const id = useId()
  const { viewBox, background: bg, dotGrid, glow, fan, rays, piGlyph } = geometry

  const dotPositions = Array.from({ length: dotGrid.count }, (_, i) => dotGrid.start + i * dotGrid.step)

  return (
    <svg viewBox={`0 0 ${viewBox} ${viewBox}`} xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <clipPath id={`${id}-inner-clip`}>
          <rect
            x={bg.innerInset}
            y={bg.innerInset}
            width={viewBox - bg.innerInset * 2}
            height={viewBox - bg.innerInset * 2}
            rx={bg.innerRx}
          />
        </clipPath>
        <linearGradient id={`${id}-bg-grad`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={bg.bgGradFrom} />
          <stop offset="100%" stopColor={bg.bgGradTo} />
        </linearGradient>
        <linearGradient id={`${id}-pi-grad`} x1="0" y1="0" x2="1" y2="0.15">
          <stop offset="0%" stopColor={piGlyph.gradFrom} />
          <stop offset="100%" stopColor={piGlyph.gradTo} />
        </linearGradient>
        <radialGradient id={`${id}-flare`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
          <stop offset="45%" stopColor="#ffffff" stopOpacity={0.9} />
          <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
        <filter id={`${id}-blur-soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={10} />
        </filter>
        <filter id={`${id}-blur-tight`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={4} />
        </filter>
      </defs>

      <rect
        x={bg.outerInset}
        y={bg.outerInset}
        width={viewBox - bg.outerInset * 2}
        height={viewBox - bg.outerInset * 2}
        rx={bg.outerRx}
        fill={bg.outerFill}
      />
      <rect
        x={bg.innerInset}
        y={bg.innerInset}
        width={viewBox - bg.innerInset * 2}
        height={viewBox - bg.innerInset * 2}
        rx={bg.innerRx}
        fill={`url(#${id}-bg-grad)`}
      />

      <g clipPath={`url(#${id}-inner-clip)`}>
        {dotPositions.map((gy) =>
          dotPositions.map((gx) => (
            <circle key={`${gx}-${gy}`} cx={gx} cy={gy} r={dotGrid.radius} fill={dotGrid.color} />
          ))
        )}

        <line
          x1={glow.beamStartX}
          y1={glow.y}
          x2={glow.x}
          y2={glow.y}
          stroke="#ffffff"
          strokeWidth={glow.beamWidthSoft}
          strokeLinecap="round"
          opacity={0.35}
          filter={`url(#${id}-blur-soft)`}
        />
        <line
          x1={glow.beamStartX}
          y1={glow.y}
          x2={glow.x}
          y2={glow.y}
          stroke="#ffffff"
          strokeWidth={glow.beamWidthCore}
          strokeLinecap="round"
        />

        {rays.map((ray) => {
          const ty = glow.y + ray.dy
          const path =
            ray.dy === 0
              ? `M ${glow.x} ${glow.y} L ${fan.tipX} ${ty}`
              : `M ${glow.x} ${glow.y} L ${fan.elbowX} ${ty} L ${fan.tipX} ${ty}`
          return (
            <g key={ray.dy}>
              <path
                d={path}
                fill="none"
                stroke={ray.color}
                strokeWidth={fan.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx={fan.dot1X} cy={ty} r={fan.dotR} fill={ray.color} />
              <circle cx={fan.dot2X} cy={ty} r={fan.dotR} fill={ray.color} />
              <path
                d={`M ${fan.tipX - 2} ${ty - 13} L ${fan.tipX + 22} ${ty} L ${fan.tipX - 2} ${ty + 13} Z`}
                fill={ray.color}
              />
            </g>
          )
        })}

        <circle cx={glow.x} cy={glow.y} r={glow.flareR} fill={`url(#${id}-flare)`} filter={`url(#${id}-blur-tight)`} />
        <circle cx={glow.x} cy={glow.y} r={glow.coreR} fill="#ffffff" />

        <text
          x={piGlyph.x}
          y={piGlyph.y}
          fontFamily={piGlyph.fontFamily}
          fontSize={piGlyph.fontSize}
          textAnchor="middle"
          dominantBaseline="central"
          fill={`url(#${id}-pi-grad)`}
        >
          &#960;
        </text>
      </g>
    </svg>
  )
}
