# AI-Fiqh (RZ-Fiqh) — Planning & Knowledge Repository

Private planning repository for **RZ-Fiqh**, a citation-first Islamic jurisprudence (fiqh) assistant and knowledge operations platform: PostgreSQL-canonical curated knowledge, hybrid retrieval (exact + lexical + vector + relationships), adaptive context, model-agnostic generation, deterministic citation validation, and evaluation-driven release gates.

- **North-star metric:** Verified Answer Completion Rate (VACR)
- **Plan:** 45/45 Must requirements covered · 13 epics · 86 sprint-ready tickets · 19 ordered migrations · 610 story points

## Repository layout

```text
├── okf/        # OKF v0.2 knowledge bundle (the docs, in Google Open Knowledge Format v0.2)
│   ├── index.md                        # bundle root & map
│   ├── product-overview.md             # thesis, principles, users, surfaces
│   ├── architecture-decisions.md       # database-first decision, ADR-001..006, delivery rules
│   ├── delivery-plan.md                # epic map + dependency waves 0–8
│   ├── database-migration-plan.md      # DB-001..DB-019
│   ├── release-gates.md                # launch thresholds & gate policy
│   └── epics/                          # 13 epic concepts incl. full ticket detail
├── docs/       # authoritative source documents (PRD v2.0, Engineering Backlog v2.0 .md + .json)
└── scripts/    # generators (OKF epic concepts from the backlog JSON; GitHub issue registration)
```

## OKF v0.2 bundle

The [`okf/`](okf/) directory is an [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle: a directory of Markdown concepts with YAML frontmatter. Every concept declares its `type`, provenance `sources` (the PRD and backlog under `docs/`), `generated` trust metadata, and lifecycle `status`. Regenerate the epic concepts after editing the backlog JSON:

```bash
python3 scripts/generate_okf_epics.py
```

## Issue tracking

The 86 backlog tickets are registered as GitHub issues, grouped by epic milestones (`EP-00` … `EP-12`) and labeled by type, priority, and dependency wave. Re-run registration idempotently:

```bash
python3 scripts/register_github_issues.py
```

## Source documents

| Document | Description |
|---|---|
| [PRD v2.0](docs/RZ-Fiqh_Database_First_RAG_PRD_v2.0.md) | Database-First Knowledge & Retrieval Platform product requirements |
| [Engineering Backlog v2.0](docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md) | Epics, waves, migrations, 86 sprint-ready tickets, traceability |
| [Backlog JSON](docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.json) | Machine-readable backlog used by the generators |
