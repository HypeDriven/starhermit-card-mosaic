// The eight edge motifs (wave, sun, leaf, moon, star, drop, ember, fern) as
// the browser build's DOM board drew them (js/motifs.js SVG_BODY, a −20…20
// view box), turned into starhermit:draw primitives: filled outlines are
// polygons (curves sampled once), strokes are line segments with round joints
// stood in by small discs. Drawn per frame at any size and quarter turn, so
// the cards stay crisp at every interface scale and need no images.
import * as draw from "starhermit:draw";

type Pt = [number, number];
interface Motif { fills: Pt[][]; holes: Pt[][]; strokes: { pts: Pt[]; width: number }[]; discs: { x: number; y: number; r: number }[] }

function quad(out: Pt[], p0: Pt, c: Pt, p1: Pt, n = 12): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
}
function cubic(out: Pt[], p0: Pt, c1: Pt, c2: Pt, p1: Pt, n = 14): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
}
function arc(out: Pt[], cx: number, cy: number, r: number, a0: number, a1: number, n: number): void {
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
}
const circle = (r: number, n = 20): Pt[] => { const p: Pt[] = []; arc(p, 0, 0, r, 0, Math.PI * 2 * (1 - 1 / n), n - 1); return p; };

function build(): Motif[] {
  const m: Motif[] = [];
  // 0 Wave: M -18 3 Q -9 -11 0 3 Q 9 17 18 3, stroke 4, round caps
  {
    const pts: Pt[] = [[-18, 3]];
    quad(pts, [-18, 3], [-9, -11], [0, 3]);
    quad(pts, [0, 3], [9, 17], [18, 3]);
    m.push({ fills: [], holes: [], strokes: [{ pts, width: 4 }], discs: [{ x: -18, y: 3, r: 2 }, { x: 18, y: 3, r: 2 }] });
  }
  // 1 Sun: disc r 7.6, eight rays 11 → 17, stroke 2.6
  {
    const strokes: Motif["strokes"] = [];
    const discs: Motif["discs"] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const c = Math.cos(a), s = Math.sin(a);
      strokes.push({ pts: [[c * 11, s * 11], [c * 17, s * 17]], width: 2.6 });
      discs.push({ x: c * 17, y: s * 17, r: 1.3 }, { x: c * 11, y: s * 11, r: 1.3 });
    }
    m.push({ fills: [circle(7.6)], holes: [], strokes, discs });
  }
  // 2 Leaf: M 0 -17 Q 14 -2 0 11 Q -14 -2 0 -17 Z, stem 0,11 → 0,18 stroke 3.4
  {
    const p: Pt[] = [[0, -17]];
    quad(p, [0, -17], [14, -2], [0, 11]);
    quad(p, [0, 11], [-14, -2], [0, -17]);
    p.pop();
    m.push({ fills: [p], holes: [], strokes: [{ pts: [[0, 11], [0, 18]], width: 3.4 }], discs: [{ x: 0, y: 18, r: 1.7 }] });
  }
  // 3 Moon: the crescent between the r 13 circle's left arc and the r 12.4
  // half circle about (4.5, 0) bulging left (the SVG's scaled-up arc)
  {
    const p: Pt[] = [];
    const a0 = Math.atan2(-12.4, 4.5), a1 = Math.atan2(12.4, 4.5);
    // outer: from the top point counter-clockwise on screen round the left to the bottom
    arc(p, 0, 0, 13.2, a0, a1 - Math.PI * 2, 28);
    // inner: from the bottom through (-7.9, 0) back to the top
    const inner: Pt[] = [];
    arc(inner, 4.5, 0, 12.4, Math.PI / 2, (3 * Math.PI) / 2, 18);
    p.push(...inner.slice(1, -1));
    m.push({ fills: [p], holes: [], strokes: [], discs: [] });
  }
  // 4 Star
  m.push({ fills: [[[0, -17], [4.4, -6.1], [16.2, -5.3], [7.1, 2.3], [10, 13.7], [0, 7.4], [-10, 13.7], [-7.1, 2.3], [-16.2, -5.3], [-4.4, -6.1]]], holes: [], strokes: [], discs: [] });
  // 5 Drop: M 0 -17 C 13 -1 10 15 0 15 C -10 15 -13 -1 0 -17 Z
  {
    const p: Pt[] = [[0, -17]];
    cubic(p, [0, -17], [13, -1], [10, 15], [0, 15]);
    cubic(p, [0, 15], [-10, 15], [-13, -1], [0, -17]);
    p.pop();
    m.push({ fills: [p], holes: [], strokes: [], discs: [] });
  }
  // 6 Ember: M 0 -17 Q 15 2 7 14 Q 0 19 -7 14 Q -15 2 0 -17 Z with the notch
  // M 0 -2 Q 5 7 0 12 Q -5 7 0 -2 Z cut out (drawn in the card's face colour)
  {
    const p: Pt[] = [[0, -17]];
    quad(p, [0, -17], [15, 2], [7, 14]);
    quad(p, [7, 14], [0, 19], [-7, 14], 8);
    quad(p, [-7, 14], [-15, 2], [0, -17]);
    p.pop();
    const h: Pt[] = [[0, -2]];
    quad(h, [0, -2], [5, 7], [0, 12], 8);
    quad(h, [0, 12], [-5, 7], [0, -2], 8);
    h.pop();
    m.push({ fills: [p], holes: [h], strokes: [], discs: [] });
  }
  // 7 Fern: stem and four pairs of barbs, stroke 3
  {
    const strokes: Motif["strokes"] = [{ pts: [[0, 17], [0, -17]], width: 3 }];
    const discs: Motif["discs"] = [{ x: 0, y: 17, r: 1.5 }, { x: 0, y: -17, r: 1.5 }];
    const barbs: [number, number, number][] = [[11, 11, 6.6], [2.6, 9, -1.4], [-5.4, 7, -9], [-12.6, 5, -15.6]];
    for (const [y, dx, y2] of barbs) {
      strokes.push({ pts: [[0, y], [-dx, y2]], width: 3 }, { pts: [[0, y], [dx, y2]], width: 3 });
      discs.push({ x: -dx, y: y2, r: 1.5 }, { x: dx, y: y2, r: 1.5 });
    }
    m.push({ fills: [], holes: [], strokes, discs });
  }
  return m;
}
const MOTIFS = build();
const DISC = circle(1, 10);

/**
 * Draws motif `id` centred at (cx, cy) in a `size`-pixel box (the SVG's 40
 * units), turned `turn` radians clockwise, in `color`; `hole` is the colour
 * under it (the ember's notch).
 */
export function drawMotif(id: number, cx: number, cy: number, size: number, turn: number, color: string, hole: string, clip?: draw.Clip): void {
  const m = MOTIFS[((id % 8) + 8) % 8]!;
  const k = size / 40;
  const c = Math.cos(turn), s = Math.sin(turn);
  const tf = (p: Pt): [number, number] => [cx + (p[0] * c - p[1] * s) * k, cy + (p[0] * s + p[1] * c) * k];
  for (const f of m.fills) draw.polygon(f.map(tf), color, clip);
  for (const h of m.holes) draw.polygon(h.map(tf), hole, clip);
  for (const st of m.strokes) {
    const w = Math.max(1, st.width * k);
    for (let i = 1; i < st.pts.length; i++) {
      const a = tf(st.pts[i - 1]!), b = tf(st.pts[i]!);
      draw.line(a[0], a[1], b[0], b[1], color, w, clip);
    }
  }
  if (size >= 10) {
    for (const d of m.discs) {
      const [x, y] = tf([d.x, d.y]);
      const r = d.r * k;
      draw.polygon(DISC.map((p) => [x + p[0] * r, y + p[1] * r] as [number, number]), color, clip);
    }
  }
}
