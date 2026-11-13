#!/usr/bin/env python3
"""Fail closed on new npm findings and Rust vulnerabilities/maintenance notices."""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
REPORTS = ROOT / "target/ci-security"


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def check_expiry(entry, today):
    require(datetime.date.fromisoformat(entry["expires"]) >= today,
            "Expired security review: " + entry.get("package", "unknown"))


def npm_findings(report, lock):
    require(report.get("auditReportVersion") == 2 and "error" not in report,
            "npm audit did not produce a complete report")
    require(isinstance(report.get("vulnerabilities"), dict), "Missing npm vulnerability map")
    require(isinstance(report.get("metadata", {}).get("vulnerabilities", {}).get("total"), int),
            "Missing npm vulnerability totals")
    findings = []
    for name, value in report["vulnerabilities"].items():
        via = sorted(item if isinstance(item, str) else item["url"].rsplit("/", 1)[-1]
                     for item in value["via"])
        nodes = sorted(value["nodes"])
        require(nodes and all(node in lock["packages"] for node in nodes), "Unbound npm finding")
        versions = sorted({lock["packages"][node]["version"] for node in nodes})
        findings.append({"package": name, "versions": versions, "nodes": nodes,
                         "severity": value["severity"], "via": via})
    require(len(findings) == report["metadata"]["vulnerabilities"]["total"],
            "Inconsistent npm totals")
    return findings


def review_npm(findings, exceptions, today):
    for entry in exceptions:
        check_expiry(entry, today)
    for finding in findings:
        print("npm finding: " + json.dumps(finding, sort_keys=True), flush=True)
        match = next((entry for entry in exceptions if all(entry.get(k) == v for k, v in finding.items())), None)
        require(match is not None, "New or changed npm security finding: " + finding["package"])
        print("TEMPORARY ROOT EXCEPTION until " + match["expires"] + ": " + match["reason"], flush=True)


def review_rust(report, lockfile, exceptions, today):
    require(isinstance(report.get("database", {}).get("snapshot-commit") or report.get("database", {}).get("last-commit"), str),
            "Missing advisory database provenance")
    vulnerabilities = report.get("vulnerabilities", {})
    require(vulnerabilities.get("found") is False and vulnerabilities.get("count") == 0
            and vulnerabilities.get("list") == [], "Rust security vulnerability reported")
    require(isinstance(report.get("warnings"), dict), "Missing Rust warning map")
    for entry in exceptions:
        check_expiry(entry, today)
    for kind, warnings in report["warnings"].items():
        require(isinstance(warnings, list), "Malformed Rust warnings")
        for warning in warnings:
            finding = {"lockfile": lockfile, "package": warning["package"]["name"],
                       "version": warning["package"]["version"], "advisory": warning["advisory"]["id"]}
            print("Rust notice: " + json.dumps(finding, sort_keys=True), flush=True)
            match = next((entry for entry in exceptions if all(entry.get(k) == v for k, v in finding.items())), None)
            require(kind == "unmaintained" and match is not None, "New Rust warning requires review")
            print("Maintenance review expires " + match["expires"] + ": " + match["reason"], flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["node", "rust"])
    parser.add_argument("--audit", type=pathlib.Path)
    args = parser.parse_args()
    today = datetime.datetime.now(datetime.timezone.utc).date()
    policy = json.loads((ROOT / ".github/security-policy.json").read_text())
    REPORTS.mkdir(parents=True, exist_ok=True)
    if args.mode == "node":
        for folder, label in [(".", "root"), ("packages/finance-client", "finance"),
                              ("services/verifier", "verifier"), ("tests/dependency-security", "compatibility")]:
            result = subprocess.run(["npm", "audit", "--json"], cwd=ROOT / folder,
                                    text=True, capture_output=True)
            require(result.returncode in (0, 1), "npm audit infrastructure failure: " + label)
            report = json.loads(result.stdout)
            (REPORTS / ("npm-" + label + ".json")).write_text(json.dumps(report, indent=2) + "\n")
            lock = json.loads((ROOT / folder / "package-lock.json").read_text())
            findings = npm_findings(report, lock)
            review_npm(findings, policy["root_npm_exceptions"] if folder == "." else [], today)
            print(label + ": " + str(len(findings)) + " visible findings", flush=True)
    else:
        require(args.audit and args.audit.is_file(), "Pinned cargo-audit binary required")
        version = subprocess.check_output([str(args.audit), "--version"], text=True).strip()
        require(version == "cargo-audit 0.23.0", "Unexpected cargo-audit version: " + version)
        # Use the system Git transport and a fresh snapshot, then scan it without
        # an implicit second fetch. Record the exact live advisory DB revision.
        database = pathlib.Path(tempfile.mkdtemp(prefix="rustsec-", dir=REPORTS)) / "advisory-db"
        subprocess.run(["git", "clone", "--depth", "1", "https://github.com/RustSec/advisory-db.git",
                        str(database)], check=True, timeout=180)
        revision = subprocess.check_output(["git", "-C", str(database), "rev-parse", "HEAD"], text=True).strip()
        print("Fetched RustSec revision: " + revision, flush=True)
        for lockfile, label in [("Cargo.lock", "program"), ("tests/runtime/Cargo.lock", "runtime")]:
            result = subprocess.run([str(args.audit), "audit", "--file", lockfile, "--json",
                                     "--no-fetch", "--db", str(database)], cwd=ROOT, text=True, capture_output=True)
            require(result.returncode in (0, 1), "cargo-audit infrastructure failure: " + result.stderr)
            require(bool(result.stdout.strip()), "cargo-audit produced no JSON: " + result.stderr)
            report = json.loads(result.stdout)
            (REPORTS / ("rust-" + label + ".json")).write_text(json.dumps(report, indent=2) + "\n")
            require(isinstance(report.get("database", {}).get("advisory-count"), int)
                    and report["database"]["advisory-count"] > 0, "Empty advisory database")
            # cargo-audit leaves fetch metadata null under --no-fetch. Retain
            # the independent Git revision actually fetched above, not invented metadata.
            report["database"]["snapshot-commit"] = revision
            (REPORTS / ("rust-" + label + ".json")).write_text(json.dumps(report, indent=2) + "\n")
            print("RustSec database: " + json.dumps(report.get("database")), flush=True)
            review_rust(report, lockfile, policy["rust_maintenance"], today)
        print("Both Rust lockfiles have no reported vulnerabilities; maintenance notices remain visible.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, TypeError) as error:
        sys.exit("Security gate failed: " + str(error))
