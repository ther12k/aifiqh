# Archived Design Artifact

This directory is **not part of the RZ-Fiqh runtime architecture**.

Canonical curated knowledge is stored in PostgreSQL.
Files here are retained only as historical design/reference material.
Do not add runtime dependencies, migrations, or ingestion logic against it.

---

The bundle below was the v2.0 planning deliverable (Google Open Knowledge
Format v0.2) produced before the database-first architecture replaced the
OKF runtime path. It remains accurate as a snapshot of the plan at that
time; the authoritative sources for current planning are the PRD and
engineering backlog in [`docs/`](../../).

CI enforces the quarantine: no runtime package may import from
`docs/archive/`, and no migration may reference these schemas.
