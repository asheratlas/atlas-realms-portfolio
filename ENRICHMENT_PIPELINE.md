# Multi-Model AI Enrichment Pipeline

**The problem:** You have a catalog of 1,000+ items. Each needs 15+ structured fields populated — some objective (does this game support 5 players?), some semi-objective (what mechanics define it?), some subjective (what does it feel like to play?). No single source covers all of them. No single model handles all of them equally well. And you can't afford to be wrong on the objective ones.

**The solution:** A layered pipeline where each step serves a distinct epistemic purpose — primary sources, consensus verification, narrative generation, and vocabulary preparation — combined at the end by a field-type-weighted judge.

---

## The Layered Philosophy

The pipeline is designed around a simple principle: **use the highest-confidence source for each field type, and use lower-confidence sources to verify or fill gaps.**

The accuracy hierarchy for any given field:
1. **Primary source extraction** (rulebooks) — ground truth for objective facts
2. **Multi-model web consensus** — verification and gap-filling from current sources
3. **Narrative generation** — creative fields where quality matters more than verifiability
4. **Semantic vocabulary** — not fields, but structured vocabulary for the search layer
5. **Popularity + accessibility scoring** — derived signals from web data

Each layer runs independently. A consolidation judge combines them at the end with weights calibrated to the confidence level of each source.

---

## Step 1 — Rulebook Sourcing

**Purpose:** Find the authoritative primary source for each game.

For each game in the catalog, the pipeline runs a structured web search to locate the official rulebook PDF. Each result is scored for confidence based on the source domain (publisher site, digital game platforms, educational resources) and the strength of the URL + content signal.

The output is a three-level confidence rating:
- **High** — official publisher source or clearly primary documentation
- **Medium** — well-known game repositories or established community resources
- **Low** — general web results where origin is uncertain

Confidence feeds directly into the consolidation step — rulebook data from a High-confidence source carries more weight than web consensus data; Low-confidence rulebook data is treated more conservatively.

**Why this step exists first:** Rulebook data is the most accurate source for objective facts (exact player counts, exact mechanics definitions, official category classification). Running it before the web consensus step means the consensus layer can be calibrated to fill gaps and add coverage, not to override ground truth.

---

## Step 2 — Rulebook Extraction

**Purpose:** Extract structured taxonomy from the authoritative source.

Using Gemini 2.0 Flash with the rulebook PDF as the primary context, the pipeline extracts objective and semi-objective fields. The extraction prompt specifies exact definitions and counter-examples for each field — the same prompt engineering discipline applied to the multi-model consensus step.

**Confidence multiplier:** The rulebook extraction confidence is factored into the final weight. A High-confidence rulebook source at full weight outweighs any other source for the fields it covers. A Low-confidence source contributes at a fraction of that weight.

**Coverage:** Rulebook extraction covers the fields most reliably answerable from official documentation — rules complexity signals, mechanics definitions, player counts, and cooperative/competitive structure. It deliberately does not attempt subjective fields (atmosphere, tone, play feel) where player experience matters more than rulebook intent.

---

## Step 3 — Three-Model Web Consensus

**Purpose:** Verification, gap-filling, and accuracy on fields that benefit from community knowledge.

Every model has distinct failure modes:

| Model | Strength | Failure Mode |
|---|---|---|
| Gemini 2.0 Flash | Native Google Search grounding — finds current data from live sources | Occasionally verbose, less conservative on edge cases |
| GPT-4o-mini | Follows structured output instructions precisely | Can be confidently wrong on obscure items, occasionally injects jargon |
| Claude Haiku | Most conservative — least likely to hallucinate a field value | Can be overly cautious, sometimes refuses ambiguous classifications |

A field that all three agree on is almost certainly correct. A field where they split is ambiguous and worth flagging rather than committing.

### Field-Type Weighting

**Objective fields** (binary classification, structured facts):
- Require **2/3 majority vote**
- Example: "Does this game have asymmetric factions?" — yes or no, objectively verifiable from the rulebook
- All three models provide a vote; 2/3 required to write `true`

```python
def apply_consensus(gemini_res, gpt_res, claude_res):
    """2/3 majority vote for binary fields."""
    asym_votes = [
        bool(gemini_res.get('asymmetric_factions', False)),
        bool(gpt_res.get('asymmetric_factions', False)),
        bool(claude_res.get('asymmetric_factions', False)),
    ]
    return {
        'asymmetric_factions': sum(asym_votes) >= 2,
        'asym_votes': asym_votes,
        'asym_reasoning': {
            'gemini': gemini_res.get('asymmetric_factions_reasoning', ''),
            'gpt':    gpt_res.get('asymmetric_factions_reasoning', ''),
            'claude': claude_res.get('asymmetric_factions_reasoning', ''),
        }
    }
```

**Subjective fields** (mood, atmosphere, descriptive copy):
- Assigned to the **single model best suited** to the task
- Gemini with Google Search grounding handles atmosphere and mood fields — grounding connects the model to actual player language from reviews and community discussions

### Why Each Model Gets Its Role

**Gemini with Google Search grounding → mood/atmosphere fields**

Grounding connects the model to actual player language from reviews, forums, and community discussions. When asked "what does playing this game feel like?", Gemini can ground its answer in how real players actually described the experience — not just its training data.

**GPT-4o-mini + Claude Haiku → binary classification votes**

For yes/no factual fields, raw accuracy on the definition matters more than creative language. Both models receive the same web context via a single shared Serper API call — one less API call per item, which at 1,100 items eliminates 1,100 redundant web requests.

```python
# One Serper call, injected as context for both GPT and Claude
web_context = serper_web_search(game_title)
gpt_result   = gpt_binary_vote(game_title, existing_data, web_context)
claude_result = claude_binary_vote(game_title, existing_data, web_context)
```

### Prompt Design: The Counter-Example Principle

The most important engineering in this pipeline isn't the consensus logic — it's the field definitions. Vague definitions produce disagreement at boundary cases.

The key design principle: **explicit counter-examples in the definition.**

```
Asymmetric Factions: Each faction has fundamentally DIFFERENT actions, win conditions,
or resource systems — not just different stats or starting positions.

Good examples: Root, Hegemony, Vast, Oath, Uprising.

NOT this mechanic: games with variable player powers where all players still use the
same underlying action system (e.g. Scythe has asymmetric starting stats but same action
structure). Asymmetric starting resources alone does not qualify.
```

The Scythe counter-example directly addressed a case where model agreement was low in pilot runs. Adding it reduced split votes on similar games from ~30% to under 5%.

### The Reasoning Log

Every consensus decision logs all three models' reasoning, not just the outcome:

```json
{
  "asymmetric_factions": true,
  "asym_votes": [true, true, false],
  "asym_reasoning": {
    "gemini": "Each faction in Root operates under fundamentally different rules...",
    "gpt": "Root has asymmetric factions with different rules for each player faction...",
    "claude": "The game has player powers but I'm uncertain whether the underlying action structure is sufficiently different to qualify."
  }
}
```

Claude's dissent — logged alongside the majority decision — is itself useful data. Cases where two models vote yes and one votes no are worth auditing: the dissenting reasoning sometimes reveals a genuine edge case that the definition should address.

---

## Step 4 — Narrative Generation (Writer Layer)

**Purpose:** Generate the editorial text fields that users actually read.

The scoring pipeline's text-matching layer operates against the game's editorial descriptions — the language that captures how a game feels, what kind of group it suits, and what makes it memorable. These fields need to be accurate, specific, and written in vocabulary that maps to how players talk about games.

The writer layer generates these descriptions using Gemini with grounding, drawing on community reviews and player language rather than just rulebook specifications. A game that "demands strategic depth from every player" is more useful than "a strategy game with many decisions."

**Quality control:** A sample of outputs is reviewed against known games before production runs. The target is specificity — descriptions that distinguish games from each other rather than generic hobbyist copy that could apply to any mid-weight euro.

---

## Step 5 — Semantic Vocabulary Generation

**Purpose:** Prepare structured phrase clusters for the embedding search layer.

The recommendation engine uses pre-computed embedding vectors to handle vocabulary the structured scoring system can't map — atmospheric language, niche mechanics, unlisted categories. Each game's embedding is built from a curated set of text rather than the full editorial description.

**The key insight:** Monolithic descriptions dilute cosine signal. When a game's full text is embedded as one vector, a phrase like "pirate theme" competes with every other concept in the description for similarity signal. A user asking for "pirate games" gets a noisy match against everything mixed together.

The semantic vocabulary step generates category-separated phrase clusters — distinct semantic groups that can be embedded independently. Thematic vocabulary (pirates, medieval, cosmic horror) is separated from mechanical vocabulary (deck construction, area tension, resource conversion) and experiential vocabulary (relaxed, tense, chaotic, meditative). Each cluster can be matched independently against query phrases.

This makes the embedding layer behave more like targeted semantic search and less like document similarity — a query phrase for "pirate atmosphere" matches against thematic clusters specifically, not against everything the game description contains.

---

## Step 6 — Popularity and Accessibility Scoring

**Purpose:** Generate pre-computed tiebreaker signals that don't belong in the scoring pipeline itself.

When two games score identically on every user-expressed preference, the tiebreaker should surface the game that's more likely to be discoverable, accessible, and well-suited to the session.

The pipeline computes composite signals from web data:
- **Popularity signal** — relative community recognition across hobby sources
- **Accessibility signal** — availability through retail channels (not price, just whether the game is findable)

These are combined into a single pre-computed tiebreaker score stored alongside the game data. The scoring pipeline uses it only as the second-to-last tiebreaker, after scoring breadth and data completeness — it's a soft nudge toward better-known games when everything else is tied, not a ranking factor.

---

## The Judge: Consolidation and Conflict Resolution

After all pipeline steps complete, a consolidation layer merges the outputs from each source into final field values. Conflicts between sources are resolved by field-type-calibrated weights:

| Field category | Weight order |
|---|---|
| Objective facts (player count, binary mechanics) | Rulebook (High conf.) > Web consensus > Single model |
| Semi-objective (mechanics list, complexity tier) | Rulebook = Web consensus > Single model |
| Subjective (tone, atmosphere, narrative) | Writer layer > Web consensus (Gemini grounded) |

The rulebook confidence level modifies the base weight: `weight × (confidence_score / 100)`. A Low-confidence rulebook source contributes at a fraction of its base weight, allowing web consensus to dominate when the primary source is uncertain.

Fields flagged as uncertain by the consensus layer (no 2/3 majority, all three models split) are written to a flagged output for manual review rather than being committed automatically.

---

## Resilience Design

**Auto-resume:** The script skips items where the target fields are already populated. A batch that fails halfway through can be restarted without re-processing completed records.

**Dry run mode:** `--dry-run` verifies API connectivity and field schema without writing anything. Required before any production run.

**Retry logic:** Each model call retries up to 3 times on transient errors before logging the failure and continuing. One bad API response doesn't kill the batch.

**Field validation before writes:** A preflight check confirms the target fields exist before the first batch starts. Failing fast on a missing field prevents a run that writes nothing while appearing to succeed.

---

## Cost

| Component | Per game | 1,000 games |
|---|---|---|
| Rulebook sourcing (web search) | ~$0.001 | ~$1.00 |
| Rulebook extraction (Gemini Flash) | ~$0.0003 | ~$0.30 |
| Web consensus (3 models + Serper) | ~$0.0016 | ~$1.60 |
| Writer / narrative generation | ~$0.0008 | ~$0.80 |
| Semantic vocabulary generation | ~$0.0005 | ~$0.50 |
| Popularity scoring | ~$0.0007 | ~$0.70 |
| **Total** | **~$0.005** | **~$4.90** |

Under $5 to fully enrich 1,000 games across all pipeline layers. The dominant cost is the web data layer (Serper + LLM calls) rather than the model inference itself — a direct consequence of using smaller, task-appropriate models (Flash, mini, Haiku) for structured classification rather than defaulting to flagship models.

---

## Results

- **1,000+ records enriched** across all pipeline layers, 2 failures on extraction step (99.8% success rate)
- **Consensus rate on binary fields:** ~87% unanimous (all 3 agree), ~11% majority (2/3), ~2% flagged for manual review
- **Writer layer quality:** Sample of 50 reviewed — rated 8.3/10 on specificity vs. generic alternatives
- **Semantic vocabulary:** Category-separated clusters generated for all records; embedding search covers vocabulary the structured scoring system cannot reach

---

## What Transfers to Other Domains

This pattern applies to any catalog enrichment problem where:

1. You have objective fields that are verifiable from primary sources (rulebook → exact player count)
2. You have semi-objective fields that benefit from multi-source verification (mechanics → consensus vote)
3. You have subjective fields where a single best-suited source beats an average (mood → grounded Gemini)
4. You have vocabulary that needs preparing for downstream search (semantic clusters → embedding layer)
5. Cost and reliability matter more than using the most expensive model for everything

The specific models, definitions, and field categories are domain-specific. The layered architecture — primary source → consensus → narrative → vocabulary → scoring — is not.
