"""Exercise the CLI with an actual build and synthetic producer/approver roles."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def run(*args, status=0):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    assert result.returncode == status, (args, result.stdout, result.stderr)
    return result.stdout


def exercise(binary, workspace):
    project = workspace / "project"
    protected = workspace / "protected"
    project.mkdir()
    protected.mkdir()
    (protected / "records").mkdir()
    run(binary, "init", project)
    run(binary, "init", project, status=2)
    run(binary, "check", project, status=1)

    source = project / "interlock.rs"
    shutil.copyfile(Path(__file__).resolve().parents[1] / "examples/interlock.rs", source)
    executable = project / "interlock"
    run("rustc", source, "-o", executable)
    plan = project / ".supercritical/plan.json"
    write(plan, {
        "version": 1,
        "intended_use": "Demonstrate an inhibit latch reset on a synthetic host fixture",
        "approval_basis": "Synthetic interlock fixture acceptance criteria",
        "target": "Local host process",
        "files": ["interlock.rs", "interlock"],
        "requirements": {"REQ-RESET": {
            "source": "Fixture reset requirement",
            "behavior": "Reset clears the inhibit only when the sampled fault is clear",
            "implementation": ["interlock.rs"],
        }},
        "obligations": {
            "CHECK-EXHAUSTIVE": {
                "requirement": "REQ-RESET", "method": "proof",
                "criterion": "Check all eight input tuples against the transition table",
                "independent": True,
            },
            "CHECK-SCENARIO": {
                "requirement": "REQ-RESET", "method": "target_validation",
                "criterion": "Observe inhibited then enabled on the synthetic executable",
                "independent": True,
            },
        },
        "decisions": {"SIGNAL-LOSS": {
            "question": "Can silence be distinguished from a cleared fault?",
            "consequence": "Silent fault could be mistaken for clearance",
            "evidence_needed": "Interface input encoding",
            "owner": "fixture-owner",
            "affected_requirements": ["REQ-RESET"],
        }},
    })
    checked = json.loads(run(binary, "check", project))
    previous = workspace / "candidate.json"
    write(previous, checked["candidate"])
    trust_path = protected / "trust.json"
    trust = {
        "version": 1, "approved_plan": digest(plan),
        "producers": {"fixture-runner": ["proof", "target_validation"]},
        "reviewers": ["fixture-reviewer", "fixture-author"],
        "decision_owners": ["fixture-owner"], "release_authorities": ["fixture-release"],
        "decisions": {}, "acceptances": {}, "release": None,
    }
    write(trust_path, trust)

    def verdict(status, command="gate"):
        code = int(status == "blocked" or (command == "release" and status != "authorized"))
        result = json.loads(run(binary, command, project, protected, status=code))
        decision = result.get("decision", result)
        assert decision["status"] == status, decision
        return result

    assert "SIGNAL-LOSS" in verdict("blocked")["pending_decisions"]
    trust["decisions"]["SIGNAL-LOSS"] = {
        "owner": "fixture-owner",
        "resolution": "Only injected Boolean samples exist in this fixture",
        "source": "Fixture executable interface",
    }

    def submit(obligation, mode, method):
        raw = project / f"{mode}.txt"
        raw.write_text(run(executable, mode))
        record = workspace / f"{mode}.json"
        write(record, {
            "obligation": obligation, "candidate_sha256": checked["candidate_sha256"],
            "method": method, "producer": "fixture-runner", "authors": ["fixture-author"],
            "outcome": "pass", "raw_path": raw.name, "raw_sha256": digest(raw),
            "observed": "Captured executable stdout",
            "limitations": "Synthetic fixture on the local host",
        })
        submitted = json.loads(run(binary, "import", project, record))
        assert json.loads(run(binary, "import", project, record)) == submitted
        shutil.copyfile(raw, protected / raw.name)
        shutil.copyfile(submitted["path"], protected / "records" / f"{submitted['record_sha256']}.json")
        trust["acceptances"][obligation] = {
            "reviewer": "fixture-reviewer", "record_sha256": submitted["record_sha256"],
        }

    submit("CHECK-EXHAUSTIVE", "exhaustive", "proof")
    write(trust_path, trust)
    assert verdict("blocked")["blockers"] == ["CHECK-SCENARIO: reviewed evidence is missing"]
    submit("CHECK-SCENARIO", "scenario", "target_validation")
    trust["acceptances"]["CHECK-EXHAUSTIVE"]["reviewer"] = "fixture-author"
    write(trust_path, trust)
    assert "independent review" in verdict("blocked")["blockers"][0]
    trust["acceptances"]["CHECK-EXHAUSTIVE"]["reviewer"] = "fixture-reviewer"
    write(trust_path, trust)
    submission = verdict("ready_for_release_review", "release")["submission_sha256"]
    trust["release"] = {"authority": "fixture-release", "submission_sha256": submission}
    write(trust_path, trust)
    assert verdict("authorized", "release")["manifest"] == checked["candidate"]
    raw = protected / "scenario.txt"
    observation = raw.read_bytes()
    raw.write_text("Substituted observation")
    assert "raw evidence digest" in verdict("blocked")["blockers"][0]
    raw.write_bytes(observation)

    source.write_text(source.read_text().replace(
        "fault || (inhibited && !reset)", "(fault || inhibited) && !reset"
    ))
    run("rustc", source, "-o", executable)
    run(executable, "scenario", status=101)
    run(executable, "exhaustive", status=101)
    impacted = json.loads(run(binary, "impact", project, previous))
    assert impacted["replay_obligations"] == ["CHECK-EXHAUSTIVE", "CHECK-SCENARIO"]
    assert all("scope" in item for item in verdict("blocked")["blockers"])
    print("Interlock walkthrough passed: missing evidence, self-review, authorization, tampering and mutation")


with tempfile.TemporaryDirectory(prefix="supercritical-") as temporary:
    exercise(Path(sys.argv[1]).resolve(), Path(temporary))
