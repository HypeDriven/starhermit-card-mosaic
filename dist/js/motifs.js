// motifs.js — original edge-motif glyph artwork, drawn procedurally.
// Two output paths from one definition:
//   drawMotif(ctx, id, x, y, size, color)  — canvas 2D (card textures for 3D)
//   motifSvg(id, color, size)              — inline SVG string (DOM mirror)
// Glyph shapes are the primary channel; color reinforces (accessibility).

/** Draw motif glyph id (0..7) centered at (x,y) within `size` box. */
export function drawMotif(ctx, id, x, y, size, color) {
  const s = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, size * 0.09);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (id % 8) {
    case 0: // Wave — two arcs
      ctx.beginPath();
      ctx.moveTo(-s * 0.9, s * 0.15);
      ctx.quadraticCurveTo(-s * 0.45, -s * 0.55, 0, s * 0.15);
      ctx.quadraticCurveTo(s * 0.45, s * 0.85, s * 0.9, s * 0.15);
      ctx.stroke();
      break;
    case 1: // Sun — disc with rays
      ctx.beginPath(); ctx.arc(0, 0, s * 0.38, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(1.2, size * 0.06);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55);
        ctx.lineTo(Math.cos(a) * s * 0.85, Math.sin(a) * s * 0.85);
        ctx.stroke();
      }
      break;
    case 2: // Leaf — pointed oval with stem
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.85);
      ctx.quadraticCurveTo(s * 0.7, -s * 0.1, 0, s * 0.55);
      ctx.quadraticCurveTo(-s * 0.7, -s * 0.1, 0, -s * 0.85);
      ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, s * 0.55); ctx.lineTo(0, s * 0.9);
      ctx.strokeStyle = color; ctx.stroke();
      break;
    case 3: // Moon — crescent
      ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(s * 0.3, -s * 0.18, s * 0.52, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      break;
    case 4: // Star — 5-point
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? s * 0.85 : s * 0.36;
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      break;
    case 5: // Drop — teardrop
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.85);
      ctx.bezierCurveTo(s * 0.65, -s * 0.05, s * 0.5, s * 0.75, 0, s * 0.75);
      ctx.bezierCurveTo(-s * 0.5, s * 0.75, -s * 0.65, -s * 0.05, 0, -s * 0.85);
      ctx.fill();
      break;
    case 6: // Ember — flame triangle with notch
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.85);
      ctx.quadraticCurveTo(s * 0.75, s * 0.1, s * 0.35, s * 0.7);
      ctx.quadraticCurveTo(0, s * 0.95, -s * 0.35, s * 0.7);
      ctx.quadraticCurveTo(-s * 0.75, s * 0.1, 0, -s * 0.85);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.moveTo(0, -s * 0.1);
      ctx.quadraticCurveTo(s * 0.25, s * 0.35, 0, s * 0.6);
      ctx.quadraticCurveTo(-s * 0.25, s * 0.35, 0, -s * 0.1);
      ctx.fill();
      ctx.restore();
      break;
    case 7: // Fern — stem with barbs
      ctx.beginPath(); ctx.moveTo(0, s * 0.85); ctx.lineTo(0, -s * 0.85); ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.06);
      for (let i = 0; i < 4; i++) {
        const yy = s * 0.55 - i * s * 0.42;
        const len = s * (0.55 - i * 0.09);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(-len, yy - s * 0.22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(len, yy - s * 0.22); ctx.stroke();
      }
      break;
  }
  ctx.restore();
}

const SVG_BODY = [
  // 0 Wave
  '<path d="M -18 3 Q -9 -11 0 3 Q 9 17 18 3" fill="none" stroke="C" stroke-width="4" stroke-linecap="round"/>',
  // 1 Sun
  '<circle r="7.6" fill="C"/><g stroke="C" stroke-width="2.6" stroke-linecap="round">' +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const r = (a * Math.PI) / 180;
      return `<line x1="${(Math.cos(r) * 11).toFixed(1)}" y1="${(Math.sin(r) * 11).toFixed(1)}" x2="${(Math.cos(r) * 17).toFixed(1)}" y2="${(Math.sin(r) * 17).toFixed(1)}"/>`;
    }).join('') + '</g>',
  // 2 Leaf
  '<path d="M 0 -17 Q 14 -2 0 11 Q -14 -2 0 -17 Z" fill="C"/><line x1="0" y1="11" x2="0" y2="18" stroke="C" stroke-width="3.4" stroke-linecap="round"/>',
  // 3 Moon
  '<path d="M 4.5 -12.4 A 13 13 0 1 0 4.5 12.4 A 10.5 10.5 0 1 1 4.5 -12.4 Z" fill="C"/>',
  // 4 Star
  '<path d="M 0 -17 L 4.4 -6.1 L 16.2 -5.3 L 7.1 2.3 L 10 13.7 L 0 7.4 L -10 13.7 L -7.1 2.3 L -16.2 -5.3 L -4.4 -6.1 Z" fill="C"/>',
  // 5 Drop
  '<path d="M 0 -17 C 13 -1 10 15 0 15 C -10 15 -13 -1 0 -17 Z" fill="C"/>',
  // 6 Ember
  '<path d="M 0 -17 Q 15 2 7 14 Q 0 19 -7 14 Q -15 2 0 -17 Z M 0 -2 Q 5 7 0 12 Q -5 7 0 -2 Z" fill="C" fill-rule="evenodd"/>',
  // 7 Fern
  '<g stroke="C" stroke-width="3" stroke-linecap="round" fill="none"><line x1="0" y1="17" x2="0" y2="-17"/>' +
    '<line x1="0" y1="11" x2="-11" y2="6.6"/><line x1="0" y1="11" x2="11" y2="6.6"/>' +
    '<line x1="0" y1="2.6" x2="-9" y2="-1.4"/><line x1="0" y1="2.6" x2="9" y2="-1.4"/>' +
    '<line x1="0" y1="-5.4" x2="-7" y2="-9"/><line x1="0" y1="-5.4" x2="7" y2="-9"/>' +
    '<line x1="0" y1="-12.6" x2="-5" y2="-15.6"/><line x1="0" y1="-12.6" x2="5" y2="-15.6"/></g>',
];

/** Inline SVG for motif id, viewBox -20..20. `size` in px. */
export function motifSvg(id, color, size = 20) {
  const body = SVG_BODY[id % 8].replaceAll('C', color);
  return `<svg width="${size}" height="${size}" viewBox="-20 -20 40 40" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Render a full card face to a canvas: parchment base, thin frame, and the
 * four edge motifs near their respective edges. Used to build 3D card textures.
 * edges = [N,E,S,W] motif ids; colors = motif color per motif id.
 */
export function paintCardFace(canvas, edges, colors, opts = {}) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const face = opts.face || '#f6efe3';
  const frame = opts.frame || '#d8cdb8';
  ctx.clearRect(0, 0, size, size);
  // base with subtle radial vignette
  ctx.fillStyle = face;
  ctx.fillRect(0, 0, size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // frame
  ctx.strokeStyle = frame;
  ctx.lineWidth = size * 0.035;
  ctx.strokeRect(size * 0.04, size * 0.04, size * 0.92, size * 0.92);
  // edge motifs: N top-center, E right-center, S bottom-center, W left-center
  const m = size * 0.155;       // distance from edge
  const ms = size * 0.16;       // motif glyph size
  const mid = size / 2;
  const pos = [[mid, m], [size - m, mid], [mid, size - m], [m, mid]];
  for (let d = 0; d < 4; d++) {
    drawMotif(ctx, edges[d], pos[d][0], pos[d][1], ms, colors[edges[d]]);
  }
  // center medallion: mini ring of all four motifs for readability at distance
  if (opts.center !== false) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = frame;
    ctx.lineWidth = size * 0.012;
    ctx.beginPath(); ctx.arc(mid, mid, size * 0.21, 0, Math.PI * 2); ctx.stroke();
    const cs = size * 0.085;
    const cr = size * 0.13;
    for (let d = 0; d < 4; d++) {
      const a = -Math.PI / 2 + (d * Math.PI) / 2;
      drawMotif(ctx, edges[d], mid + Math.cos(a) * cr, mid + Math.sin(a) * cr, cs, colors[edges[d]]);
    }
    ctx.restore();
  }
  return canvas;
}
