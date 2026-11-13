#!/usr/bin/env python3
"""Reject missing integration binaries, failures and skipped/filtered cases."""
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text()
expected = {"atomicity_sbf": 6, "client_bridge": 26, "refund_sbf": 5, "settlement_sbf": 11, "smoke": 1}
for name, minimum in expected.items():
    section = re.search(r"Running tests/" + name + r"\.rs.*?(?=\n\s*Running |\n\s*Doc-tests|\Z)", text, re.S)
    if not section:
        raise SystemExit("Missing runtime suite: " + name)
    result = re.search(r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out", section[0])
    if not result or int(result[1]) < minimum or any(int(result[n]) for n in range(2, 6)):
        raise SystemExit("Failed, omitted or skipped runtime cases: " + name)
print("All runtime suites executed without failures, ignored or filtered tests (minimum 49).")
