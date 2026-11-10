# ProofOfWork LiteSVM runtime handoff

This is a standalone Rust workspace with its own lockfile. It tests a separately
supplied SBF ELF, without linking the native handler, rebuilding the contract, or
changing the production workspace, dependencies or ABI.

## Validation status

Historical results from the separate combined integration candidate:

- All eight instructions compiled into one SBPF v3 ELF.
- 94 combined native Rust tests and three generated-IDL checks passed.
- The `create_internship` LiteSVM smoke test passed: 6,093 CUs, a 5,000-lamport
  fee, and successful state/rent assertions.
- One settlement and two refund positive-path tests compiled successfully.
  **The financial tests have NOT been executed.**

The portable artifact-path change in this handoff is compile-checked only; tests
are not rerun for publication. Rollback tests are not implemented. Financial
execution, failed-transaction atomicity, prefunded CompletionRecord coverage and
cryptographic signature authentication remain unverified.

## Required combined program

Main does not yet contain both financial instructions. This harness depends on
[PR #24](https://github.com/harshitapunia/ProofOfWork/pull/24) and
[PR #25](https://github.com/harshitapunia/ProofOfWork/pull/25), without merging or
changing either PR. The reviewed ELF combines these exact sources:

| Source | Commit |
| --- | --- |
| Main baseline | `ea3158b815d6b426439284694b2de83e54a95c0e` |
| Settlement / PR #24 | `0cb428fa617726450ae85b310b62063a1e672218` |
| Refund / PR #25 | `6029f63662a553254f9c8fff4cfbd61c25dde97a` |

No ELF is included in this PR. At execution time, provide its location:

```sh
export PROOFWORK_SBF_PATH="/path/to/reviewed/combined/proof_of_work.so"
```

Every test verifies this SHA-256 before constructing LiteSVM:

```text
86b4b44a3befa9fb736c81a90ee780829f1fdbd17f3f6fb4cc1c693755b23dfe
```

Program ID: `J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ`.
The recorded artifact is ELF64 / EM_BPF with flags `0x3`, built for
`sbpfv3-solana-solana` using platform-tools v1.57, bundled Rust
`1.95.0-dev (ae660768a 2026-08-17)`, LLVM 22.1.2 and `--locked --offline`.
A main-only ELF is not sufficient for the financial tests.

### Disposable combined source candidate

The following creates six uncommitted changes in a separate detached worktree.
It copies the two reviewed handlers and their native tests, then combines only
additive entry-point/module wiring. It does not merge PRs or create commits.
Review the resulting diff, verify eight instructions and unchanged shared layouts,
seeds/errors/identity/verification, then rerun the combined native and ABI checks.

```sh
POW_BASE=ea3158b815d6b426439284694b2de83e54a95c0e
POW_SETTLEMENT=0cb428fa617726450ae85b310b62063a1e672218
POW_REFUND=6029f63662a553254f9c8fff4cfbd61c25dde97a
git fetch origin "$POW_BASE" "$POW_SETTLEMENT" "$POW_REFUND"
POW_PROGRAM_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/proofwork-runtime-program.XXXXXX")
git worktree add --detach "$POW_PROGRAM_ROOT" "$POW_BASE"
python3 - "$POW_PROGRAM_ROOT" "$POW_BASE" "$POW_SETTLEMENT" "$POW_REFUND" <<'PY'
import difflib
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
base, settlement, refund = sys.argv[2:]

def read(ref, name):
    return subprocess.check_output(["git", "show", f"{ref}:{name}"], cwd=root)

for ref, name in [
    (settlement, "programs/proof_of_work/src/instructions/finance/settle_milestone.rs"),
    (settlement, "programs/proof_of_work/tests/settlement_native.rs"),
    (refund, "programs/proof_of_work/src/instructions/finance/refund_unclaimed_milestone.rs"),
    (refund, "programs/proof_of_work/tests/refund_native.rs"),
]:
    (root / name).write_bytes(read(ref, name))

for name in ["programs/proof_of_work/src/lib.rs",
             "programs/proof_of_work/src/instructions/finance/mod.rs"]:
    original = read(base, name).decode().splitlines(keepends=True)
    inserts = {}
    for ref in [settlement, refund]:
        reviewed = read(ref, name).decode().splitlines(keepends=True)
        for op, a, b, c, d in difflib.SequenceMatcher(
                None, original, reviewed, autojunk=False).get_opcodes():
            if op == "equal":
                continue
            if op != "insert":
                raise SystemExit(f"Stop: {ref}:{name} is no longer additive")
            inserts.setdefault(a, []).extend(reviewed[c:d])
    combined = []
    for i in range(len(original) + 1):
        combined.extend(inserts.get(i, []))
        if i < len(original):
            combined.append(original[i])
    (root / name).write_text("".join(combined))

entry = (root / "programs/proof_of_work/src/lib.rs").read_text()
assert len(re.findall(r"    pub fn \w+\(", entry)) == 8
PY
git -C "$POW_PROGRAM_ROOT" diff --check
git -C "$POW_PROGRAM_ROOT" status --short
```

Do not resolve integration issues by changing shared contract definitions or the
unresolved sponsor ATA policy. Keep this source candidate separate from the
runtime-only PR branch.

### Keyless SBF build

Obtain the host-appropriate official [Anza platform-tools v1.57 bundle](https://github.com/anza-xyz/platform-tools/releases/tag/v1.57)
and verify its published digest before extracting into disposable storage. The
reviewed Apple Silicon archive SHA-256 was
`48c32c2ec3ac3729b5caf1fdd6c4145496125edf043b2662b0586bfbc932b34a`.
Set `POW_PLATFORM_TOOLS` to its extracted directory. Do not source installer scripts,
change global rustup configuration, or invoke `anchor build`/`cargo-build-sbf`:
the inspected wrapper may generate a program keypair during postprocessing.

The reviewed direct compiler route is:

```sh
mkdir -p "$POW_PROGRAM_ROOT/target/keyless-sbf/cargo-home" \
  "$POW_PROGRAM_ROOT/target/keyless-sbf/tmp"
(
  cd "$POW_PROGRAM_ROOT/programs/proof_of_work"
  unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
  export CARGO_HOME="$POW_PROGRAM_ROOT/target/keyless-sbf/cargo-home"
  export CARGO_TARGET_DIR="$POW_PROGRAM_ROOT/target/keyless-sbf/target"
  export TMPDIR="$POW_PROGRAM_ROOT/target/keyless-sbf/tmp"
  export PATH="$POW_PLATFORM_TOOLS/rust/bin:$POW_PLATFORM_TOOLS/llvm/bin:$PATH"
  export RUSTC="$POW_PLATFORM_TOOLS/rust/bin/rustc"
  export RUSTDOC="$POW_PLATFORM_TOOLS/rust/bin/rustdoc"
  export CC="$POW_PLATFORM_TOOLS/llvm/bin/clang"
  export AR="$POW_PLATFORM_TOOLS/llvm/bin/llvm-ar"
  export OBJDUMP="$POW_PLATFORM_TOOLS/llvm/bin/llvm-objdump"
  export OBJCOPY="$POW_PLATFORM_TOOLS/llvm/bin/llvm-objcopy"
  export CARGO_TARGET_SBPFV3_SOLANA_SOLANA_RUSTFLAGS='-Zremap-cwd-prefix='
  # Omit this fetch if the isolated production dependency cache is already populated.
  "$POW_PLATFORM_TOOLS/rust/bin/cargo" fetch --locked --target sbpfv3-solana-solana
  "$POW_PLATFORM_TOOLS/rust/bin/cargo" build --lib --release \
    --target sbpfv3-solana-solana --locked --offline
)
export PROOFWORK_SBF_PATH="$POW_PROGRAM_ROOT/target/keyless-sbf/target/sbpfv3-solana-solana/release/proof_of_work.so"
```

Inspect ELF headers and SHA-256 before use. The expected hash records the reviewed
artifact; byte reproducibility across different hosts/build paths is not established.
If it differs, stop and review build/provenance differences with the team rather
than silently weakening or replacing the hash check.

## Host setup and compilation

The tested host is Rust/Cargo 1.99.1; LiteSVM's declared minimum is 1.97.1.
Do not use bundled SBF Rust 1.95 to build this host crate. A native C/assembly
toolchain is required. LiteSVM 0.18.2 has default features disabled; all versions
are locked in this standalone crate. Compilation executes dependency build scripts
and procedural macros, but not test binaries or LiteSVM constructors.

From the repository root, use disposable host paths:

```sh
POW_REPO=$(git rev-parse --show-toplevel)
export NO_DNA=1
export CARGO_HOME="$POW_REPO/target/runtime-env/cargo-home"
export CARGO_TARGET_DIR="$POW_REPO/target/runtime-env/target"
export TMPDIR="$POW_REPO/target/runtime-env/tmp"
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
mkdir -p "$CARGO_HOME" "$TMPDIR"
# One-time fetch, or seed this directory from an already verified local cache.
cargo fetch --manifest-path tests/runtime/Cargo.toml --locked \
  --target "$(rustc -vV | sed -n 's/^host: //p')"
cargo fmt --manifest-path tests/runtime/Cargo.toml --check
cargo test --manifest-path tests/runtime/Cargo.toml --locked --offline --no-run
```

Dependencies come from `index.crates.io` and `static.crates.io`, with no Git
sources. Never regenerate either lockfile to bypass an unexplained error.
Compilation does not require `PROOFWORK_SBF_PATH`; execution does.

## Runtime profile and fixture limits

The helpers use LiteSVM's pinned offline mainnet-feature snapshot and explicitly
disable `replace_spl_token_with_p_token` before loading programs. Blockhash,
history/replay, privilege, rent and CPI checks remain enabled. This is an Agave
4.3 profile, not an RPC connection or proof of parity with Solana 4.1.2/Devnet.
SDK crate versions are independently numbered; no Anchor host types are linked.

Financial fixtures verify these bundled executable bytes when run:

| Program | Version | SHA-256 |
| --- | --- | --- |
| Classic SPL Token | 3.5.0 | `7b44674b9704fa7640fbebfac68389f338b500b8c2bc29175c27ed66838b5a3c` |
| Associated Token Account | 1.1.1 | `6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d` |

They are packaged in LiteSVM 0.18.2 (archive checksum
`22637a0a14832bbb20d7c397dfe2af3b5470a475b0645c0898a267ebfc706318`).
The Token fixture differs from the native SPL Token 9.0.0 processor. Versioned
source supports the required checked transfers and closure; financial CPI execution
has not yet been verified here.

Only public SOL balances, zeroed storage for the fixed DEMO mint, and Clock
values are injected. Real Token/ATA instructions initialize the mint, create ATAs
and mint supply. Real lifecycle instructions create all ProofOfWork state. Surplus
uses a token transfer. Snapshots are read-only isolation assertions, never restored
as a substitute for transaction rollback.

Both LiteSVM constructors generate an **internal ephemeral airdrop keypair in
memory**, even though the tests never call `airdrop`. Execution requires explicit
authorization for that behavior. No wallet files, external keypairs, private-key
exports, RPC endpoints or network transactions are required. Signature verification
is explicitly disabled. Placeholder signatures preserve required message privileges
and avoid history collisions; they do **not** prove cryptographic authentication.

## Execution and handoff to Harshita

These commands are for separately authorized continuation. They construct internal
ephemeral keys and execute local VM transactions; they are not run during publication.
Set `PROOFWORK_SBF_PATH` first, with the host environment above.

```sh
# Previously passed; portable path change compile-checked only.
cargo test --manifest-path tests/runtime/Cargo.toml --locked --offline \
  --test smoke -- --nocapture --test-threads=1
# Not yet executed: complete settlement lifecycle with surplus.
cargo test --manifest-path tests/runtime/Cargo.toml --locked --offline \
  --test settlement_sbf -- --nocapture --test-threads=1
# Not yet executed: Funded and Assigned refunds at the exact cutoff.
cargo test --manifest-path tests/runtime/Cargo.toml --locked --offline \
  --test refund_sbf -- --nocapture --test-threads=1
```

Harshita will continue financial execution, failed-transaction rollback/atomicity,
prefunded-completion coverage, and integration. Investigate failures without
weakening approved contract rules. Keep signature authentication coverage separate.
Do not merge the financial PRs merely to run this harness, and do not deploy or
broadcast network transactions as part of these local tests.
