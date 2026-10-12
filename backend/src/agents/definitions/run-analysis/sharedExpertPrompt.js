// Shared expert-authored discipline blocks and pure prompt helpers.
// Agent-specific System Prompts remain in their own *.agent.js definition files.
import { ANALYSIS_STYLE } from '../../../lib/style.js';

export const json = (value) => JSON.stringify(value ?? null);
export const text = (value, fallback = '') => value == null ? fallback : String(value);
export const list = (value) => Array.isArray(value) ? value : [];

export const SOURCE_DISCIPLINE = `
Evidence discipline:
- Read the authoritative project artifacts before judging; previews are navigation aids, not evidence.
- Tag every concrete number with an inline source marker such as [src: data_report], [src: transcript Q1'26], or [src: fmp_comps].
- If a number cannot be traced, verify it with an allowed tool, mark it [est], or omit it.
- Actively search for evidence that contradicts the forming thesis. Do not smooth over contradictions.
${ANALYSIS_STYLE}`;

export const VARIANT_DISCIPLINE = `
Variant-perception discipline:
- State what consensus believes and where that belief appears in price, multiples, or public commentary.
- State what this analysis believes differently and the evidence that supports the difference.
- Steelman the other side, name what would force us to change our mind, and name the public event that would force consensus to capitulate.
- If no defensible variant exists, explicitly conclude that consensus is right or already priced.`;
