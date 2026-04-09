# Atlas Realms — Backend Architecture Portfolio

> **"I build AI products designed to survive unit economics."**

A board game recommendation engine that takes natural language queries and returns ranked, explainable results from a structured database. This folder contains the architecture documentation and code artifacts for the backend pipeline.

Live product: [atlasrealms.com](https://www.atlasrealms.com)

---

## Why This Repo Exists

This repository is not the production codebase. It exists to document the architecture, scoring logic, and product decisions behind Atlas Realms without exposing proprietary data or infrastructure.

---

## What Makes This Interesting

Many early AI recommendation systems are built primarily around prompt reasoning — you describe what you want, the LLM thinks, you get a list. That approach costs $0.40/query, returns different results for the same input, and can't explain why anything appeared.

This system is different: **LLMs handle only natural language understanding. JavaScript handles filtering, scoring, ranking, and explainability.** The result is a deterministic, traceable, ~$0.0012/query pipeline.

---

## Architecture at a Glance

```
[User query: "something chill and co-op for 4 people, not too long"]
         ↓
[Cloudflare Worker]  ← CORS enforcement, routes to pipeline
         ↓
[Flowise Pipeline — 8 nodes]
  ┌──────────────────────────────────────────────────────────────────┐
  │  Node 00  ConstantsProvider     Config registry                  │
  │  Node 01  IntentInterpreter ←── LLM (always)                    │
  │  Node 02  TheResolverJS     ←── JS (always)                     │
  │  Node 03  TheEnricherJS     ←── LLM (conditional, anchor gaps)  │
  │  Node 04  TheMergerJS       ←── JS (always)                     │
  │  Node 04.5 QueryPlanner     ←── JS (always)                     │
  │  Node 05  TheRetrieverJS    ←── JS + KV fetch + embed call      │
  │  Node 06  TheScorerJS       ←── JS (always)                     │
  │  Node 07  TheFormatterJS    ←── JS + LLM blurbs                 │
  └──────────────────────────────────────────────────────────────────┘
         ↓
[{ recommendations: [...], query_summary: {...} }]
```

---

## Contents

| File | What it is |
|---|---|
| [`ADR_hybrid_llm_architecture.md`](./ADR_hybrid_llm_architecture.md) | Architecture Decision Record — *why* the hybrid approach, with real unit economics |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full system walkthrough — every node, every design decision, every edge case |
| [`SCORING_SYSTEM.md`](./SCORING_SYSTEM.md) | Deep dive into the scoring engine — 16+ dimensions, 4 signal tiers, all weights |
| [`workers/flowise-proxy.js`](./workers/flowise-proxy.js) | Cloudflare Worker — CORS enforcement, routes requests to the Flowise pipeline |
| [`workers/catalog-cache.js`](./workers/catalog-cache.js) | Cloudflare Worker — KV-backed game catalog cache, cron-triggered refresh |

**Start with the ADR** if you want to understand the philosophy.
**Read ARCHITECTURE.md** if you want the full technical depth.
**Read SCORING_SYSTEM.md** if you want to understand the ranking engine specifically.

---

## Key Design Decisions

**LLM calls are bounded and purposeful.** The IntentInterpreter always runs (~2,000 tokens). The EnricherJS — a fallback for unrecognized anchor games — runs only when needed. The Formatter generates per-game blurbs via a batched LLM call at the end. The semantic embed call runs in a CF Worker alongside the catalog fetch — it's not an LLM call, so it adds ~100–200ms without touching the token budget.

**5 Intent Dials convert fuzzy language to structured signals deterministically.** "Chill" → `social_temperature:low` → `ideal_interaction: Indirect`. Zero LLM tokens spent on this mapping. The large majority of common board game vocabulary maps through this dictionary without an LLM. Atmospheric and vibe language that doesn't map cleanly to a field is handled by the semantic search layer. The Enricher only fires for the residual: unknown anchor games and structural phrases that fall through both.

**4-tier scoring signal hierarchy.** Explicit (user said it) > Dials (inferred from vibe language) > Inferred (derived from anchor games) > Tolerance (user said it's acceptable). Each tier has calibrated point weights — a game can't win on tolerance signals alone.

**Fail-open vs fail-closed filtering.** Player count is fail-closed (a game with no player data is excluded — recommending an unplayable game is worse than missing a good one). All other hard filters are fail-open (missing data passes through rather than eliminating real candidates).

**Semantic embeddings extend vocabulary coverage without LLM cost.** Phrases the synonym dictionary can't resolve are embedded at query time and compared against pre-computed 768-dim vectors for all ~1,100 games. This handles vibe language, niche mechanics, and unlisted categories that no finite dictionary can cover — at the cost of a parallel CF Worker call, not an LLM token.

**Comparison anchors are excluded from inferred ordinals.** If you ask for "something lighter than Terraforming Mars", TM's heavy complexity is used only for the directional comparison calculation — not placed in the inferred soft preferences. If it were, it would create distance penalties that fight against the comparison directional bonus you're trying to satisfy.

---

## Real Numbers

| Metric | Value |
|---|---|
| End-to-end latency | 5–10s (down from 31–35s, ~84% reduction) |
| Average cost per query (mid-tier) | ~$0.0012 |
| Break-even (per $2 affiliate commission) | ~1,730 mid-tier queries |
| IntentInterpreter | Gemini 2.5 Flash Lite (~$0.00061) |
| Enricher (conditional, when unknown anchors present) | Gemini 2.0 Flash (~$0.00059 when fired) |
| Formatter blurbs | Groq gpt-oss-20b (~$0.00024) |
| Semantic embed call | CF Worker (not an LLM call; +100–200ms) |
| Equivalent pure-LLM approach | ~$0.08–0.40/query |
| Cost at 10k queries/month | ~$12 vs ~$800–4,000 |
| Consistency (10-prompt validation suite) | 100% on current suite (up from 62.5% in Feb 2026) — the suite is small; this reflects the deterministic scoring pipeline, not a comprehensive benchmark. New edge cases can surface inconsistencies; each is diagnosed and fixed in the LLM extraction layer. |
| Airtable data transfer reduction | ~99.75% per query (KV cache vs. 11 paginated calls) |
| Game catalog | 1,000+ titles, 15 taxonomy dimensions each |
| Semantic vectors in KV | 1,000+ × 768-dim float32 (Gemini Embedding 001) |
| Scoring dimensions | 16+ |
| Hard filter stages | 3 (explicit → dial → inferred ±1) |
| Typical candidate pool after filtering | 50–200 from ~1,100 total |
| Max results returned | 6 |

---

## Stack

| Layer | Technology |
|---|---|
| Pipeline orchestration | [Flowise](https://flowiseai.com) (self-hosted) |
| LLM | Gemini 2.5 Flash Lite (IntentInterpreter), Gemini 2.0 Flash (Enricher), Groq GPT-OSS-20B (Formatter blurbs) |
| Semantic embeddings | Gemini Embedding 001 (768-dim, pre-computed, stored in CF KV) |
| Database | Airtable (Inventory + External Seed tables) |
| Catalog cache | Cloudflare KV (12h TTL, stale-while-revalidate) |
| Proxy / CORS | Cloudflare Workers |
| Frontend | React/Vite (Cloudflare Pages) |
| Analytics | PostHog + GA4 |

---

## What This Demonstrates

- Designing a hybrid system that minimizes LLM usage without sacrificing quality
- Engineering a multi-tier scoring engine with explainable, traceable results
- Handling the messy gap between natural language and structured data (synonym maps, fuzzy matching, ordinal distance logic, semantic embeddings for unbounded vocabulary)
- Thinking carefully about failure modes (fail-open vs fail-closed, semantic floor caps, vault quality gates, negation-aware scoring)
- Building for unit economics from day one, not retrofitting them later

---

## License

**Code** (all `.js` and `.ts` files, including the Cloudflare Worker and analytics helpers): released under the [MIT License](./LICENSE). Use them freely in your own projects.

**Written content** (all `.md` files — architecture documents, ADRs, case studies, and product decision records): © Asher Atlas. All Rights Reserved. You are welcome to link to them, reference them, and discuss them, but you may not copy, modify, or republish the text without explicit permission.
