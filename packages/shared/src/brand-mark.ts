/** Canonical Duefold Ribbon geometry and palette. Keep static assets and the
 * in-app identity on these exact paths. */
export const RIBBON_STEM_PATH = 'M6 4.75 11.33 10.09V28H6Z';
export const RIBBON_BOWL_PATH =
  'M6.75 4H14A12 12 0 0 1 14 28H12.33V22.67H14A6.67 6.67 0 0 0 14 9.33H11.33V8.58Z';

export const RIBBON_COLORS = Object.freeze({
  light: Object.freeze({ stem: '#1b211f', bowl: '#006b5e' }),
  dark: Object.freeze({ stem: '#e8ebe7', bowl: '#5fc9b4' }),
});
