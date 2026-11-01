/**
 * judge_report — pure-CSS five-dimension radar chart.
 *
 * No SVG, no canvas, no JavaScript: the grid is built from nested pentagons
 * clipped with `clip-path: polygon(...)`, axes are 1px rotated divs, and the
 * data polygon is one div whose clip-path points are computed from the five
 * dimension scores along each axis. Looks great in any renderer that allows
 * inline HTML + styles (VS Code, Typora, browsers).
 */

import { DIMENSION_LABELS, FIVE_DIMENSIONS } from '../types.js'
import type { DimensionScore } from '../types.js'

/** Axis angles for a pentagon with the first vertex pointing up (degrees). */
const AXIS_ANGLES = [-90, -18, 54, 126, 198]

/** Pentagon clip-path for the grid rings (unit pentagon, radius = 50%). */
const PENTAGON_POINTS = AXIS_ANGLES.map((angle) => {
  const radians = (angle * Math.PI) / 180
  return `${(50 + 50 * Math.cos(radians)).toFixed(3)}% ${(50 + 50 * Math.sin(radians)).toFixed(3)}%`
}).join(', ')

/** CSS position along an axis at a fraction of the radius. */
function pointOnAxis(angle: number, fraction: number): string {
  const radians = (angle * Math.PI) / 180
  return `${(50 + 50 * fraction * Math.cos(radians)).toFixed(3)}% ${(50 + 50 * fraction * Math.sin(radians)).toFixed(3)}%`
}

export interface RadarTheme {
  gridColor: string
  axisColor: string
  dataColor: string
  dataStroke: string
  labelColor: string
  scoreColor: string
  background: string
}

const DEFAULT_THEME: RadarTheme = {
  gridColor: 'rgba(120, 134, 160, 0.35)',
  axisColor: 'rgba(120, 134, 160, 0.55)',
  dataColor: 'rgba(64, 120, 255, 0.30)',
  dataStroke: 'rgb(64, 120, 255)',
  labelColor: '#c9d4e8',
  scoreColor: '#8be9fd',
  background: '#141824',
}

const RING_FRACTIONS = [0.25, 0.5, 0.75, 1]

/**
 * Render the radar chart as a self-contained HTML block.
 *
 * @param dimensions the five scored dimensions (any order; FIVE_DIMENSIONS order used)
 * @param size square edge length in pixels
 */
export function renderRadarHtml(dimensions: Record<string, DimensionScore> | DimensionScore[], size = 320, theme: Partial<RadarTheme> = {}): string {
  const t = { ...DEFAULT_THEME, ...theme }
  const ordered = Array.isArray(dimensions)
    ? FIVE_DIMENSIONS.map((dimension) => dimensions.find((entry) => entry.dimension === dimension)!)
    : FIVE_DIMENSIONS.map((dimension) => dimensions[dimension])
  const scores = ordered.map((entry) => entry?.score ?? 0)

  const rings = RING_FRACTIONS.map(
    (fraction) =>
      `<div style="position:absolute;left:0;top:0;width:100%;height:100%;clip-path:polygon(${PENTAGON_POINTS});transform:scale(${fraction});transform-origin:center;background:transparent;border:1px solid ${t.gridColor};"></div>`,
  ).join('\n')

  // Each axis is a 1px line from the center to its pentagon vertex.
  const axisLines = AXIS_ANGLES.map((angle) => {
    return `<div style="position:absolute;left:50%;top:50%;width:1px;height:50%;background:${t.axisColor};transform-origin:top center;transform:translate(-50%,0) rotate(${angle + 90}deg);"></div>`
  }).join('\n')

  const dataPoints = AXIS_ANGLES.map((angle, index) => pointOnAxis(angle, Math.max(0.02, scores[index] / 100))).join(', ')

  const labels = AXIS_ANGLES.map((angle, index) => {
    const [lx, ly] = pointOnAxis(angle, 1.22).split(' ')
    const score = scores[index]
    const label = DIMENSION_LABELS[FIVE_DIMENSIONS[index]]
    return `<div style="position:absolute;left:${lx};top:${ly};transform:translate(-50%,-50%);text-align:center;font:600 11px/1.35 'Segoe UI',system-ui,sans-serif;color:${t.labelColor};white-space:nowrap;">${label}<br><span style="color:${t.scoreColor};font-weight:700;">${score}</span></div>`
  }).join('\n')

  const vertexDots = AXIS_ANGLES.map((angle, index) => {
    const fraction = Math.max(0.02, scores[index] / 100)
    const [dx, dy] = pointOnAxis(angle, fraction).split(' ')
    return `<div style="position:absolute;left:${dx};top:${dy};width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:${t.dataStroke};box-shadow:0 0 6px ${t.dataStroke};"></div>`
  }).join('\n')

  return `<div class="omni-radar" style="position:relative;width:${size + 90}px;height:${size + 70}px;margin:12px auto;background:${t.background};border-radius:12px;padding:16px;box-sizing:border-box;box-shadow:inset 0 0 0 1px rgba(120,134,160,0.18);">
  <div style="position:relative;width:${size}px;height:${size}px;margin:24px auto;">
    ${rings}
    ${axisLines}
    <div style="position:absolute;left:0;top:0;width:100%;height:100%;clip-path:polygon(${dataPoints});background:${t.dataColor};"></div>
    ${vertexDots}
    ${labels}
  </div>
</div>`
}
