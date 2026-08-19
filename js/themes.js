// themes.js — authored visual themes: full color/material data shared by the
// Three.js renderer, the DOM mirror board, and CSS custom properties.
// Pure data + small helpers; no dependencies.

export const THEMES = Object.freeze({
  studio: {
    id: 'studio', name: 'Studio Dawn',
    bg: '#e8ded0', fog: '#e8ded0',
    table: '#7a5c3e', tableEdge: '#5f4730',
    felt: '#4c6b58', feltLine: '#3d5847',
    cardFace: '#f6efe3', cardBack: '#b8503c', cardEdge: '#d8cdb8',
    cellInlay: '#3a5546', cellEmpty: '#425f50',
    accent: '#c96f2e', accentSoft: '#e0a06a',
    select: '#ffd166', invalid: '#c0392b', match: '#7fb069',
    text: '#2c2620', textSoft: '#6b5f52',
    surface: '#f6efe3', ink: '#2c2620',
    light: { key: '#fff2df', keyIntensity: 2.6, fill: '#bcd0e8', fillIntensity: 0.55, ambient: 0.5 },
    exposure: 1.0,
  },
  slate: {
    id: 'slate', name: 'Slate Night',
    bg: '#171c26', fog: '#171c26',
    table: '#2c3444', tableEdge: '#1f2531',
    felt: '#233040', feltLine: '#1b2632',
    cardFace: '#e9e4d8', cardBack: '#8c4a5a', cardEdge: '#c9c2b2',
    cellInlay: '#1c2836', cellEmpty: '#263645',
    accent: '#5aa7d1', accentSoft: '#86c2e0',
    select: '#f2c14e', invalid: '#e0604f', match: '#6fc28a',
    text: '#e6e1d6', textSoft: '#9aa5b1',
    surface: '#232d3d', ink: '#e6e1d6',
    light: { key: '#dfe9ff', keyIntensity: 2.2, fill: '#4a5d80', fillIntensity: 0.5, ambient: 0.42 },
    exposure: 1.05,
  },
  verdant: {
    id: 'verdant', name: 'Verdant',
    bg: '#dfe8d2', fog: '#dfe8d2',
    table: '#5d6b41', tableEdge: '#47522f',
    felt: '#3f5a3c', feltLine: '#324830',
    cardFace: '#f4f1e2', cardBack: '#a05c34', cardEdge: '#d6d2ba',
    cellInlay: '#33502f', cellEmpty: '#3c5a38',
    accent: '#3e7d4e', accentSoft: '#79a86a',
    select: '#ffd166', invalid: '#b23c2e', match: '#9cc46f',
    text: '#243020', textSoft: '#5c6a50',
    surface: '#f4f1e2', ink: '#243020',
    light: { key: '#f4ffdf', keyIntensity: 2.4, fill: '#cfe4bc', fillIntensity: 0.55, ambient: 0.5 },
    exposure: 1.0,
  },
  ember: {
    id: 'ember', name: 'Ember Glow',
    bg: '#241a16', fog: '#241a16',
    table: '#4a2f24', tableEdge: '#35211a',
    felt: '#40251f', feltLine: '#331d18',
    cardFace: '#f2e3cf', cardBack: '#7d3327', cardEdge: '#d9c3a6',
    cellInlay: '#37211c', cellEmpty: '#422a24',
    accent: '#e07b39', accentSoft: '#eda56c',
    select: '#ffd97a', invalid: '#d94530', match: '#8fae62',
    text: '#f0e2d2', textSoft: '#b09a86',
    surface: '#332016', ink: '#f0e2d2',
    light: { key: '#ffd9b0', keyIntensity: 2.3, fill: '#7a4a3a', fillIntensity: 0.5, ambient: 0.42 },
    exposure: 1.05,
  },
  porcelain: {
    id: 'porcelain', name: 'Porcelain',
    bg: '#eef1f2', fog: '#eef1f2',
    table: '#9aa7ad', tableEdge: '#7d8a91',
    felt: '#b9c8cc', feltLine: '#a2b3b8',
    cardFace: '#fdfcf8', cardBack: '#4a6b8a', cardEdge: '#e3e0d5',
    cellInlay: '#a9babf', cellEmpty: '#b4c4c9',
    accent: '#3a6ea5', accentSoft: '#7ba3cc',
    select: '#e8a33d', invalid: '#c0392b', match: '#5f9e6e',
    text: '#22303a', textSoft: '#5d6d77',
    surface: '#ffffff', ink: '#22303a',
    light: { key: '#ffffff', keyIntensity: 2.5, fill: '#d5e2ea', fillIntensity: 0.6, ambient: 0.55 },
    exposure: 0.98,
  },
});

export function getTheme(id) {
  return THEMES[id] || THEMES.studio;
}

/**
 * Motif colors per theme. Two palette families:
 *  - standard: distinct hues, each also distinguished by glyph shape
 *  - cvd: Okabe–Ito color-vision-safe palette
 * Index 0..7 matches content MOTIFS ids.
 */
export const MOTIF_COLORS_STANDARD = Object.freeze([
  '#2e6f8e', '#c98a2b', '#5f8f3e', '#6b5ca5', '#b8517d', '#33998a', '#b8542e', '#7a8a3a',
]);
export const MOTIF_COLORS_CVD = Object.freeze([
  '#0072B2', '#E69F00', '#009E73', '#56B4E9', '#CC79A7', '#0072B2', '#D55E00', '#F0E442',
]);

export function motifColors(cvd = false) {
  return (cvd ? MOTIF_COLORS_CVD : MOTIF_COLORS_STANDARD).slice();
}

/** CSS custom properties for a theme, applied to :root by the UI layer. */
export function themeCssVars(theme, cvd = false) {
  const mc = motifColors(cvd);
  const vars = {
    '--t-bg': theme.bg, '--t-table': theme.table, '--t-felt': theme.felt,
    '--t-card': theme.cardFace, '--t-card-edge': theme.cardEdge,
    '--t-cell': theme.cellEmpty, '--t-accent': theme.accent,
    '--t-accent-soft': theme.accentSoft, '--t-select': theme.select,
    '--t-invalid': theme.invalid, '--t-match': theme.match,
    '--t-text': theme.text, '--t-text-soft': theme.textSoft,
    '--t-surface': theme.surface, '--t-ink': theme.ink,
  };
  mc.forEach((c, i) => { vars['--motif-' + i] = c; });
  return vars;
}
