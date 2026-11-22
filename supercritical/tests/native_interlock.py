"""Produce and ingest pinned native Kani, CBMC and libtest evidence."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def run(args, expected=0, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, timeout=120)
    if result.returncode != expected:
        raise RuntimeError(f"{args}: {result.returncode}\n{result.stdout!r}\n{result.stderr!r}")
    return result.stdout


def capture(root, path, status):
    return {"path": path.relative_to(root).as_posix(), "sha256": sha(path), "exit_code": status}


def replay(cli, safety, output, broken):
    project = output / "candidate"
    work = output / "work"
    trusted = output / "trusted"
    work.mkdir(parents=True)
    trusted.mkdir()
    shutil.copytree(Path(__file__).resolve().parents[1] / "examples/native-interlock", project)
    lib = project / "lib.rs"
    if broken:
        lib.write_text(lib.read_text().replace("fault || (inhibited && !reset)", "inhibited && !reset"))
    requirements = {}
    obligations = {}
    checks = {}
    cases = [
        ("REQ-KEEP", "Reset during an active sampled fault preserves inhibit", "tests::reset_during_fault_keeps_inhibit"),
        ("REQ-CLEAR", "Reset after sampled fault clearance removes inhibit", "tests::reset_after_clear_removes_inhibit"),
    ]
    for req, behavior, case in cases:
        requirements[req] = {"source": "Interlock reset example", "behavior": behavior, "implementation": ["lib.rs"]}
        for method in ["test", "proof"]:
            key = f"{req}-{method.upper()}"
            obligations[key] = {"requirement": req, "method": method, "criterion": behavior, "independent": True}
            checks[key] = {"type": "kani", "property": f"{req}@host"} if method == "proof" else {"type": "libtest", "test": case}
    obligations["OPERATOR"] = {
        "requirement": "REQ-KEEP", "method": "target_validation",
        "criterion": "Witness reset on representative equipment", "independent": True,
    }
    config = project / "safety.yaml"
    config.write_text("version: 1\nproject:\n  name: Supercritical native interlock\n")
    plan = project / ".supercritical/plan.json"
    save(plan, {
        "version": 1, "intended_use": "Interlock reset proof and host tests",
        "approval_basis": "Example interlock requirements", "target": "Reference host",
        "files": ["lib.rs", "safety.yaml", "rust-verification.json"],
        "decisions": {}, "requirements": requirements, "obligations": obligations, "rust_checks": checks,
        "objectives": {"RESET": {"description": "Verify and validate reset behavior", "obligations": sorted(obligations)}},
    })
    candidate = json.loads(run([cli, "check", project]))["candidate_sha256"]

    # Build and execute the same source with the pinned nightly and verifier.
    shutil.copyfile(lib, work / "lib.rs")
    compile_test = ["rustc", "--test", "lib.rs", "-o", "interlock-tests"]
    run(compile_test, cwd=work)
    test_command = ["./interlock-tests", "-Z", "unstable-options", "--format", "json"]
    test_code = 101 if broken else 0
    test_output = run(test_command, test_code, cwd=work)
    codegen = ["kani-driver", "--keep-temps", "--only-codegen", "lib.rs"]
    run(codegen, cwd=work)
    metadata = json.loads((work / "lib.kani-metadata.json").read_text())
    assert metadata["unsupported_features"] == []
    harness, = metadata["proof_harnesses"]
    inventory = json.loads((project / "rust-verification.json").read_text())["invocations"]["proof"]
    checker = inventory["command"]
    assert Path(harness["goto_file"]).name.replace(".symtab.out", ".out") == checker[1]
    assert harness["mangled_name"] == checker[3]
    tools = inventory["toolchain"]
    assert run(["rustc", "-vV"]).decode().strip() == tools["rustc"]
    assert run(["cargo", "-V"]).decode().strip() == tools["cargo"]
    assert tools["kani"] in run(["kani-driver", "--version"]).decode()
    assert run(["cbmc", "--version"]).decode().startswith(tools["cbmc"])
    output_bytes = run(checker, 10, cwd=work)

    inputs = json.loads(run([safety, "rust", "snapshot", "--path", project]))
    bundle = project / "bundle.json"
    save(bundle, {"version": 1, "producer": "native-interlock-fixture", "inputs": inputs, "invocations": {
        "proof": {"command": checker, "toolchain": tools, "exit_code": 10,
                  "output": output_bytes.decode(), "output_sha256": hashlib.sha256(output_bytes).hexdigest()},
    }})
    report_code = int(broken)
    imported = run([safety, "rust", "import", bundle.name, "--path", project], report_code)
    report = json.loads(imported)
    run_directory = project / ".safety/runs" / report["id"]
    report_path = run_directory / "run.json"
    report_path.write_bytes(imported)
    if broken:
        witnesses = json.loads((run_directory / "counterexamples.json").read_text())
        assert any(w["property_id"] == "REQ-KEEP@host" and w["steps"] for w in witnesses)
    artifacts = {p.relative_to(project).as_posix(): sha(p) for p in run_directory.rglob("*") if p.is_file()}
    artifacts[bundle.name] = sha(bundle)
    test_path = project / ".safety/libtest.jsonl"
    test_path.write_bytes(test_output)
    provenance = project / ".safety/commands.json"
    save(provenance, {
        "rustc": tools["rustc"], "source_sha256": sha(lib),
        "compile_test": compile_test, "test_command": test_command,
        "test_executable_sha256": sha(work / "interlock-tests"), "codegen": codegen,
    })
    receipt = project / ".safety/receipt.json"
    save(receipt, {
        "version": 1, "candidate_sha256": candidate, "producer": "native-interlock-fixture",
        "authors": ["fixture-author"], "libtest": capture(project, test_path, test_code),
        "artifacts": {provenance.relative_to(project).as_posix(): sha(provenance)},
        "toolkit": {"report": capture(project, report_path, report_code), "bundle_input": bundle.name, "artifacts": artifacts},
    })
    receipt_rel = receipt.relative_to(project).as_posix()
    staged = json.loads(run([cli, "ingest-rust", project, receipt_rel], int(broken)))["submissions"]
    assert staged["REQ-KEEP-PROOF"]["outcome"] == ("fail" if broken else "pass")
    assert staged["REQ-KEEP-TEST"]["outcome"] == ("fail" if broken else "pass")
    assert staged["REQ-CLEAR-PROOF"]["outcome"] == ("incomplete" if broken else "pass")

    trust = {
        "version": 1, "approved_plan": sha(plan),
        "producers": {"native-interlock-fixture": ["test", "proof"]},
        "reviewers": ["fixture-reviewer"], "decision_owners": [],
        "release_authorities": [], "decisions": {}, "acceptances": {}, "release": None,
    }
    for claim, item in staged.items():
        record = Path(item["path"])
        data = json.loads(record.read_text())
        for path in [data["raw_path"], *data["artifacts"]]:
            destination = trusted / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(project / path, destination)
        destination = trusted / "records" / record.name
        destination.parent.mkdir(exist_ok=True)
        shutil.copyfile(record, destination)
        trust["acceptances"][claim] = {"reviewer": "fixture-reviewer", "record_sha256": item["record_sha256"]}
    save(trusted / "trust.json", trust)
    result = run([cli, "dossier", project, trusted], 1)
    (output / "dossier.json").write_bytes(result)
    dossier = json.loads(result)
    assert dossier["decision"]["status"] == "blocked"
    assert dossier["evidence"]["OPERATOR"]["blocker"]
    proof = dossier["evidence"]["REQ-KEEP-PROOF"]
    assert proof["result"]["details"]["verifier_outcome"] == ("VIOLATED" if broken else "PROVEN")
    assert bool(proof["blocker"]) == broken
    assert dossier["trace"]["REQ-KEEP"] == ["OPERATOR", "REQ-KEEP-PROOF", "REQ-KEEP-TEST"]
    assert dossier["objectives"]["RESET"]["blockers"] == (
        ["OPERATOR", "REQ-CLEAR-PROOF", "REQ-CLEAR-TEST", "REQ-KEEP-PROOF", "REQ-KEEP-TEST"] if broken else ["OPERATOR"]
    )
    if not broken:
        raw_proof = next(path for path in proof["result"]["artifacts"] if path.endswith("/raw/rust-0.txt"))
        (trusted / raw_proof).write_text("changed")
        tampered = json.loads(run([cli, "dossier", project, trusted], 1))
        assert "digest differs" in tampered["evidence"]["REQ-KEEP-PROOF"]["blocker"]
        shutil.copyfile(project / raw_proof, trusted / raw_proof)
        lib.write_text(lib.read_text() + "\n")
        run([cli, "ingest-rust", project, receipt_rel], 2)
        lib.write_text(lib.read_text().removesuffix("\n"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("supercritical", type=Path)
    parser.add_argument("safety", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    for name, broken in [("reference", False), ("mutant", True)]:
        replay(args.supercritical.resolve(), args.safety.resolve(), args.output.resolve() / name, broken)
    print("Native interlock replay passed: proofs, tests, witnessed mutation, dossier, tampering and stale evidence")


if __name__ == "__main__":
    main()
