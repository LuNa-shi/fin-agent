# Final Evaluation Scorecard for Single-Name Industry Research

Version: v3.1-en<br>
Evaluation stage: Comprehensive evaluation after multiple rounds of industry research; not intended for turn-by-turn scoring<br>
Primary artifacts: The final summary and one or more calculation workpapers for each material industry, including their internal consistency<br>
Raw-source policy: Score primarily from summaries and workpapers; perform targeted checks only when anomalies or material disputes arise<br>
Scoring: 100 points and 24 atomic rubric items per industry unit; aggregate to the project level using industry materiality weights

## 1. Evaluation objective

This scorecard determines whether the industry research has formed a complete loop across industry definition, causal mechanics, key questions, market narratives, competition, analogues, and quantification.

The grader should focus on final industry summaries and workpapers rather than rereading every underlying industry report. The core questions are:

1. Whether each material industry relevant to the company was researched separately;
2. Whether industry boundaries, products, technology, market size, participants, and profit-pool conventions are correct;
3. Whether the research identifies the key long- and short-term questions and decomposes them into facts and models;
4. Whether market narratives are tested and evidence-backed, falsifiable variant views are developed;
5. Whether market share, competition, profitability, and long-term market size can be reproduced;
6. Whether facts, inferences, hypotheses, and confidence are clearly distinguished.

## 2. Industry units and multi-industry rules

### 2.1 Unit definition

An industry_unit includes:

- A standardized industry name and boundary;
- One or more final industry summaries;
- Market-size, share, supply-demand, profit-pool, scenario, or sensitivity workpapers;
- A mapping to the target company's business and financial model.

Industries with materially different drivers, competitive structures, or economics must be scored separately. A broad sector overview cannot substitute for research on multiple material industries.

### 2.2 Identifying material industries

The grader should establish the material_industry_set primarily from the data summary, company summary, segment information, and the candidate's industry mapping. Rereading the prospectus is not required by default.

Classify each industry as material, emerging_material, or immaterial. A missing material or emerging_material industry must be included in the project aggregation with score=0.

### 2.3 Project aggregation

    project_industry_score = Σ(industry_unit_score × materiality_weight)

Use expected profit contribution, valuation contribution, or sensitivity to the core thesis as the preferred weighting basis, followed by revenue contribution. If reliable weights cannot be established, use transparent equal weighting and add MATERIALITY_WEIGHT_UNCERTAIN.

## 3. Default reading scope

### Must read

- All final industry summaries;
- All calculation workpapers directly supporting final conclusions;
- Industry-definition and company-mapping materials;
- Market-view digests and historical-analogue notes;
- The relevant industry sections of the data summary;
- The relevant business and model assumptions in the company summary.

### Do not read in full by default

- Original industry and sell-side reports;
- Full academic papers;
- Original regulatory and company documents;
- Large volumes of webpages, news, and interviews.

### Triggers for raw-source spot checks

Return to the cited passage only when:

- The summary and workpaper conflict on a figure or direction;
- Market share, market size, or profitability lacks a source or definition;
- The representativeness of a claimed “market consensus” is questionable;
- The facts or period used in a historical analogue are questionable;
- The model does not reconcile or clearly violates an economic boundary;
- Fabrication is suspected.

For a normal evaluation, checking 3–6 high-impact claims per industry is sufficient.

## 4. Stable scoring protocol

### 4.1 Two-pass evaluation

In the first pass, produce an evidence memo without assigning scores:

- No more than two decisive positive evidence points per item;
- The single most important gap per item;
- Summary–workpaper–company-assumption contradictions;
- Whether a raw-source spot check is required.

In the second pass, assign an integer rating from 0 to 4 in rubric order. Calculate the total programmatically; do not form a holistic score first and reverse-engineer the item ratings.

### 4.2 Common anchors

| Rating | Meaning |
|---:|---|
| 4 | All critical conditions are met; logic, evidence, and workpapers form a closed loop |
| 3 | Most conditions are met, with only limited non-critical gaps |
| 2 | Substantive research exists, but one critical link is missing and material rework is required |
| 1 | Only fragmented description, opinions, or unverified assertions exist |
| 0 | Missing, fundamentally incorrect, or actively misleading |

Boundary rules:

- A rating of 4 requires all critical conditions for the item;
- A material error caps the relevant item at 2;
- A conclusion without summary or workpaper evidence is capped at 1;
- Ratings of 1 and 3 must explain why the output exceeds the lower anchor but does not reach the next anchor;
- Do not score based on length, chart count, jargon, or bullish/bearish stance;
- Deduct for a defect only in the most directly affected item unless it creates an independent second consequence.

### 4.3 Regrading

Run a second independent judge only when a high-weight item has confidence=low, the total is within 3 points of the pass threshold, a cap is disputed, or the output will become a formal training label. Escalate to human review if total scores differ by more than 6 points or if a critical item differs by at least 2 rating levels.

## 5. Scoring formula

    item_score = item_weight × rating / 4
    industry_raw_score = Σ item_score
    industry_final_score = min(industry_raw_score, applicable_caps)

## 6. 100-point atomic rubric

### A. Industry definition, concepts, and structure (15 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-DEF-01 | 5 | Industry boundary and statistical convention | The broad industry, subindustry, and company-addressable market are clear; geography, product, customer, value-chain, and revenue conventions are consistent; differences across reports are bridged | The basic definition is correct, but boundaries are mixed or market-size conventions are occasionally mismatched | The industry is fundamentally misidentified or incomparable conventions are directly compared |
| I-DEF-02 | 4 | Core concepts, products, and technical principles | Key products, technologies, cost drivers, and performance metrics are accurate and sufficient to explain demand, substitution, and constraints | Concepts are introduced, but the link between technology and economics is weak | A technical principle is materially wrong and affects the conclusion |
| I-DEF-03 | 4 | Participants, subindustries, geographies, and value chain | The participant map is complete and distinguishes upstream/downstream roles, business models, geographies, and subindustries | Only leading companies are covered or structural dimensions are incomplete | Participants are misclassified or dominant forces are omitted |
| I-DEF-04 | 2 | Mapping to the target company | The company's value-chain position, revenue/profit exposure, addressable scope, and adjacent businesses are clear; TAM is not confused with the company's market | The company linkage exists but is unquantified or poorly bounded | The industry analysis is disconnected from the company's actual business |

### B. Historical development, industry dynamics, and key questions (25 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-DYN-01 | 5 | Historical development and industry “nature” | Key phases and regulatory, technological, supply, and demand shifts explain how the industry structure formed; the history yields testable generalizations | Historical description exists, but mechanisms and phase definition are weak | Historical facts are materially wrong or no historical development is provided |
| I-DYN-02 | 5 | Long-term and short-term drivers | Structural and cyclical drivers are separated; variable, direction, time horizon, and lead-lag relationships are explained | Drivers are listed, but causal ordering and lags are absent | Correlation is treated as causation or the principal driver is misidentified |
| I-DYN-03 | 6 | Constraints and genuinely key questions | The research identifies bottlenecks that determine the growth ceiling, downside floor, or inflection point; demonstrates why they are critical; and makes them testable with data or models | Key questions exist, but priority, evidence, or falsifiability is weak | Only a generic risk list is provided |
| I-DYN-04 | 4 | Industry dynamics and predictability | The research judges whether the industry is forecastable and analyzes supply response, build cycles, inventory, learning curves, substitution speed, and non-linearity | A forecast exists, but error sources and dynamics are not explained | A precise forecast is presented without a mechanism, or clear unpredictability is ignored |
| I-DYN-05 | 5 | Decomposition of key questions by 2–3 levels | A problem tree or causal chain is built; each level has facts, proxies, or a model; divergent hypotheses converge to a base view and trigger conditions | The issue is decomposed only one level or evidence is fragmented | The conclusion is asserted without a reasoning structure or support |

### C. Market-narrative validation and variant view (12 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-NAR-01 | 4 | Mainstream narrative, provenance, and representativeness | Multiple dated source types are used to summarize key narratives; consensus, disagreement, and fringe views are separated; representativeness is demonstrated | Sell-side views are summarized, but source diversity or representativeness is weak | “The market believes” is asserted without sources |
| I-NAR-02 | 4 | Narrative vulnerabilities, variables, and disconfirming evidence | The work identifies mechanisms through which the narrative could fail, observable variables, thresholds, catalysts, and resulting impact | Risks are discussed but are not falsifiable or their impact is not quantified | Consensus is repeated without testing |
| I-NAR-03 | 4 | Agreement and disagreement with the market | Areas of agreement and disagreement, evidence, probability, and conditions for changing the view are explicit; the variant view links to the industry model and company impact | A differentiated view exists, but evidence or model linkage is weak | The research disagrees merely for the sake of being contrarian |

### D. Industry structure, share, and profit pool (14 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-COM-01 | 5 | Market-share definition, current structure, and estimation | Denominator, geography, product, channel, and period are clear; where data are missing, the estimate is reproducible, ranged, and cross-validated | A share table exists, but definitions or sources are inconsistent | Share figures are untraceable or use a mismatched denominator |
| I-COM-02 | 4 | Historical share shifts and future migration | The causal drivers of past share changes are explained; product, channel, cost, capacity, and regulation are linked to future migration | Only static share or a mechanism-free forward view is provided | The share trend contradicts the evidence without explanation |
| I-COM-03 | 5 | Competitive intensity, supply-demand, and margin evolution | Concentration, differentiation, entry/exit, returns on capital, supply response, bargaining power, and cost curves are integrated; profit-pool scenarios are discussed | Competition is judged from a single indicator such as concentration or price war | Core supply-demand or return constraints are ignored |

### E. Historical experience and cross-industry analogues (8 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-ANA-01 | 4 | Analogue selection and comparability | Analogues are mechanism-based, stage-accurate, and non-generic; periods are verified; comparable and non-comparable elements are stated explicitly | The analogue is useful but superficial | The case or period is hallucinated, or only a generic “bubble” label is applied |
| I-ANA-02 | 4 | Generalization and limits of transfer | General lessons are abstracted and then tied to probabilities, monitoring indicators, or the model | Lessons are summarized but do not affect the judgment | The analogue is decorative or transferred incorrectly |

### F. Industry quantification and calculation workpapers (18 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-QNT-01 | 4 | Market size, segmentation, and convention bridge | Broad industry, subindustry, TAM/SAM, and company-addressable market are separated; components reconcile | A market-size estimate exists, but hierarchy, denominator, or double counting needs correction | No quantification or a fundamentally wrong market-size convention |
| I-QNT-02 | 5 | Workpaper reproducibility and calculation accuracy | Inputs, sources, units, formulas, assumptions, outputs, and version are complete; the grader can reproduce the principal results | Principal results can be reproduced, but some inputs or formulas are opaque | The workpaper is missing, formulaically wrong, or the main conclusion cannot be reproduced |
| I-QNT-03 | 4 | Scenarios, probabilities, and key-variable mapping | Scenarios cover major uncertainties; probabilities have a basis; changes in key questions flow mechanically into outputs | Three scenarios exist, but they use uniform multipliers or subjective probabilities | Only a single-point forecast is provided |
| I-QNT-04 | 5 | Long-term ceiling, sensitivities, and cross-checks | Long-term size links penetration, pricing, replacement, supply, and economic constraints; key sensitivities and cross-industry or macro cross-checks are included | A long-term forecast exists, but sensitivities and external constraints are weak | CAGR is extrapolated mechanically beyond evident economic limits |

### G. Industry-summary communication and epistemic calibration (8 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| I-REP-01 | 3 | Facts, inferences, hypotheses, and confidence | These are clearly separated; confidence matches evidence strength; estimates and simulations are not presented as facts | They are broadly distinguished, but labels and confidence are inconsistent | Facts, views, and hypotheses are mixed together |
| I-REP-02 | 3 | Report structure and conclusion closure | The report covers definition, history, current state, core logic, future key issues, quantification, market comparison, and risks; it agrees with the workpapers | Major sections exist, but logic jumps or workpaper linkage is weak | The report is a source collage or contradicts the main workpaper conclusions |
| I-REP-03 | 2 | Clarity, plain language, and auditability | Key conclusions are front-loaded; charts include titles, units, and sources; citations are traceable; knowns and unknowns are clear | The report is readable but verbose or poorly standardized in charts/citations | Communication obstructs understanding or style masks weak evidence |

## 7. Minimum workpaper recomputation

The grader should not audit every workbook cell, but must check at least:

- The build-up from market-size components to the total;
- One material market-share estimate;
- One supply-demand or profit-pool calculation;
- The base case and one bull or bear scenario;
- One long-term ceiling or key sensitivity;
- The principal model outputs cited in the summary.

Expand the relevant checks only after a material error is found.

## 8. Score caps and pass criteria

### 8.1 Industry-unit caps

| Condition | Maximum final score |
|---|---:|
| Confirmed fabrication of sources, historical cases, or material data | 20 |
| A fundamentally wrong industry boundary materially distorts market size or the competitive set | 39 |
| A core technical or commercial mechanism is wrong and could reverse the principal conclusion | 49 |
| No final industry summary | 49 |
| At least two material contradictions between summary and workpaper | 59 |
| Principal calculation workpapers cannot be reproduced | 59 |
| No genuinely key question; the work is primarily an industry introduction | 69 |
| Quantification is appropriate but no valid workpaper or scenario analysis exists | 69 |

### 8.2 Project-level caps

| Condition | Maximum project score |
|---|---:|
| Missing industries account for materiality_weight ≥25% | 59 |
| Missing industries account for materiality_weight of 10%–24.99% | 69 |
| Weights are opaque and no auditable equal-weight method is used | 79 |

| Score | Quality band |
|---:|---|
| 90–100 | A: bench-quality |
| 80–89 | B: professional |
| 70–79 | C: usable with rework |
| 60–69 | D: weak |
| 0–59 | F: failed |

Industry-unit pass requirements:

- final_score ≥80;
- I-DEF-01, I-DYN-03, I-DYN-05, and I-QNT-02 are each ≥3;
- No material contradiction or fabrication.

A project also requires valid units for all material industries in order to pass.

## 9. Recommended error tags

- MATERIAL_INDUSTRY_MISSING
- INDUSTRY_BOUNDARY_WRONG
- TAM_COMPANY_MARKET_CONFUSED
- TECHNICAL_CONCEPT_WRONG
- DRIVER_CAUSALITY_WEAK
- KEY_QUESTION_NOT_IDENTIFIED
- KEY_QUESTION_NOT_DECOMPOSED
- CONSENSUS_UNSOURCED
- VARIANT_VIEW_UNPROVEN
- MARKET_SHARE_DEFINITION_WRONG
- PROFIT_POOL_NOT_ANALYZED
- ANALOGY_INVALID
- MODEL_INPUT_UNSOURCED
- WORKPAPER_NOT_REPRODUCIBLE
- SCENARIO_MECHANICAL
- SUMMARY_WORKPAPER_MISMATCH
- FACT_INFERENCE_MIXED
- FABRICATED_EVIDENCE

## 10. Standard output

    {
      "eval_schema_version": "investment-industry-final-eval/3.1",
      "project_id": "...",
      "as_of": "YYYY-MM-DD",
      "evaluation_stage": "final_integrated",
      "material_industry_set": [],
      "artifacts_scored": [],
      "raw_source_check": {
        "level": 0,
        "trigger": null,
        "claims_checked": []
      },
      "industry_units": [
        {
          "industry_id": "...",
          "rubric_results": [
            {
              "rubric_id": "I-DYN-03",
              "weight": 6,
              "rating": 0,
              "weighted_score": 0,
              "decisive_evidence": [],
              "why_not_higher": "...",
              "error_tags": [],
              "confidence": "high | medium | low"
            }
          ],
          "raw_score": 0,
          "caps_applied": [],
          "final_score": 0,
          "result": "pass | conditional | fail"
        }
      ],
      "aggregation": {
        "materiality_weights": {},
        "project_industry_score": 0
      },
      "human_review_required": false,
      "top_3_remediations": []
    }

Do not store hidden chain-of-thought. Store only auditable evidence and concise scoring rationales.

## 11. Prompt for direct injection into a grader

You are the final-stage grader for industry research in a single-name public-equity project. Use the data summary, company summary, and industry mapping to identify material industries. Evaluate each industry's final summary and directly supporting calculation workpapers separately. Do not read original reports, academic papers, or PDFs in full by default.

In the first pass, extract only the decisive evidence, largest gap, and summary–workpaper–company-assumption contradiction for each rubric item; do not score. In the second pass, rate each item against the 0–4 anchors. Return to 3–6 raw-source claims per industry only when high-impact figures are unsourced, consensus claims or historical analogues are questionable, a model is anomalous, summaries conflict with workpapers, or fabrication is suspected. Recompute only the minimum workpaper scope and expand after detecting an error. Calculate totals mechanically, apply caps, and aggregate by materiality_weight. Do not reward length, style, or investment stance.

## 12. Stability references

- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [G-Eval](https://arxiv.org/abs/2303.16634)
- [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685)
- [Judging the Judges: Position Bias](https://arxiv.org/abs/2406.07791)
