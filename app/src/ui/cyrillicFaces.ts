// Bricolage Grotesque and Instrument Sans still ship with no Cyrillic (Google Fonts subsets:
// latin and latin-ext only, same on the upstream GitHub sources). Latin keeps those exact files.
// Cyrillic is a second @font-face on the same family name, limited by unicode-range, so a name
// like "You + Арина" uses Bricolage for the Latin and a matched companion for the Russian.
//
// Companions, chosen by cap height and advance width against the bundled faces:
// - Bricolage Condensed ExtraBold → Sofia Sans Extra Condensed 800 (H width 0.382 vs 0.385,
//   cap height 0.655 vs 0.660). size-adjust 100.8% lines the caps up.
// - Bricolage ExtraBold (the wider display) → Onest 800, scaled to the same 0.660 cap.
// - Instrument Sans 400–700 → Onest at the same weight, scaled to Instrument's 0.720 cap.
import { Asset } from 'expo-asset';
import { Platform } from 'react-native';
import { fonts } from './tokens';

const CYRILLIC_RANGE = 'U+0400-052F,U+1C80-1C8A,U+2116,U+2DE0-2DFF,U+A640-A69F';
// Everything the Latin files actually cover, with the Cyrillic blocks left out so the
// companion face is the one the browser picks for Russian.
const LATIN_RANGE = 'U+0000-03FF,U+0530-1C7F,U+1C8B-2DDF,U+2E00-A63F,U+A6A0-10FFFF';

const FAMILIES = [fonts.cond, fonts.display, fonts.regular, fonts.medium, fonts.semibold, fonts.bold];

type Companion = {
  family: string;
  file: number;
  /** Percent. Scales the companion so its capitals match the Latin face. */
  sizeAdjust: number;
  ascent: number;
  descent: number;
};

const companions: Companion[] = [
  { family: fonts.cond, file: require('../../assets/fonts/sofia-sans-extra-condensed-cyrillic.woff2'), sizeAdjust: 100.8, ascent: 93, descent: 27 },
  { family: fonts.display, file: require('../../assets/fonts/onest-cyrillic-800.woff2'), sizeAdjust: 93.2, ascent: 93, descent: 27 },
  { family: fonts.regular, file: require('../../assets/fonts/onest-cyrillic-400.woff2'), sizeAdjust: 101.8, ascent: 97, descent: 25 },
  { family: fonts.medium, file: require('../../assets/fonts/onest-cyrillic-500.woff2'), sizeAdjust: 101.8, ascent: 97, descent: 25 },
  { family: fonts.semibold, file: require('../../assets/fonts/onest-cyrillic-600.woff2'), sizeAdjust: 101.8, ascent: 97, descent: 25 },
  { family: fonts.bold, file: require('../../assets/fonts/onest-cyrillic-700.woff2'), sizeAdjust: 101.8, ascent: 97, descent: 25 },
];

const STYLE_ID = 'numa-cyrillic-faces';

function uriOf(file: number) {
  const asset = Asset.fromModule(file);
  return asset.uri ?? asset.localUri ?? '';
}

function patchLatinFaces(css: string) {
  return css.replace(/@font-face\{[^}]*\}/g, (rule) => {
    if (rule.includes('unicode-range')) return rule;
    if (!FAMILIES.some((family) => rule.includes(`"${family}"`))) return rule;
    const swapped = rule.replace('font-display:auto', 'font-display:swap');
    return swapped.replace(/\}$/, `;unicode-range:${LATIN_RANGE}}`);
  });
}

/** Web only. Native keeps the original faces; Cyrillic there still falls back to the system font. */
export async function installCyrillicFaces() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const generated = document.getElementById('expo-generated-fonts');
  if (generated && generated.textContent) generated.textContent = patchLatinFaces(generated.textContent);

  const rules = companions.map((face) => {
    const uri = uriOf(face.file);
    return `@font-face{font-family:"${face.family}";src:url(${JSON.stringify(uri)}) format("woff2");unicode-range:${CYRILLIC_RANGE};font-display:swap;size-adjust:${face.sizeAdjust}%;ascent-override:${face.ascent}%;descent-override:${face.descent}%;line-gap-override:0%}`;
  }).join('');
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = rules;

  const probe = 'АринаЮраЛюда';
  await Promise.all(FAMILIES.map((family) => document.fonts.load(`16px "${family}"`, probe).catch(() => undefined)));
  await document.fonts.ready;
}
