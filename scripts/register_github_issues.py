#!/usr/bin/env python3
"""Register the RZ-Fiqh backlog as GitHub issues (idempotent).

For each of the 86 backlog tickets, creates one issue labeled by epic,
type, priority, and wave, assigned to the epic milestone. Dependencies are
cross-linked (#N) in a second pass.

Usage:  python3 scripts/register_github_issues.py [--repo OWNER/REPO]
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKLOG = ROOT / "docs" / "RZ-Fiqh_Database_First_Engineering_Backlog_v2.0.json"
DEFAULT_REPO = "ther12k/aifiqh"

TYPE_COLORS = {
    "backend": "1d76db", "frontend": "a2eeef", "platform": "0e8a16",
    "data": "fbca04", "ai": "5319e7", "qa": "d93f0b", "architecture": "b60205",
    "security": "9c2b4e", "product": "c5def5", "full-stack": "006b75",
}
PRIORITY_COLORS = {"must": "b60205", "enabler": "93d8f7"}
EPIC_COLOR = "5319e7"
WAVE_COLOR = "c2e0c6"


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def run(args, retries=4):
    for attempt in range(retries):
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
        err = (r.stderr or "") + (r.stdout or "")
        if "already exists" in err:
            return ""
        if "rate limit" in err.lower():
            wait = 20 * (attempt + 1)
            print(f"  rate-limited on {' '.join(args[:3])}; sleeping {wait}s", flush=True)
            time.sleep(wait)
            continue
        print(f"  ERROR: {' '.join(args)}\n  {err.strip()[:400]}", flush=True)
        return None
    return None


def gh(*args):
    return run(["gh", *args])


def main() -> int:
    repo = DEFAULT_REPO
    if "--repo" in sys.argv:
        repo = sys.argv[sys.argv.index("--repo") + 1]

    data = json.loads(BACKLOG.read_text(encoding="utf-8"))
    epics = {e["id"]: e for e in data["epics"]}
    tickets = data["tickets"]

    # ---- labels ------------------------------------------------------------
    type_labels = sorted({f"type/{slug(t['type'])}" for t in tickets})
    all_labels = (
        type_labels
        + [f"priority/{p.lower()}" for p in sorted({t["priority"].lower() for t in tickets})]
        + [f"epic/{e}" for e in epics]
        + [f"wave-{w}" for w in sorted({t["wave"] for t in tickets})]
        + ["ticket"]
    )
    existing_labels = {
        l["name"] for l in json.loads(gh("label", "list", "-R", repo, "--limit", "200", "--json", "name") or "[]")
    }
    for label in all_labels:
        if label in existing_labels:
            continue
        color = next((c for k, c in TYPE_COLORS.items() if label.startswith(f"type/{k}")), None)
        if label.startswith("priority/"):
            color = PRIORITY_COLORS.get(label.split("/", 1)[1])
        elif label.startswith("epic/"):
            color = EPIC_COLOR
        elif label.startswith("wave-"):
            color = WAVE_COLOR
        elif label == "ticket":
            color = "cccccc"
        gh("label", "create", "-R", repo, label, "--color", color or "d4c5f9", "--force")
        print(f"label created: {label}", flush=True)

    # ---- milestones --------------------------------------------------------
    existing_ms = {
        m["title"]: m["number"]
        for m in json.loads(gh("api", f"repos/{repo}/milestones?state=all&per_page=100") or "[]")
    }
    ms_of = {}
    for eid, e in epics.items():
        title = f"{eid} — {e['name']}"
        if title in existing_ms:
            ms_of[eid] = existing_ms[title]
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(f"{e['outcome']}\n\nWave {e['wave']} · depends on: {e['depends_on'] or '—'} · "
                    f"{e['ticket_count']} tickets · {e['story_points']} points\n\n"
                    f"Exit criteria: {e['exit_criteria']}")
            desc = f.name
        out = gh("api", "--method", "POST", f"repos/{repo}/milestones",
                 "-f", f"title={title}", "-F", f"description=@{desc}")
        ms_of[eid] = json.loads(out)["number"] if out else None
        print(f"milestone created: {title}", flush=True)
        time.sleep(0.2)

    # ---- existing issues (idempotency) -------------------------------------
    existing = json.loads(gh("issue", "list", "-R", repo, "--state", "all",
                             "--limit", "500", "--json", "number,title") or "[]")
    issue_of = {}
    for it in existing:
        m = re.match(r"^\[([A-Z]+-\d+)\]", it["title"])
        if m:
            issue_of[m.group(1)] = it["number"]
    print(f"{len(issue_of)} ticket issues already exist", flush=True)

    def body_for(t, links=None):
        eid = t["epic_id"]
        e = epics[eid]
        deps = t.get("dependencies", "") or "—"
        if links:
            deps = ", ".join(
                f"[{d}](#{links[d]})" if d in links else d
                for d in [d.strip() for d in deps.split(",")] if d
            ) or "—"
        ac = "\n".join(f"- {a.strip()}" for a in t["acceptance_criteria"].split(";"))
        te = "\n".join(f"- {x.strip()}" for x in t["test_evidence"].split(";"))
        return (
            f"> Epic **{eid} — {e['name']}** · Wave {t['wave']} · "
            f"{t['story_points']} points · Priority **{t['priority']}**\n\n"
            "| | |\n|---|---|\n"
            f"| **Type / Component** | {t['type']} / {t['component']} |\n"
            f"| **Requirement coverage** | {t['fr_ids']} |\n"
            f"| **Owner role** | {t['owner_role']} |\n"
            f"| **Dependencies** | {deps} |\n"
            f"| **Migrations** | {t['migration_ids']} |\n\n"
            f"## User story\n\n{t['user_story']}\n\n"
            f"## Scope\n\n{t['scope']}\n\n"
            f"## Acceptance criteria\n\n{ac}\n\n"
            f"## Required test evidence\n\n{te}\n"
        )

    # ---- create issues -----------------------------------------------------
    for t in tickets:
        tid = t["id"]
        if tid in issue_of:
            continue
        title = f"[{t['epic_id']}] {tid} — {t['title']}"
        labels = [f"epic/{t['epic_id']}", f"type/{slug(t['type'])}",
                  f"priority/{t['priority'].lower()}", f"wave-{t['wave']}", "ticket"]
        ms = ms_of.get(t["epic_id"])
        ms_title = f"{t['epic_id']} — {epics[t['epic_id']]['name']}" if ms else None
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
            f.write(body_for(t))
            body = f.name
        args = ["issue", "create", "-R", repo, "--title", title, "--body-file", body,
                "--label", ",".join(labels)]
        if ms:
            args += ["--milestone", ms_title]
        out = gh(*args)
        m = re.search(r"/issues/(\d+)$", out or "")
        if m:
            issue_of[tid] = int(m.group(1))
            print(f"#{m.group(1)}  {title}", flush=True)
        else:
            print(f"FAILED to create {tid}: {out}", flush=True)
        time.sleep(0.8)

    # ---- second pass: cross-link dependencies ------------------------------
    for t in tickets:
        tid = t["id"]
        n = issue_of.get(tid)
        deps = [d.strip() for d in (t.get("dependencies", "") or "").split(",") if d.strip()]
        if not n or not any(d in issue_of for d in deps):
            continue
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
            f.write(body_for(t, links=issue_of))
            body = f.name
        gh("issue", "edit", str(n), "-R", repo, "--body-file", body)
        time.sleep(0.2)

    print(f"\nDone. {len(issue_of)}/{len(tickets)} ticket issues registered in {repo}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
