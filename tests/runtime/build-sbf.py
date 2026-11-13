#!/usr/bin/env python3
"""Direct keyless build. Never invokes Anchor or cargo-build-sbf."""
import argparse, hashlib, json, os, pathlib, struct, subprocess
def require(condition, message):
    if not condition:
        raise RuntimeError(message)

root = pathlib.Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument("--platform-tools", required=True, type=pathlib.Path)
p.add_argument("--offline", action="store_true")
a = p.parse_args()
tools = a.platform_tools.resolve()
# Inspect the configured host before the SBF compiler takes precedence on PATH.
host_environment = os.environ.copy()
host_rust = subprocess.check_output(
    ["rustc", "--version"], env=host_environment, text=True
).strip()
host_cargo = subprocess.check_output(
    ["cargo", "--version"], env=host_environment, text=True
).strip()
out = root / "target/keyless-sbf"
out.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
for key in list(env):
    if key.startswith(("RUST", "CARGO_TARGET_")) or key in ("CARGO_ENCODED_RUSTFLAGS",):
        env.pop(key, None)
env.update(CARGO_TARGET_DIR=str(out), CARGO_TARGET_SBPFV3_SOLANA_SOLANA_RUSTFLAGS="-Zremap-cwd-prefix=")
env["PATH"] = str(tools/"rust/bin") + os.pathsep + str(tools/"llvm/bin") + os.pathsep + env["PATH"]
for key, rel in {"RUSTC":"rust/bin/rustc","RUSTDOC":"rust/bin/rustdoc","CC":"llvm/bin/clang",
                 "AR":"llvm/bin/llvm-ar","OBJDUMP":"llvm/bin/llvm-objdump","OBJCOPY":"llvm/bin/llvm-objcopy"}.items():
    env[key] = str(tools/rel)
def version(argv):
    return subprocess.check_output(argv, env=env, text=True).strip()
versions = {"host_rust":host_rust,
            "host_cargo":host_cargo,
            "solana":version(["solana","--version"]),
            "sbf_rust":version([env["RUSTC"],"--version"]),
            "llvm":version([str(tools/"llvm/bin/clang"),"--version"])}
require(versions["host_rust"].startswith("rustc 1.98.1 "), "host Rust must be 1.98.1")
require(versions["host_cargo"].startswith("cargo 1.98.1 "), "host Cargo must be 1.98.1")
require(versions["solana"].startswith("solana-cli 4.1.2 "), "Solana CLI must be 4.1.2")
require(versions["sbf_rust"].startswith("rustc 1.95.0-dev "), "unexpected SBF Rust version")
require("22.1.2" in versions["llvm"], "unexpected SBF LLVM version")
argv = [str(tools/"rust/bin/cargo"),"build","--lib","--release","--target","sbpfv3-solana-solana","--locked"]
if a.offline:
    argv.append("--offline")
sources = [root/"Cargo.toml", root/"Cargo.lock"]
sources += sorted((root/"programs/proof_of_work").rglob("*.rs"))
sources += [root/"programs/proof_of_work/Cargo.toml"]
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
before = {str(f.relative_to(root)):digest(f) for f in sources}
subprocess.run(argv, cwd=root/"programs/proof_of_work", env=env, check=True)
require(before == {str(f.relative_to(root)):digest(f) for f in sources}, "build changed inputs")
elf = out/"sbpfv3-solana-solana/release/proof_of_work.so"
data = elf.read_bytes()
require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "expected ELF64 little endian")
machine = struct.unpack_from("<H",data,18)[0]
flags = struct.unpack_from("<I",data,48)[0]
require(machine == 247 and flags == 3, "expected EM_BPF with SBPF v3 flags")
record = {"sources":before,"runtime_lock_sha256":digest(root/"tests/runtime/Cargo.lock"),
          "versions":versions,"command":["$PLATFORM_TOOLS/rust/bin/cargo",*argv[1:]],
          "cwd":"programs/proof_of_work","target":"sbpfv3-solana-solana",
          "artifact":str(elf.relative_to(root)),"sha256":digest(elf),"bytes":len(data),
          "elf":{"class":"ELF64","endian":"little","machine":machine,"flags":flags}}
(out/"provenance.json").write_text(json.dumps(record,indent=2)+"\n")
expected = json.loads((root/"tests/runtime/artifact-provenance.json").read_text())
require(record["sha256"] == expected["sha256"], "artifact changed: review target/keyless-sbf/provenance.json before repinning")
require(record["runtime_lock_sha256"] == expected["runtime_lock_sha256"], "runtime lock mismatch")
for f,h in expected["sources"].items():
    require(before.get(f) == h, "source mismatch: "+f)
print(json.dumps(record,indent=2))
