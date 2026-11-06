// The eight edge motifs (wave, sun, leaf, moon, star, drop, ember, fern) as
// the browser build's DOM board drew them (js/motifs.js SVG_BODY, a −20…20
// view box), as SVG path data for draw.path: the engine parses them once, so
// the cards stay crisp at every interface scale and need no images.
import * as draw from "starhermit:draw";

interface Motif { fill?: string; stroke?: string; width?: number }
const ray = (x0: number, y0: number, x1: number, y1: number): string => `M${x0} ${y0}L${x1} ${y1}`;
const SUN_RAYS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a); return ray(c * 11, s * 11, c * 17, s * 17); }).join("");
const FERN = ray(0, 17, 0, -17) + ([[11, 11, 6.6], [2.6, 9, -1.4], [-5.4, 7, -9], [-12.6, 5, -15.6]] as const).map(([y, dx, y2]) => ray(0, y, -dx, y2) + ray(0, y, dx, y2)).join("");
const MOTIFS: Motif[] = [
  { stroke: "M-18 3Q-9-11 0 3Q9 17 18 3", width: 4 }, // wave
  { fill: "M7.6 0A7.6 7.6 0 1 1-7.6 0A7.6 7.6 0 1 1 7.6 0Z", stroke: SUN_RAYS, width: 2.6 }, // sun
  { fill: "M0-17Q14-2 0 11Q-14-2 0-17Z", stroke: "M0 11L0 18", width: 3.4 }, // leaf
  { fill: "M4.5-12.4A13.2 13.2 0 1 0 4.5 12.4A12.4 12.4 0 0 1 4.5-12.4Z" }, // moon
  { fill: "M0-17L4.4-6.1L16.2-5.3L7.1 2.3L10 13.7L0 7.4L-10 13.7L-7.1 2.3L-16.2-5.3L-4.4-6.1Z" }, // star
  { fill: "M0-17C13-1 10 15 0 15C-10 15-13-1 0-17Z" }, // drop
  { fill: "M0-17Q15 2 7 14Q0 19-7 14Q-15 2 0-17ZM0-2Q5 7 0 12Q-5 7 0-2Z" }, // ember, its notch cut out
  { stroke: FERN, width: 3 }, // fern
];

/** Draws motif `id` centred at (cx, cy) in a `size`-pixel box (the SVG's 40 units), turned `turn` radians clockwise, in `color`. */
export function drawMotif(id: number, cx: number, cy: number, size: number, turn: number, color: string): void {
  const m = MOTIFS[((id % 8) + 8) % 8]!;
  const scale = size / 40;
  if (m.fill) draw.path(m.fill, cx, cy, { fill: color, scale, rotation: turn, fillRule: "evenodd" });
  if (m.stroke) draw.path(m.stroke, cx, cy, { stroke: color, scale, rotation: turn, lineWidth: Math.max(1 / scale, m.width!), lineCap: "round", lineJoin: "round" });
}
