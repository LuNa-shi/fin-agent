/**
 * Conservative token estimate for inline context and deterministic demo telemetry.
 * CJK/Hangul code points are counted more densely than other text.
 */
export function estimateTokens(text = '') {
  const value = String(text || '');
  let cjk = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0x3000 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7ff)
      || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  return Math.ceil(cjk * 0.6 + (value.length - cjk) / 3.5);
}
