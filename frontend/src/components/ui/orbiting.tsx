'use client'

// Starpath OrbitingSystem — adapted from a 21st.dev orbiting-skills
// pattern, retuned to the galaxy palette and product motion language.
// Differences from the source:
//   - cyan / generic-purple palette → galaxy-violet variants only
//   - speeds halved (the source ran fast enough to feel busy)
//   - no decorative "glow rings" pulsing on the orbit paths — a single
//     hairline ring per orbit reads as a precision tool, not a demo
//   - rAF + transform instead of motion library (one fewer abstraction
//     layer; orbiters are memo'd so cost is just a transform per frame)
//   - prefers-reduced-motion freezes the orbit but keeps the layout
//   - hover anywhere pauses the system; orbiters get a tooltip + glow

import React, { useEffect, useState, memo } from 'react'
import { cn } from '@/lib/utils'

export interface OrbiterConfig {
  id: string
  /** Orbiter outer diameter in px. */
  size: number
  /** Glow color cast on hover — typically scoreColor() of the value. */
  glow?: string
  /** Initial radians offset along the orbit. */
  phase: number
  /** Tooltip label shown on hover. */
  label: string
  onClick?: () => void
  /** Rendered inside the orbiter (logo / text / icon). */
  content: React.ReactNode
}

export interface OrbitingSystemProps {
  center: React.ReactNode
  innerOrbit: OrbiterConfig[]
  outerOrbit?: OrbiterConfig[]
  /** Inner orbit radius in px (orbit path centerline). */
  innerRadius?: number
  /** Outer orbit radius in px. */
  outerRadius?: number
  /** Inner orbit angular speed (rad/s). Positive = clockwise. */
  innerSpeed?: number
  /** Outer orbit angular speed (rad/s). Default counter-clockwise. */
  outerSpeed?: number
  /** Wrapper square size in px. Should be >= 2 * outerRadius + outer max size. */
  size?: number
  className?: string
}

export function OrbitingSystem({
  center,
  innerOrbit,
  outerOrbit = [],
  innerRadius = 92,
  outerRadius = 168,
  innerSpeed = 0.18,
  outerSpeed = -0.12,
  size = 380,
  className,
}: OrbitingSystemProps) {
  // Two independent angle accumulators — one per orbit ring. Each is
  // paused independently when the user hovers an orbiter on that ring,
  // so hovering a role still lets the companies orbit (and vice versa).
  // Hovering empty space pauses neither.
  const [innerAngle, setInnerAngle] = useState(0)
  const [outerAngle, setOuterAngle] = useState(0)
  const [innerPaused, setInnerPaused] = useState(false)
  const [outerPaused, setOuterPaused] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (!innerPaused) setInnerAngle(a => a + dt * innerSpeed)
      if (!outerPaused) setOuterAngle(a => a + dt * outerSpeed)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [innerPaused, outerPaused, innerSpeed, outerSpeed])

  return (
    <div
      className={cn('relative flex items-center justify-center select-none', className)}
      style={{ width: size, height: size }}
    >
      <OrbitPath radius={innerRadius} />
      {outerOrbit.length > 0 && <OrbitPath radius={outerRadius} subtle />}

      <div className="relative z-20">{center}</div>

      {innerOrbit.map(o => (
        <Orbiter
          key={o.id}
          config={o}
          radius={innerRadius}
          angle={innerAngle + o.phase}
          onHoverChange={setInnerPaused}
        />
      ))}
      {outerOrbit.map(o => (
        <Orbiter
          key={o.id}
          config={o}
          radius={outerRadius}
          angle={outerAngle + o.phase}
          onHoverChange={setOuterPaused}
        />
      ))}
    </div>
  )
}

// --- Orbit path: a single hairline ring; a faint inset wash gives it
// just enough presence to read as "you are bound to this circle" ---
const OrbitPath = memo(({ radius, subtle = false }: { radius: number; subtle?: boolean }) => (
  <div
    aria-hidden
    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
    style={{
      width: radius * 2,
      height: radius * 2,
      border: `1px solid rgba(124, 92, 255, ${subtle ? 0.10 : 0.16})`,
      boxShadow: `inset 0 0 ${subtle ? 16 : 24}px rgba(124, 92, 255, ${subtle ? 0.025 : 0.045})`,
    }}
  />
))
OrbitPath.displayName = 'OrbitPath'

// --- Orbiter: a memo'd round button positioned via cos/sin of angle.
// Because angle is a prop, the component re-renders every frame the
// parent ticks. memo doesn't help across angle changes; what it DOES
// help is preventing re-render on unrelated parent state changes. ---
const Orbiter = memo(({
  config,
  angle,
  radius,
  onHoverChange,
}: {
  config: OrbiterConfig
  angle: number
  radius: number
  /** Notifies the OrbitingSystem so it can pause this orbiter's
   *  ring (and only this ring) while the cursor sits on it. */
  onHoverChange?: (hovered: boolean) => void
}) => {
  const [hover, setHover] = useState(false)
  const x = Math.cos(angle) * radius
  const y = Math.sin(angle) * radius
  const glow = config.glow ?? '#7C5CFF'
  return (
    <button
      type="button"
      onClick={config.onClick}
      aria-label={config.label}
      onMouseEnter={() => { setHover(true);  onHoverChange?.(true) }}
      onMouseLeave={() => { setHover(false); onHoverChange?.(false) }}
      className={cn(
        'absolute top-1/2 left-1/2 rounded-full bg-bg-base border flex items-center justify-center',
        'transition-[transform,box-shadow,border-color] duration-200 ease-quart',
        hover ? 'border-accent/40 z-30' : 'border-border-default',
      )}
      style={{
        width: config.size,
        height: config.size,
        transform: `translate(calc(${x}px - 50%), calc(${y}px - 50%)) scale(${hover ? 1.18 : 1})`,
        boxShadow: hover
          ? `0 0 22px ${glow}55, 0 0 44px ${glow}28, 0 2px 6px rgba(76, 47, 200, 0.10)`
          : '0 1px 3px rgba(76, 47, 200, 0.10), 0 2px 6px rgba(0, 0, 0, 0.04)',
      }}
    >
      {config.content}
      {hover && (
        <span
          className="absolute -bottom-7 left-1/2 -translate-x-1/2 px-2 py-1 rounded-md bg-galaxy-matte text-white text-[10px] tracking-tight whitespace-nowrap pointer-events-none"
          style={{ boxShadow: '0 4px 12px rgba(10, 8, 32, 0.30)' }}
        >
          {config.label}
        </span>
      )}
    </button>
  )
})
Orbiter.displayName = 'Orbiter'
