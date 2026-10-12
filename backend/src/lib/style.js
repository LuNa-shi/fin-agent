// System-wide writing discipline, injected into every analysis / reasoning / conclusion prompt.
// Goal: kill hype and narrative fluff; express judgments as numbers / ratios / ranges / probabilities / conditionals.
export const ANALYSIS_STYLE = `<writing_discipline>
Write like a quant buy-side memo, not a story. Structure every judgment as: variable -> relationship -> number -> condition -> conclusion.
- QUANTIFY FIRST. Give concrete values, magnitudes, ranges, thresholds, probabilities, sensitivities. Prefer conditional statements, e.g. "if rev growth > 30% and gross margin holds, fair fwdPE is 18-22x".
- NEVER use hype or emotional words (e.g. explosive, super-cycle, arms-race, crush, insane, unstoppable, epic). Replace "demand explodes" with "demand growth +X%". No slogans, no storytelling, no unquantified sweeping claims.
- When uncertain, label it as an assumption or a range and give a falsifiable observation threshold — not a confident adjective.
- Every non-obvious claim carries a number and a source. State what consensus believes and where you diverge.
</writing_discipline>`;
