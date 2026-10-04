// gfx-strings.js — strings for the Settings → Graphics section in every
// required locale. The rest of the game ships English only (spec §10); this
// table is picked from <html lang> so the section follows the page language
// once a locale layer exists, and falls back to en-US.

const EN_US = {
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  effects: 'Effects',
  fromPreset: 'From preset ({tier})',
  categories: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade and vignette',
    antialias: 'Anti-aliasing', particles: 'Particles', detail: 'Table detail', ambient: 'Ambient motion',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed',
  },
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  unknownGpu: 'unknown GPU',
  postFailed: 'Post-processing is unavailable on this device, so the table is drawn without it.',
  noRenderer: 'The 3D table is unavailable, so these options take effect only when it is.',
  sum: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', grade: 'color grade', noAa: 'no anti-aliasing',
  },
};

const EN_GB = {
  ...EN_US,
  categories: { ...EN_US.categories, grade: 'Colour grade and vignette' },
  sum: { ...EN_US.sum, grade: 'colour grade' },
};

const ES_419 = {
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado',
  effects: 'Efectos',
  fromPreset: 'Según el ajuste ({tier})',
  categories: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color y viñeta',
    antialias: 'Suavizado de bordes', particles: 'Partículas', detail: 'Detalle de la mesa', ambient: 'Movimiento ambiental',
  },
  tiers: {
    off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado',
  },
  adaptive: 'Resolución adaptable',
  showFps: 'Mostrar cuadros por segundo',
  unknownGpu: 'GPU desconocida',
  postFailed: 'El posprocesamiento no está disponible en este dispositivo, así que la mesa se dibuja sin él.',
  noRenderer: 'La mesa en 3D no está disponible, así que estas opciones solo se aplican cuando lo esté.',
  sum: {
    noShadows: 'sin sombras', shadows: 'sombras de {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor', grade: 'corrección de color', noAa: 'sin suavizado',
  },
};

const ES_ES = {
  ...ES_419,
  showFps: 'Mostrar fotogramas por segundo',
};

const DE_DE = {
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung',
  effects: 'Effekte',
  fromPreset: 'Laut Voreinstellung ({tier})',
  categories: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur und Vignette',
    antialias: 'Kantenglättung', particles: 'Partikel', detail: 'Tischdetails', ambient: 'Umgebungsbewegung',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Schlicht', detailed: 'Detailliert',
  },
  adaptive: 'Adaptive Auflösung',
  showFps: 'Bildrate anzeigen',
  unknownGpu: 'unbekannte GPU',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher wird der Tisch ohne sie dargestellt.',
  noRenderer: 'Der 3D-Tisch ist nicht verfügbar; diese Optionen wirken erst, wenn er es ist.',
  sum: {
    noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Bloom', grade: 'Farbkorrektur', noAa: 'keine Kantenglättung',
  },
};

const FR_FR = {
  quality: 'Qualité',
  auto: 'Automatique (détectée : {tier})',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu',
  effects: 'Effets',
  fromPreset: 'Selon le préréglage ({tier})',
  categories: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignettage',
    antialias: 'Anticrénelage', particles: 'Particules', detail: 'Détail de la table', ambient: 'Mouvement ambiant',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé',
  },
  adaptive: 'Résolution adaptative',
  showFps: 'Afficher les images par seconde',
  unknownGpu: 'GPU inconnu',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; la table est dessinée sans lui.',
  noRenderer: 'La table en 3D est indisponible ; ces options ne s’appliqueront que lorsqu’elle le sera.',
  sum: {
    noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
    bloom: 'halo', grade: 'étalonnage', noAa: 'sans anticrénelage',
  },
};

const FR_CA = {
  ...FR_FR,
  postFailed: 'Le post-traitement n’est pas offert sur cet appareil; la table est dessinée sans lui.',
  noRenderer: 'La table en 3D n’est pas offerte; ces options s’appliqueront seulement quand elle le sera.',
};

const PT_BR = {
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização',
  effects: 'Efeitos',
  fromPreset: 'Conforme a predefinição ({tier})',
  categories: {
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor e vinheta',
    antialias: 'Suavização de bordas', particles: 'Partículas', detail: 'Detalhe da mesa', ambient: 'Movimento ambiente',
  },
  tiers: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado',
  },
  adaptive: 'Resolução adaptativa',
  showFps: 'Mostrar taxa de quadros',
  unknownGpu: 'GPU desconhecida',
  postFailed: 'O pós-processamento não está disponível neste dispositivo, então a mesa é desenhada sem ele.',
  noRenderer: 'A mesa em 3D não está disponível; estas opções só terão efeito quando estiver.',
  sum: {
    noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
    bloom: 'brilho', grade: 'correção de cor', noAa: 'sem suavização',
  },
};

const IT_IT = {
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering',
  effects: 'Effetti',
  fromPreset: 'Dal preset ({tier})',
  categories: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore e vignettatura',
    antialias: 'Antialiasing', particles: 'Particelle', detail: 'Dettaglio del tavolo', ambient: 'Movimento ambientale',
  },
  tiers: {
    off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato',
  },
  adaptive: 'Risoluzione adattiva',
  showFps: 'Mostra frequenza fotogrammi',
  unknownGpu: 'GPU sconosciuta',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo, quindi il tavolo viene disegnato senza.',
  noRenderer: 'Il tavolo 3D non è disponibile; queste opzioni avranno effetto solo quando lo sarà.',
  sum: {
    noShadows: 'nessuna ombra', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore', grade: 'correzione colore', noAa: 'nessun antialiasing',
  },
};

export const GFX_STRINGS = {
  'en-US': EN_US, 'en-GB': EN_GB, 'es-419': ES_419, 'es-ES': ES_ES, 'de-DE': DE_DE,
  'fr-FR': FR_FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT_IT,
};

/** Best table for a BCP 47 tag: exact, then same language, then en-US. */
export function gfxStrings(lang) {
  const tag = String(lang || 'en-US');
  if (GFX_STRINGS[tag]) return GFX_STRINGS[tag];
  const base = tag.split('-')[0].toLowerCase();
  const region = (tag.split('-')[1] || '').toUpperCase();
  if (base === 'en') return region === 'GB' || region === 'UK' ? EN_GB : EN_US;
  if (base === 'es') return region === 'ES' ? ES_ES : ES_419;
  if (base === 'fr') return region === 'CA' ? FR_CA : FR_FR;
  if (base === 'de') return DE_DE;
  if (base === 'pt') return PT_BR;
  if (base === 'it') return IT_IT;
  return EN_US;
}

/** Fill `{name}` placeholders. */
export function fmt(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ''));
}
