# Final Evaluation Scorecard for Single-Name Data Research

Version: v3.1-en<br>
Evaluation stage: Comprehensive evaluation after multiple rounds of data research; not intended for turn-by-turn scoring<br>
Primary artifacts: The data agent's final summaries, source index, structured datasets, and topic-specific workpapers<br>
Raw-source policy: Do not read every source document in full by default; perform targeted checks only when anomalies or material disputes arise<br>
Total score: 100 points across 24 atomic rubric items

## 1. Evaluation objective

This scorecard evaluates whether the data research for a single public-equity project has produced a complete, accurate, traceable evidence base that industry and company agents can use directly.

The evaluation focuses on the data agent's final artifacts rather than re-auditing every raw document:

1. Whether material sources were acquired and entered in the index;
2. Whether the summaries accurately and completely organize the material information;
3. Whether historical financials, forecasts, and market-price data are structured and usable;
4. Whether sources, confidence, conflicts, and data gaps are clearly identified;
5. Whether the agent conducted question-driven, differentiated research beyond standard documents.

## 2. Default reading scope

### 2.1 Must read

- The data agent's final summary and topic-specific summaries;
- The source index, document inventory, and gap list;
- Structured tables for five years of annual financials, three years of quarterly financials, consensus estimates, and share prices;
- Earnings-transcript digests, prospectus summaries, sell-side view digests, and industry-source digests;
- Workpapers covering alternative data and internally constructed datasets.

### 2.2 Confirm existence only; do not read in full by default

- Original prospectuses, annual reports, and regulatory filings;
- Original earnings-call transcripts;
- Full sell-side and industry reports;
- Original webpages, news articles, academic papers, and product reviews.

The grader may use the file tree and source index to confirm file type, period, and existence. If no anomaly is detected, the score must not be reduced merely because the raw files were not opened.

### 2.3 Triggers for raw-source spot checks

Return to the cited source passage only when:

- A number in the summary differs from the workpaper;
- A high-impact number lacks a period, unit, or source;
- Structured data does not reconcile or appears implausible;
- A key variant view relies on a single weak source;
- A citation may not support the associated claim;
- Fabrication, tampering, or systematic hallucination is suspected.

For a normal evaluation, checking 3–6 high-impact claims is sufficient. Expand the sample only when a serious violation is suspected.

## 3. Stable scoring protocol

### 3.1 Two-pass evaluation

In the first pass, read and extract evidence without assigning scores. Record:

- The final summaries and workpapers reviewed;
- No more than two decisive positive evidence points for each rubric item;
- The single most important gap for each rubric item;
- Summary–workpaper contradictions;
- Whether a raw-source spot check was triggered.

In the second pass, assign an integer rating from 0 to 4 to each item. The total score must be calculated mechanically. Do not form a holistic score first and reverse-engineer the item ratings.

### 3.2 Common 0–4 anchors

| Rating | Meaning | Decision rule |
|---:|---|---|
| 4 | Complete, professional, and directly usable | All critical requirements are met and there is no material error |
| 3 | Good | Most requirements are met, with only limited non-critical gaps |
| 2 | Partially complete | Substantive work exists, but one critical link is missing and material rework is required |
| 1 | Very weak | Only fragments or assertions exist; most requirements are unmet |
| 0 | Missing or incorrect | No relevant artifact exists, or a fundamental error could reverse the conclusion |

Boundary rules:

- A rating of 4 requires all critical conditions for the item;
- A material error caps the relevant item at 2;
- A conclusion without summary or workpaper evidence is capped at 1;
- Ratings of 1 and 3 must explain which lower anchor was cleared and why the next anchor was not;
- Do not score based on length, jargon, file count, or visual polish;
- As a rule, deduct for a defect only in the most directly affected item.

### 3.3 Low-confidence regrading

Run a second independent judge only when:

- Any item with a weight of at least 5 has confidence=low;
- The total score is within 3 points of the pass threshold;
- A score cap is disputed;
- The output will be used as a formal post-training label.

Escalate to human review if the two total scores differ by more than 6 points or if the same critical item differs by at least 2 rating levels.

## 4. Scoring formula

    item_score = item_weight × rating / 4
    raw_score = Σ item_score
    final_score = min(raw_score, applicable_caps)

For every item, output the rating, decisive evidence, why_not_higher, error_tags, and confidence independently.

## 5. 100-point atomic rubric

### A. Coverage of required materials (32 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| D-COV-01 | 4 | Prospectus, follow-on offering, or secondary-listing materials | Applicable documents are indexed; the summary covers business, industry, financials, risks, and ownership; material documents from the past two years receive focused treatment | Documents exist, but the summary covers only some critical sections | Applicable documents were not acquired or incorporated into the research |
| D-COV-02 | 5 | Most recent four earnings-call transcripts | Four consecutive quarters are covered; the work compares performance attribution, guidance, business trends, opportunities, new products, and changing Q&A priorities | Only 2–3 quarters are covered, or quarterly extracts are not synthesized longitudinally | Recent-quarter materials are largely missing |
| D-COV-03 | 5 | Five years of annual financial statements | Five years of income statements, year-end balance sheets, and cash-flow statements are complete; currency, units, and fiscal-year conventions are clear | Years or statements are incomplete, but the main historical trends remain usable | No systematic annual financial history |
| D-COV-04 | 4 | Three years of quarterly income statements | Approximately 12 quarters are available; standalone-quarter versus year-to-date presentation, 53-week years, restatements, and M&A effects are handled correctly | Only 6–11 quarters are available or some key lines are missing | No quarterly series, or quarterly and year-to-date data are mixed |
| D-COV-05 | 4 | Next-quarter and three-year forecasts | Next-quarter and three-year consensus are available; key financial line items, major business variables such as capex and product milestones, and the snapshot date are clear | Only annual revenue/EPS or one sell-side forecast is available | No forward-expectations baseline |
| D-COV-06 | 3 | Five years of monthly share prices and major turning points | The monthly series is complete and the adjusted-price convention is clear; major inflections are linked to earnings or events in a timeline | A price chart exists, but the period, adjustment convention, or event mapping is incomplete | No usable price history |
| D-COV-07 | 3 | Sell-side and investment-bank research | Initiation or deep-dive reports from the past three years and the evolution of major views over the past two years are covered; institution, date, and assumptions are clear | Only a small number of reports or target-price lists are available | Completely missing or sources are not identifiable |
| D-COV-08 | 2 | Authoritative industry sources | All material business segments are covered; industry definitions, methodology, sample, and version are recorded | Industry sources exist, but boundaries or quality are inconsistent | No industry research for a material business |
| D-COV-09 | 2 | Internal historical analogues | Where accessible, relevant internal reports, datasets, views, and comparability are documented | Only generic historical references are present, or the search scope and comparability are weakly explained | An accessible internal repository clearly exists but was not searched; may be N/A if no such materials objectively exist |

D-COV items should be scored primarily from the source index, summaries, and file tree. As a quantitative guide: a rating of 4 means applicable categories are substantially complete with no missing critical category; a rating of 2 means roughly one-half to three-quarters are usable; a rating of 0 means critical categories are broadly absent.

### B. Accuracy, source quality, and fidelity of synthesis (28 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| D-ACC-01 | 5 | Source hierarchy and credibility assessment | Material facts prioritize primary sources; methodology, timeliness, conflicts of interest, and limitations are clear for third-party, sell-side, and alternative data | Sources are present, but methodology and credibility are rarely assessed | Anonymous secondary information is treated as established fact |
| D-ACC-02 | 8 | Accuracy of numbers, dates, units, and conventions | Summaries and structured workpapers agree; key totals, components, growth rates, and cash-flow relationships reconcile; currency, units, and accounting basis are clear | Minor non-critical errors exist or some conventions require manual interpretation | Material figures are systematically assigned to the wrong period, currency, or unit |
| D-ACC-03 | 6 | Completeness of material synthesis | Topic summaries cover material business, industry, risk, financial, ownership, guidance, and Q&A information while preserving conditions and context | Broadly correct, but selective omissions or insufficient context remain | Material information is taken seriously out of context, or critical risks and conditions are systematically omitted |
| D-ACC-04 | 4 | Cross-validation of material data | Key third-party data are checked against an independent source or a bottom-up estimate; definitional differences and non-comparability are explained | Some cross-validation exists, but material external data still rely on one source | Conflicting figures are combined without resolution |
| D-ACC-05 | 5 | Treatment of conflicts, revisions, and uncertainty | Source conflicts, restatements, and estimate revisions are explicitly listed; the selected value, rationale, range, and confidence are clear | Some conflicts are identified, but treatment is inconsistent | Conflicts are hidden or only data supporting the existing view are selected |

D-ACC-02 should begin with summary–workpaper consistency and internal reconciliation. Return to raw sources only when anomalies are found; comprehensive source-by-source checking is not required when the artifacts reconcile.

### C. File organization, indexing, and traceability (22 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| D-ORG-01 | 4 | Complete source index | The index covers all valid files and includes type, title, source, date, period, path, materiality, and version | An inventory exists, but fields or file coverage are incomplete | No effective index |
| D-ORG-02 | 6 | Source localization for material claims | High-impact facts and numbers can be traced to a structured workpaper and to the relevant page, section, or table in the source file; paths are valid | Most claims are traceable, but some citations stop at the document level | Many material figures are unsourced or use false locators |
| D-ORG-03 | 4 | Source and confidence labels | Company/regulatory sources, sell-side, industry institutions, buy-side/rumor, and agent estimates are distinguished; confidence matches evidence strength | Source labels exist, but confidence standards are inconsistent | Facts, rumors, and estimates are mixed together |
| D-ORG-04 | 3 | Separation of company, industry, and market views | Derived materials are organized into company facts, industry evidence, and market expectations/narratives, with cross-references preserved | Some organization exists, but duplication and mixing remain | Downstream agents cannot determine the intended use of materials |
| D-ORG-05 | 5 | Compression and retrievability of the data summary | The summary accurately captures material facts, changes, risks, and gaps; priorities are clear and workpapers are easy to reach | The summary is usable, but omissions, redundancy, or retrieval costs remain high | The summary is merely a file list or materially inconsistent with the workpapers |

### D. Active research and information gain (12 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| D-DEP-01 | 5 | Question-driven alternative evidence | Product, technical, academic, hiring, patent, channel, supply-chain, or historical data are gathered to test explicit investment questions | Alternative evidence exists, but its connection to key questions is weak | Only standard documents are collected mechanically |
| D-DEP-02 | 4 | Multi-source triangulation and proprietary datasets | Multiple sources are converted into a comparable dataset or validation chain; methodology, sample, bias, and reproduction steps are clear | A basic aggregation exists, but methodology and bias are insufficiently explained | Figures are pasted together and cannot be reproduced |
| D-DEP-03 | 3 | Gap discovery and next-step search plan | Unknowns, their importance, available proxies, next sources, and priorities are explicit | Only a generic “further research required” statement is present | Obvious critical gaps are not recognized |

### E. Downstream usability (6 points)

| ID | Weight | Criterion | Rating 4 | Rating 2 | Rating 0 |
|---|---:|---|---|---|---|
| D-HOF-01 | 4 | Structure, conventions, and reusability | Table fields are stable; periods, units, currencies, formulas, and source columns are complete; downstream agents can filter and model directly | Data are readable but require substantial cleaning and manual interpretation | Material data cannot be extracted or the format is broken |
| D-HOF-02 | 2 | Handoff summary and prioritization | The handoff clearly explains what was acquired, the most important materials, key findings, conflicts, gaps, and recommended reading order | A summary exists, but priorities and gaps are not sufficiently clear | No effective handoff |

## 6. N/A rules

- Use N/A only when an item is objectively inapplicable;
- “Not found” is missing, not N/A;
- Copyright or access restrictions are unavailable, not N/A;
- An unavailable item may receive at most 2 if the search record, substitute source, and impact assessment are documented;
- Remove N/A weights from the denominator and renormalize the score;
- If more than 10 points of weight are marked N/A, require human review.

## 7. Score caps and pass criteria

| Condition | Maximum final score |
|---|---:|
| Confirmed fabrication of files, sources, or material data | 20 |
| No final data-agent summary | 40 |
| No source index and no usable structured workpapers | 59 |
| Both the latest four-quarter transcript set and five-year annual financials are materially missing | 49 |
| material_claim_traceability is clearly below 60% | 59 |
| A material summary–workpaper contradiction could change a major research judgment | 59 |
| Required-material coverage is clearly below 70% | 69 |

| Score | Quality band |
|---:|---|
| 90–100 | A: bench-quality |
| 80–89 | B: professional |
| 70–79 | C: usable with rework |
| 60–69 | D: weak |
| 0–59 | F: failed |

Pass requirements:

- final_score ≥80;
- D-ACC-02, D-ORG-02, and D-ORG-05 are each ≥3;
- None of D-COV-02 through D-COV-05 is rated 0;
- No fabrication or material contradiction.

## 8. Recommended error tags

- MISSING_REQUIRED_SOURCE
- MISSING_PERIOD
- SOURCE_UNVERIFIABLE
- WRONG_NUMBER
- WRONG_PERIOD
- WRONG_UNIT_OR_CURRENCY
- GAAP_NON_GAAP_MIX
- QUARTER_YTD_MIX
- EXTRACTION_OMISSION
- CONFLICT_UNRESOLVED
- ESTIMATE_PRESENTED_AS_FACT
- CONSENSUS_SNAPSHOT_MISSING
- INDEX_INCOMPLETE
- SUMMARY_WORKPAPER_MISMATCH
- NO_ACTIVE_DISCOVERY
- FABRICATED_EVIDENCE

## 9. Standard output

    {
      "eval_schema_version": "investment-data-final-eval/3.1",
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
          "rubric_id": "D-ACC-02",
          "weight": 8,
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

You are the final-stage grader for a single-name data-research project. Evaluate primarily the data agent's final summaries, source index, structured datasets, and topic workpapers. Do not conduct a comprehensive audit of raw PDFs, webpages, or research reports.

First list the files and read the derived artifacts in full. In the first pass, record only the decisive evidence, largest gap, and summary–workpaper contradiction for each rubric item; do not score. In the second pass, rate each item against the 0–4 anchors. Return to 3–6 raw-source claims only when high-impact figures are unsourced, structured data are anomalous, summaries conflict with workpapers, weak sources support a key claim, or fabrication is suspected. Do not reward length, file count, or professional-sounding language. Calculate the total mechanically, then apply score caps. Write only the evaluation output and do not modify candidate artifacts.

## 11. Stability references

- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): clear rubrics, score-level examples, pass/fail criteria, human calibration, and low-ambiguity evaluation formats.
- [G-Eval](https://arxiv.org/abs/2303.16634): explicit evaluation steps and structured form filling.
- [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685): controls for verbosity, position, and self-preference biases.
