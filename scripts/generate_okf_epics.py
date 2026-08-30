#!/usr/bin/env python3
"""Generate OKF v0.2 epic concept files from the RZ-Fiqh backlog JSON.

Usage: python3 scripts/generate_okf_epics.py
Reads  docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.json
Writes okf/epics/EP-XX-<slug>.md
"""
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKLOG = ROOT / "docs" / "RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.json"
OUT_DIR = ROOT / "okf" / "epics"

GENERATED_AT = (
    subprocess.run(["git", "log", "-1", "--format=%cI"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)


def yq(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def main() -> None:
    data = json.loads(BACKLOG.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index_rows = []

    for epic in data["epics"]:
        eid = epic["id"]
        slug = slugify(f"{eid} {epic['name']}")
        tickets = [t for t in data["tickets"] if t["epic_id"] == eid]
        points = sum(t["story_points"] for t in tickets)
        migrations = sorted({m for t in tickets for m in t.get("migration_ids", "").split(", ") if m})

        lines = []
        lines.append("---")
        lines.append("type: Epic")
        lines.append(f"title: {yq(f'{eid} — {epic['name']}')}")
        lines.append(f"description: {yq(epic['outcome'])}")
        lines.append(f"tags: [rz-fiqh, epic, wave-{epic['wave']}]")
        lines.append("status: draft")
        lines.append("generated:")
        lines.append("  by: agent:zcode")
        lines.append(f"  at: {GENERATED_AT}")
        lines.append("sources:")
        lines.append("  - resource: ../../docs/RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.md")
        lines.append("    id: backlog-v2")
        lines.append("    title: RZ-Fiqh Database-First Engineering Execution Backlog v2.0")
        lines.append("    author: ShieldTech Team / RZ-Fiqh")
        lines.append("    last_modified: \"2026-08-30\"")
        lines.append("  - resource: ../../docs/RZ-Fiqh_Database_First_RAG_PRD_v2.0.md")
        lines.append("    id: prd-v2")
        lines.append("    title: RZ-Fiqh Database-First Knowledge & Retrieval Platform PRD v2.0")
        lines.append("    author: ShieldTech Team / RZ-Fiqh")
        lines.append("    last_modified: \"2026-08-30\"")
        lines.append("---")
        lines.append("")
        lines.append(f"# {eid} — {epic['name']}")
        lines.append("")
        lines.append(f"**Outcome:** {epic['outcome']}")
        lines.append("")
        lines.append(f"- **Owner:** {epic['owner']}")
        lines.append(f"- **Wave:** {epic['wave']}")
        lines.append(f"- **Depends on:** {epic['depends_on'] or '—'}")
        lines.append(f"- **Exit criteria:** {epic['exit_criteria']}")
        lines.append(f"- **Requirement coverage:** {epic['fr_ids']}")
        lines.append(f"- **Tickets:** {epic['ticket_count']} tickets, {points} story points")
        lines.append(f"- **Migrations:** {', '.join(migrations) if migrations else '—'}")
        lines.append("")
        lines.append("## Tickets")
        lines.append("")
        lines.append("| Ticket | Title | Type | Component | Priority | Points | Wave | Dependencies |")
        lines.append("|---|---|---|---|---|---:|---:|---|")
        for t in tickets:
            deps = t.get("dependencies", "") or "—"
            lines.append(
                f"| **{t['id']}** | {t['title']} | {t['type']} | {t['component']} | {t['priority']} "
                f"| {t['story_points']} | {t['wave']} | {deps} |"
            )
        lines.append("")
        lines.append("## Ticket detail")
        lines.append("")
        for t in tickets:
            lines.append(f"### {t['id']} — {t['title']}")
            lines.append("")
            lines.append(f"- **Requirement coverage:** {t['fr_ids']}")
            lines.append(f"- **Points / wave / owner:** {t['story_points']} / {t['wave']} / {t['owner_role']}")
            lines.append(f"- **Migrations:** {t['migration_ids']}")
            lines.append(f"- **User story:** {t['user_story']}")
            lines.append(f"- **Scope:** {t['scope']}")
            lines.append(f"- **Acceptance criteria:** {t['acceptance_criteria']}")
            lines.append(f"- **Required test evidence:** {t['test_evidence']}")
            lines.append("")
        lines.append("## Related concepts")
        lines.append("")
        lines.append("- [Delivery plan](../delivery-plan.md)")
        lines.append("- [Database migration plan](../database-migration-plan.md)")
        lines.append("- [Bundle index](../index.md)")
        lines.append("")

        out = OUT_DIR / f"{slug}.md"
        out.write_text("\n".join(lines), encoding="utf-8")
        index_rows.append((eid, epic["name"], epic["wave"], epic["ticket_count"], points, out.name))

    print(f"Wrote {len(index_rows)} epic concepts to {OUT_DIR}:")
    for eid, name, wave, n, pts, fname in index_rows:
        print(f"  {eid}: {fname} (wave {wave}, {n} tickets, {pts} pts)")


if __name__ == "__main__":
    main()
