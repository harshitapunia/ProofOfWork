#!/usr/bin/env python3
"""Install reviewed Linux x86_64 archives without executing installers."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import tarfile
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
pins = json.loads((ROOT / ".github/ci-tools.json").read_text())
parser = argparse.ArgumentParser()
parser.add_argument("tools", nargs="+", choices=pins)
parser.add_argument("--directory", required=True, type=pathlib.Path)
args = parser.parse_args()
if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("Reviewed archives require Linux x86_64")
args.directory.mkdir(parents=True, exist_ok=True)
for name in args.tools:
    pin = pins[name]
    archive = args.directory / (name + ".archive")
    # Resume transient CDN failures; the completed archive must still match the pin.
    valid = False
    if archive.is_file():
        with archive.open("rb") as source:
            valid = hashlib.file_digest(source, "sha256").hexdigest() == pin["sha256"]
    if not valid:
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                        "--retry", "3", "--retry-all-errors", "--retry-delay", "2",
                        "--connect-timeout", "20", "--max-time", "1800",
                        "--continue-at", "-", "--output", str(archive), pin["url"]], check=True)
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != pin["sha256"]:
        raise SystemExit("Tool archive integrity mismatch: " + name)
    destination = args.directory / name
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as package:
        package.extractall(destination, filter="data")
    if not (destination / pin["executable"]).is_file():
        raise SystemExit("Expected executable absent: " + name)
    print(name + " verified sha256:" + digest, flush=True)
    # SBF Rust is selected only inside build-sbf.py, never globally.
    if name != "platform-tools" and os.environ.get("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a", encoding="utf8") as output:
            output.write(str((destination / pin["path"]).resolve()) + "\n")
