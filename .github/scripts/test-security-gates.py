#!/usr/bin/env python3
"""Regression tests for the security gate's refusal paths."""
import contextlib
import copy
import datetime
import importlib.util
import io
import pathlib
import unittest
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location("gates", pathlib.Path(__file__).with_name("security-gates.py"))
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)
TODAY = datetime.date(2026, 11, 14)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.finding = {"package": "fixture", "versions": ["1.0.0"], "nodes": ["node_modules/fixture"],
                        "severity": "high", "via": ["GHSA-fixture"]}
        self.entry = {**self.finding, "expires": "2026-12-14", "reason": "test fixture only"}

    def review(self, finding, entries):
        with contextlib.redirect_stdout(io.StringIO()):
            gates.review_npm(finding, entries, TODAY)

    def test_clean_target_passes(self):
        self.review([], [])

    def test_exact_visible_exception_passes(self):
        self.review([self.finding], [self.entry])

    def test_new_finding_fails(self):
        with self.assertRaises(RuntimeError):
            self.review([self.finding], [])

    def test_advisory_version_severity_or_path_change_fails(self):
        for field, value in [("via", ["GHSA-new"]), ("versions", ["1.0.1"]),
                             ("severity", "critical"), ("nodes", ["node_modules/other"])]:
            with self.subTest(field=field):
                changed = {**self.finding, field: value}
                with self.assertRaises(RuntimeError):
                    self.review([changed], [self.entry])

    def test_expired_exception_fails_even_if_no_longer_used(self):
        with self.assertRaises(RuntimeError):
            self.review([], [{**self.entry, "expires": "2026-11-13"}])

    def test_incomplete_npm_reports_fail(self):
        for report in [{}, {"error": {"code": "network"}}, {"auditReportVersion": 2, "vulnerabilities": {}}]:
            with self.assertRaises(RuntimeError):
                gates.npm_findings(report, {"packages": {}})

    def test_inconsistent_or_unbound_npm_results_fail(self):
        report = {"auditReportVersion": 2, "metadata": {"vulnerabilities": {"total": 1}}, "vulnerabilities": {}}
        with self.assertRaises(RuntimeError):
            gates.npm_findings(report, {"packages": {}})
        report["vulnerabilities"]["fixture"] = {"severity": "high", "via": [], "nodes": ["node_modules/fixture"]}
        with self.assertRaises(RuntimeError):
            gates.npm_findings(report, {"packages": {}})

    def test_any_rust_vulnerability_fails(self):
        with self.assertRaises(RuntimeError):
            gates.review_rust({"database": {"last-commit": "fixture"},
                               "vulnerabilities": {"found": True, "count": 1, "list": [{}]},
                               "warnings": {}}, "Cargo.lock", [], TODAY)

    def test_rust_notice_requires_exact_lock_package_version_and_advisory(self):
        report = {"database": {"last-commit": "fixture"},
                  "vulnerabilities": {"found": False, "count": 0, "list": []},
                  "warnings": {"unmaintained": [{"package": {"name": "fixture", "version": "1.0.0"},
                                                 "advisory": {"id": "RUSTSEC-fixture"}}]}}
        entry = {"lockfile": "Cargo.lock", "package": "fixture", "version": "1.0.0",
                 "advisory": "RUSTSEC-fixture", "expires": "2027-02-14", "reason": "fixture"}
        with contextlib.redirect_stdout(io.StringIO()):
            gates.review_rust(report, "Cargo.lock", [entry], TODAY)
            for key in ["lockfile", "package", "version", "advisory"]:
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    gates.review_rust(report, "Cargo.lock", [{**entry, key: "other"}], TODAY)
            changed = copy.deepcopy(report)
            changed["warnings"]["unsound"] = changed["warnings"].pop("unmaintained")
            with self.assertRaises(RuntimeError):
                gates.review_rust(changed, "Cargo.lock", [entry], TODAY)

class RuntimeCoverageTests(unittest.TestCase):
    def log(self):
        return "".join("Running tests/" + name + ".rs (fixture)\n"
                       + "test result: ok. " + str(count)
                       + " passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
                       for name, count in [("atomicity_sbf", 6), ("client_bridge", 26),
                                           ("refund_sbf", 5), ("settlement_sbf", 11), ("smoke", 1)])

    def run_guard(self, text):
        with tempfile.TemporaryDirectory() as directory:
            log = pathlib.Path(directory) / "runtime.log"
            log.write_text(text)
            return subprocess.run(["python3", str(pathlib.Path(__file__).with_name("check-runtime-results.py")),
                                   str(log)], capture_output=True).returncode

    def test_all_runtime_suites_required(self):
        self.assertEqual(self.run_guard(self.log()), 0)
        self.assertNotEqual(self.run_guard(self.log().replace("Running tests/smoke.rs", "Running tests/missing.rs")), 0)

    def test_ignored_filtered_or_failed_cases_rejected(self):
        for old, new in [("0 ignored", "1 ignored"), ("0 filtered out", "1 filtered out"),
                         ("0 failed", "1 failed"), ("26 passed", "25 passed")]:
            with self.subTest(new=new):
                self.assertNotEqual(self.run_guard(self.log().replace(old, new, 1)), 0)


if __name__ == "__main__":
    unittest.main()
