# Final Evaluation Scorecard for Single-Name Company Research

Version: v3.1-en  
Evaluation stage: Comprehensive evaluation after multiple rounds of company research; not intended for turn-by-turn scoring  
Primary artifacts: The final company summary/report, financial model, valuation workpapers, and topic-specific calculation workpapers  
Raw-source policy: Score primarily from the report, workpapers, data summary, and industry summaries; perform targeted checks only when anomalies arise  
Total score: 100 points across 28 atomic rubric items

## 1. Evaluation objective

This scorecard determines whether the company research forms a complete loop across business understanding, key questions, market expectations, financial modeling, valuation, and trading implications.

The grader should focus on the final company report and workpapers rather than rereading every underlying company document. The core questions are:

1. Whether the research accurately understands the company's history, management, products, business model, and competitive position;
2. Whether it identifies the questions that genuinely determine value by integrating industry structure and market pricing;
3. Whether it develops evidence-backed, falsifiable variant views;
4. Whether key questions are translated into revenue, earnings, cash-flow, and balance-sheet drivers;
5. Whether history, forecasts, valuation, and the expected share-price path can be reproduced;
6. Whether the company report is consistent with the data package, industry conclusions, and financial model.

## 2. Default reading scope

### 2.1 Must read

- The final company summary and full report;
- Historical financial and forecast models;
- Valuation, scenario, and sensitivity workpapers;
- Product, management, competition, and key-question workpapers directly supporting the final conclusions;
- The data agent's final summary;
- Final summaries and key model outputs for every material industry;
- Consensus, historical-valuation, share-price-event, and market-view digests.

### 2.2 Do not read in full by default

- Original annual reports, prospectuses, filings, and earnings-call transcripts;
- Full sell-side reports;
- News, forums, webpages, and original industry reports.

### 2.3 Triggers for raw-source spot checks

Return to the cited passage only when:

- The company report conflicts with the model or the data/industry summaries;
- A high-impact financial figure, management commitment, or market view is unsourced;
- The consensus snapshot or representativeness of a claimed “market view” is questionable;
- Evidence for a competitive advantage appears anomalous;
- The target price or financial model does not reconcile;
- Fabrication is suspected.

For a normal evaluation, checking 3–6 high-impact claims is sufficient.

## 3. Stable scoring protocol

### 3.1 Two-pass evaluation

In the first pass, produce an evidence memo without assigning scores:

- No more than two decisive positive evidence points per item;
- The single most important gap per item;
- Report–model–data–industry contradictions;
- Whether a raw-source spot check was triggered.

In the second pass, assign an integer rating from 0 to 4 in rubric order. Calculate the total programmatically; do not form a holistic score first and reverse-engineer the item ratings.

### 3.2 Common anchors

| Rating | Meaning |
|---:|---|
| 4 | All critical conditions are met; evidence, model, and investment implications form a closed loop |
| 3 | Most conditions are met, with only limited non-critical gaps |
| 2 | Substantive analysis exists, but one critical link is missing and material rework is required |
| 1 | Only company description, fragmented views, or unverified assertions exist |
| 0 | Missing, fundamentally incorrect, or actively misleading |

Boundary rules:

- A rating of 4 requires all critical conditions for the item;
- A material error caps the relevant item at 2;
- A conclusion without report or workpaper evidence is capped at 1;
- Ratings of 1 and 3 must explain why the output exceeds the lower anchor but does not reach the next anchor;
- Do not score based on length, model complexity, target-price precision, or bullish/bearish stance;
- Deduct for a defect only in the most directly affected item unless it creates an independent second consequence.

### 3.3 Regrading

Run a second independent judge only when a high-weight item has confidence=low, the total is within 3 points of the pass threshold, a cap is disputed, or the output will become a formal training label. Escalate to human review if total scores differ by more than 6 points or if a critical item differs by at least 2 rating levels.

## 4. Scoring formula

    item_score = item_weight × rating / 4
    raw_score = Σ item_score
    final_score = min(raw_score, applicable_caps)

## 5. 100-point atomic rubric

### A. Company history, strategy, and share-price evolution (8 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-HIS-01 | 4 | Business and strategic history | Products, M&A, geographic expansion, strategy, financing, and business-model changes are organized into meaningful phases; causality and the legacy for the current company are explained | A timeline exists, but it is event-driven and incomplete on mechanisms and implications | Major historical facts are wrong or no company history is provided |
| C-HIS-02 | 2 | Major historical share-price inflections | Major five-year inflections are linked reasonably to earnings, expectations, strategy, industry, and macro events, with correlation distinguished from causation | Only event markers or a price chart are provided | Dates or magnitudes are materially wrong, or no price history exists |
| C-HIS-03 | 2 | Parallel history of competitors | Core competitors have concise histories sufficient to compare strategy, products, share, and valuation evolution, with comparability limits explained | Only static competitor profiles are provided | No competitor history or the selected peers are not comparable |

### B. Management, governance, and capital allocation (8 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-MGT-01 | 3 | Core-team background and historical contribution | Key executives' experience, tenure, decisions, and attributable contributions are sourced; management skill is separated from industry beta | Management biographies exist, but claimed contributions rely mainly on company promotion | Background or contribution claims are wrong or unverified |
| C-MGT-02 | 3 | Governance, incentives, and capital allocation | Ownership/compensation, board structure, related-party transactions, M&A, buybacks, financing, capex, and ROIC records are analyzed | Some capital-allocation issues are covered, but long-term outcomes and peer comparison are weak | Material governance risks or value-destructive capital allocation are ignored |
| C-MGT-03 | 2 | Management style, credibility, and peer comparison | Multi-period promise-versus-delivery, guidance bias, disclosure quality, and crisis management are compared with peers | A subjective assessment exists, but evidence and peer comparison are weak | The work relies only on management's self-description |

### C. Core products, competitive position, and business model (15 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-BIZ-01 | 4 | Products/services, customers, and use cases | Products, customers, buyers, users, pricing, channels, geographies, and revenue contribution are clear, including changes in the portfolio | Products are described, but customers, economics, or contribution are incomplete | The research does not establish what the company actually sells |
| C-BIZ-02 | 5 | Evidence for differentiation, strengths, and weaknesses | Market share, pricing, retention, performance, cost, channel, brand, patents, or switching costs validate the thesis; counterevidence and conditions for persistence are included | Some evidence exists, but it is largely qualitative or single-source | Company marketing is repeated and competitive advantage is not validated |
| C-BIZ-03 | 4 | Business model and unit economics | Revenue model, value-chain position, pricing power, acquisition/retention, capital intensity, working capital, scale economics, and profit sources are identified | The business-model category is correct, but economic mechanics lack depth | Revenue or cost mechanics are misclassified in a way that affects the model |
| C-BIZ-04 | 2 | Substitution, weaknesses, and competitive response | Product shortcomings, substitution paths, customer bargaining power, technology risk, and competitor responses are analyzed concretely | Only a generic risk list is provided | Only strengths are discussed and no falsifiable weakness is considered |

### D. Company key questions and original research (15 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-KEY-01 | 5 | Questions that genuinely determine value | Two to five key questions are derived from industry mechanics, company exposure, and market pricing; value sensitivity and priority are explained | A question list exists, but it is too broad, too long, or not demonstrated to be material | No key questions; the work is primarily a company introduction |
| C-KEY-02 | 5 | Logical development, iteration, and decomposition | Each question is decomposed by at least 1–2 levels; causal chains, historical evidence, data, and model tests are present; updates to initial assumptions are documented | Decomposition exists, but evidence/model closure or visible iteration is weak | Answers are asserted without a validation path |
| C-KEY-03 | 5 | New research methods and incremental insight | Product, channel, customer, hiring, supply-chain, patent, historical-analogue, or proxy-data research is designed around key questions and produces reproducible incremental conclusions | Alternative evidence exists, but methodology or incremental value is limited | The work only restates sell-side and company materials |

### E. Market views, expectations, and variant view (10 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-MKT-01 | 4 | Accurate summary of different market constituencies | Dated sources cover sell-side views and at least one type of empirical non-sell-side evidence; constituencies and representativeness limits are distinguished | Coverage is mainly sell-side and other constituencies are sparse | “The market believes” is unsourced or simulated views are presented as empirical |
| C-MKT-02 | 3 | Current financial-expectations and pricing baseline | Next-quarter and three-year consensus, range/dispersion, snapshot date, company guidance, and implied expectations are available and comparable | Only mean revenue/EPS is shown or the snapshot/contributor set is unclear | No verifiable market-expectations baseline |
| C-MKT-03 | 3 | Variant view, catalysts, and falsifiers | Agreement/disagreement, evidence, model impact, time horizon, catalysts, and falsifiers are explicit | A variant view exists but is not falsifiable or linked to valuation | The work is contrarian merely for the sake of differentiation |

When buy-side, hedge-fund, or retail views cannot be obtained, simulated_view may be used for stress testing but must be labeled. Simulation does not count as empirical market coverage; if all views are simulated, C-MKT-01 is capped at 1.

### F. Financial model, operating drivers, and key-question linkage (20 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-MOD-01 | 4 | Historical financials and three-statement foundation | Five years of annual and three years of quarterly key data are correct; restatements, M&A, currency, and GAAP/non-GAAP treatment are clear; the three statements reconcile | Historical data are broadly usable, but period coverage, quarterly detail, or reconciliation has gaps | The historical model is systematically wrong |
| C-MOD-02 | 5 | Revenue-driver model | Revenue is built from genuine operating drivers such as volume × price, users × ARPU, capacity × utilization, or industry size × share; granularity matches the key questions | Segment forecasts exist, but rely mainly on uniform growth rates | Total revenue is extrapolated only from a CAGR |
| C-MOD-03 | 4 | Earnings, balance sheet, and cash flow | Gross margin, opex, tax, working capital, capex, depreciation, financing, share count, and cash flow are complete and material reconciliations pass | The income statement is reasonably complete, but cash flow, balance sheet, or key drivers are weak | Only revenue/EPS point forecasts are provided or the model does not balance |
| C-MOD-04 | 4 | Transmission from key questions to financial outcomes | Each key question maps to an observable driver, quarterly/annual line item, and valuation; industry size/share links to company revenue | Qualitative linkage exists but cannot flow mechanically into the model | Key research and the financial model are disconnected |
| C-MOD-05 | 3 | Scenarios, sensitivities, probabilities, and reproducibility | Key uncertainties enter scenarios and sensitivities; probabilities have a basis; inputs, formulas, outputs, and versions can be reproduced | Bull/base/bear cases exist, but assumptions are simplistic or probabilities subjective | Workpapers are missing/unreproducible or only a single-point forecast exists |

### G. Valuation, trading price, and expectations gap (16 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-VAL-01 | 4 | Historical valuation and method selection | Historical valuation ranges and regimes are mapped and explained; DCF, multiples, SOTP, or other methods are selected based on the business model, capital structure, and company stage | Historical multiples and peer comparisons exist, but the methodological rationale is weak | A single multiple is applied arbitrarily or the valuation convention is wrong |
| C-VAL-02 | 4 | Forward quarterly forecasts and earnings bridge | At least the next quarter's key line items are forecast, ideally for four rolling quarters; forecasts are compared with guidance/consensus and beat/miss drivers and seasonality are explained | Only annual forecasts exist or quarterly forecasts lack operating drivers | No near-term earnings forecast |
| C-VAL-03 | 4 | Implied expectations, fair value, and expectations gap | Implied assumptions are reverse-engineered from the current price; the forecast–valuation–per-share-value bridge is reproducible; ranges, probabilities, and margin of safety are provided | A target price and sensitivities exist, but implied expectations or the valuation bridge are incomplete | The target price cannot be reproduced or conflicts with the model |
| C-VAL-04 | 4 | Trading sentiment, time path, and price range | Available positioning, flows, revisions, options, or sentiment evidence is used; catalysts define the time path, range, and downside; support/resistance levels use an explicit method | Catalysts and a range exist, but sentiment evidence, timing, or technical methodology is weak | Only a target price or arbitrary technical levels are provided |

If technical levels are used, the window, price-adjustment convention, volume/price rule, and invalidation condition must be stated. Where technical analysis is inappropriate, liquidity, event-driven, or valuation ranges may be used instead with an explanation.

### H. Company-summary communication, evidence, and epistemic calibration (8 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| C-REP-01 | 3 | Facts, inferences, hypotheses, and confidence | Company disclosures, external facts, market views, agent inferences, and hypotheses are clearly labeled; confidence matches evidence | Categories are broadly distinguished, but labels or confidence are inconsistent | Targets, rumors, or model assumptions are presented as facts |
| C-REP-02 | 3 | Report–evidence–model consistency | Thesis, key questions, forecasts, valuation, and risks form one chain; citations are traceable; report figures agree with the identified model version | A central line exists, but there are jumps, repetition, or minor inconsistencies | The report and model conflict on the principal conclusion |
| C-REP-03 | 2 | Clarity, plain language, risks, and unknowns | Key judgments are front-loaded; high/low confidence is distinguished; risks, gaps, monitoring indicators, and falsifiers are clear | The report is readable, but risks are generic or unknowns incomplete | Communication obstructs judgment or presents only a one-sided story |

## 6. Minimum model recomputation

The grader should not audit every workbook cell, but must recalculate at least:

- Key revenue and earnings figures for one historical year and the latest four quarters;
- The bridge from principal revenue drivers to total revenue;
- The bridge from gross profit and opex to operating income or net income;
- Net income to EPS;
- Cash flow or net cash/net debt;
- Base-case valuation to per-share value;
- One bull or bear scenario;
- Principal forecasts and target prices cited in the report.

Expand the relevant checks only after a material error is found.

## 7. Score caps and pass criteria

| Condition | Maximum final score |
|---|---:|
| Confirmed fabrication of sources, market views, or historical model data | 20 |
| Core historical financials are systematically wrong and could reverse earnings, cash, or valuation conclusions | 39 |
| The company's actual business or business model is fundamentally misunderstood | 49 |
| No final company summary | 40 |
| No valid financial model or principal outputs cannot be reproduced | 59 |
| At least two material contradictions between the report and model | 59 |
| No key questions; the work is primarily a company introduction | 69 |
| Revenue is forecast only through a uniform growth rate with no operating drivers | 69 |
| No valuation or the target price cannot be reproduced | 69 |
| The effect of a material industry on the company is omitted | 69 |

| Score | Quality band |
|---:|---|
| 90–100 | A: bench-quality |
| 80–89 | B: professional |
| 70–79 | C: usable with rework |
| 60–69 | D: weak |
| 0–59 | F: failed |

Pass requirements:

- final_score ≥80;
- C-BIZ-02, C-KEY-01, C-KEY-02, C-MOD-02, C-MOD-04, and C-VAL-03 are each ≥3;
- No material contradiction or fabrication.

## 8. Recommended error tags

- COMPANY_HISTORY_INACCURATE
- MANAGEMENT_EVIDENCE_WEAK
- CAPITAL_ALLOCATION_NOT_TESTED
- PRODUCT_DEFINITION_WRONG
- COMPETITIVE_ADVANTAGE_UNPROVEN
- BUSINESS_MODEL_MISCLASSIFIED
- KEY_QUESTION_NOT_IDENTIFIED
- KEY_QUESTION_NOT_DECOMPOSED
- NO_ORIGINAL_RESEARCH
- MARKET_VIEW_UNSOURCED
- SIMULATED_VIEW_AS_EMPIRICAL
- CONSENSUS_SNAPSHOT_MISSING
- VARIANT_VIEW_UNPROVEN
- HISTORICAL_ACTUAL_WRONG
- REVENUE_DRIVER_MISSING
- MODEL_NOT_BALANCED
- KEY_QUESTION_MODEL_DISCONNECTED
- WORKPAPER_NOT_REPRODUCIBLE
- VALUATION_NOT_REPRODUCIBLE
- PRICE_PATH_NOT_TIME_BOUND
- INDUSTRY_COMPANY_MISMATCH
- SUMMARY_MODEL_MISMATCH
- FACT_INFERENCE_MIXED
- FABRICATED_EVIDENCE

## 9. Standard output

    {
      "eval_schema_version": "investment-company-final-eval/3.1",
      "project_id": "...",
      "as_of": "YYYY-MM-DD",
      "evaluation_stage": "final_integrated",
      "artifacts_scored": [],
      "raw_source_check": {
        "level": 0,
        "trigger": null,
        "claims_checked": []
      },
      "rubric_results": [
        {
          "rubric_id": "C-MOD-04",
          "weight": 4,
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
      "quality_band": "A | B | C | D | F",
      "result": "pass | conditional | fail",
      "human_review_required": false,
      "top_3_remediations": []
    }

Do not store hidden chain-of-thought. Store only auditable evidence and concise scoring rationales.

## 10. Prompt for direct injection into a grader

You are the final-stage grader for company research in a single-name public-equity project. Evaluate primarily the final company summary, financial model, valuation and topic workpapers, and their consistency with the data and industry summaries. Do not read every original PDF, filing, transcript, or research report in full by default.

In the first pass, extract only the decisive evidence, largest gap, and report–model–data–industry contradiction for each rubric item; do not score. In the second pass, rate each item against the 0–4 anchors. Recompute the specified minimum model scope. Return to 3–6 raw-source claims only when high-impact figures are unsourced, market views are questionable, model/report conflicts exist, or fabrication is suspected. Do not reward length, writing style, bullish/bearish stance, model complexity, or target-price precision. Calculate the total mechanically and apply score caps. Write only the evaluation output and do not modify candidate artifacts.

## 11. Stability references

- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [G-Eval](https://arxiv.org/abs/2303.16634)
- [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685)
- [Replacing Judges with Juries](https://arxiv.org/abs/2404.18796)

