"""Exercise semantic scheduling, merged-candidate replay and durable review state."""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def save(path, value):
    path.write_text(json.dumps(value))


def run(*arguments, status=0):
    result = subprocess.run(arguments, capture_output=True, text=True, check=False)
    assert result.returncode == status, (arguments, result.stdout, result.stderr)
    return json.loads(result.stdout)


def exercise(cli, directory):
    project = directory / "project"
    trusted = directory / "trusted"
    project.mkdir()
    trusted.mkdir()
    run(cli, "init", project)
    for filename in ["decoder", "interlock", "display"]:
        (project / filename).write_text("fault\n")
    log = project / ".supercritical/work.json"
    work_log = {
        "changes": {"CR-1": {"summary": "Change the fault encoding",
                             "tasks": ["decode", "latch"], "merged_revision": None}},
        "problems": {},
    }
    save(log, work_log)
    plan_path = project / ".supercritical/plan.json"
    plan = {
        "version": 1, "target": "Host fixture", "intended_use": "Interlock",
        "approval_basis": "Fixture requirements",
        "files": ["decoder", "interlock", "display", ".supercritical/work.json"],
        "requirements": {
            "FAULT": {"source": "Fixture", "behavior": "Disagreement inhibits",
                      "implementation": ["decoder", "interlock"]},
            "DISPLAY": {"source": "Fixture", "behavior": "Show status",
                        "implementation": ["display"]},
        },
        "obligations": {
            "INTEGRATION": {"requirement": "FAULT", "method": "test",
                            "criterion": "Use the same fault encoding", "independent": True},
            "DISPLAY-TEST": {"requirement": "DISPLAY", "method": "target_validation",
                             "criterion": "Observe the display", "independent": True},
        },
        "decisions": {},
        "work": {
            "interfaces": {"FAULT-INPUT": {"files": ["decoder", "interlock"], "obligations": ["INTEGRATION"]}},
            "tasks": {
                "decode": {"writes": ["decoder"]},
                "latch": {"writes": ["interlock"]},
                "screen": {"writes": ["display"], "claims": ["DISPLAY-TEST"]},
            },
            "log": ".supercritical/work.json",
        },
        "forge": {"system": "gitlab", "url_prefix": "https://forge.example/fixture/work/"},
    }
    save(plan_path, plan)
    assert run(cli, "schedule", project)["waves"] == [["decode", "screen"], ["latch"]]
    plan["work"]["tasks"]["decode"]["depends_on"] = ["latch"]
    plan["work"]["tasks"]["latch"]["depends_on"] = ["decode"]
    save(plan_path, plan)
    run(cli, "check", project, status=1)
    del plan["work"]["tasks"]["decode"]["depends_on"]
    del plan["work"]["tasks"]["latch"]["depends_on"]
    save(plan_path, plan)
    baseline = directory / "baseline.json"
    save(baseline, run(cli, "check", project)["candidate"])
    def git(*args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
             "-c", "commit.gpgsign=false", *args], cwd=project, text=True
        ).strip()

    git("init", "-b", "integration")
    git("add", ".")
    git("commit", "-m", "Interlock baseline")
    git("switch", "-c", "decoder-change")
    (project / "decoder").write_text("fault-low\n")
    git("commit", "-am", "Change decoder encoding")
    git("switch", "integration")
    git("switch", "-c", "latch-change")
    (project / "interlock").write_text("fault-high\n")
    git("commit", "-am", "Change latch encoding")
    git("switch", "integration")
    git("merge", "--no-edit", "decoder-change", "latch-change")
    impact = run(cli, "impact", project, baseline)
    assert impact["changed_files"] == ["decoder", "interlock"]
    assert impact["affected_interfaces"] == ["FAULT-INPUT"]
    assert impact["replay_obligations"] == ["INTEGRATION"]
    assert impact["release_recheck_obligations"] == ["DISPLAY-TEST", "INTEGRATION"]
    runner = directory / "runner"
    runner.write_text('#!/bin/sh\n[ "$1" = INTEGRATION ] || exit 2\ncmp decoder interlock\n')
    runner.chmod(0o755)
    result = run(cli, "replay", project, baseline, runner, status=1)
    assert result["run"]["results"]["INTEGRATION"]["exit_code"] == 1
    assert run(cli, "replay", project, baseline, runner, status=1) == result
    record = project / ".supercritical/replays" / result["record_sha256"]
    assert record.is_file()

    work_log["changes"]["CR-1"]["merged_revision"] = git("rev-parse", "HEAD")
    work_log["problems"]["PR-1"] = {"summary": "Encoding mismatch", "owner": "integration",
                                    "obligations": ["INTEGRATION"], "resolution": None}
    save(log, work_log)
    save(trusted / "trust.json", {
        "version": 2, "approved_plan": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        "producers": {}, "reviewers": [], "decision_owners": [], "release_authorities": [],
        "decisions": {}, "acceptances": {}, "release": None,
    })
    dossier = run(cli, "dossier", project, trusted, status=1)
    assert "PR-1: open problem assigned to integration" in dossier["decision"]["blockers"]
    assert "PR-1: raise a tracked issue for this problem" in dossier["decision"]["blockers"]
    requested = run(cli, "requests", project, trusted)
    problem, = [item for item in requested if item["stage"] == "problem"]
    assert (problem["id"], problem["kind"], problem["approver"]) == ("problem/PR-1", "issue", "integration")
    assert dossier["work_log"]["problems"]["PR-1"]["summary"] == "Encoding mismatch"
    assert run(cli, "dossier", project, trusted, status=1) == dossier
    # Work log edits are tracked. Use the current candidate as the baseline for
    # the fix to isolate the integration replay from the earlier log change.
    save(baseline, dossier["candidate"])
    (project / "interlock").write_text("fault-low\n")
    assert run(cli, "replay", project, baseline, runner)["run"]["results"]["INTEGRATION"]["passed"]
    work_log["problems"]["PR-1"]["resolution"] = "Encoding aligned in the integration fix"
    work_log["problems"]["PR-1"]["issue"] = "https://forge.example/fixture/work/-/issues/7"
    save(log, work_log)
    repaired = run(cli, "dossier", project, trusted, status=1)
    assert repaired["work_log"]["problems"]["PR-1"]["resolution"]
    assert not any(s.startswith("PR-1:") for s in repaired["decision"]["blockers"])
    assert not any(item["stage"] == "problem" for item in run(cli, "requests", project, trusted))
    assert "INTEGRATION: reviewed evidence is missing" in repaired["decision"]["blockers"]


with tempfile.TemporaryDirectory(prefix="supercritical-work-") as directory:
    exercise(Path(sys.argv[1]).resolve(), Path(directory))
    print("Work walkthrough passed: semantic waves, merge replay, tracked problem issue and review gate")
