mod support;
use serde_json::{json, Value};
use solana_address::Address;
use support::{finance::*, PROGRAM_ID};

use sha2::{Digest, Sha256};
use solana_instruction::{AccountMeta, Instruction};
use solana_transaction::Transaction;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

static EVIDENCE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn root() -> PathBuf {
    EVIDENCE_ROOT
        .get_or_init(|| {
            let path = std::env::var_os("PROOFWORK_BRIDGE_EVIDENCE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../target/client-bridge");
                    std::fs::create_dir_all(&base).unwrap();
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos();
                    let path = base.join(format!("direct-{}-{stamp}", std::process::id()));
                    std::fs::create_dir(&path).expect("fresh direct-run evidence directory");
                    path
                });
            std::fs::create_dir_all(path.join("logs/wires")).unwrap();
            path
        })
        .clone()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|n| u8::from_str_radix(&s[n..n + 2], 16).unwrap())
        .collect()
}
static BRIDGE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Worker {
    _guard: std::sync::MutexGuard<'static, ()>,
    previous: [(String, Option<std::ffi::OsString>); 6],
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Worker {
    fn new() -> Self {
        let guard = BRIDGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = [
            "SPONSOR", "STUDENT", "VERIFIER", "CALLER", "SENTINEL", "ACTIVE",
        ]
        .map(|r| {
            let key = if r == "ACTIVE" {
                "PROOFWORK_BRIDGE_ACTIVE".to_string()
            } else {
                format!("BRIDGE_{r}")
            };
            let value = std::env::var_os(&key);
            (key, value)
        });
        let mut child =
            Command::new(std::env::var_os("PROOFWORK_NODE").unwrap_or_else(|| "node".into()))
                .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("client/worker.mjs"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut w = Self {
            _guard: guard,
            previous,
            child,
            input,
            output,
        };
        std::env::set_var("PROOFWORK_BRIDGE_ACTIVE", "1");
        let v = w.call(json!({"op":"init"}));
        for role in ["sponsor", "student", "verifier", "caller", "sentinel"] {
            std::env::set_var(
                format!("BRIDGE_{}", role.to_uppercase()),
                v["pub"][role].as_str().unwrap(),
            );
        }
        w
    }
    fn call(&mut self, q: Value) -> Value {
        writeln!(self.input, "{}", q).unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "worker stopped"
        );
        serde_json::from_str(&line).unwrap()
    }
    fn prepare(&mut self, f: &Fixture, mut extra: Value) -> Value {
        let mut accounts = serde_json::Map::new();
        for owner in [TOKEN, PROGRAM_ID, solana_sdk_ids::system_program::ID] {
            for (key, a) in f.svm.get_program_accounts(&owner) {
                accounts.insert(key.to_string(),json!({"owner":a.owner.to_string(),"dataHex":hex(&a.data),"lamports":a.lamports,"executable":a.executable,"rentEpoch":a.rent_epoch}));
            }
        }
        extra["op"] = json!("prepare");
        extra["accounts"] = json!(accounts);
        extra["rent"] = json!(f.svm.minimum_balance_for_rent_exemption(165));
        extra["blockhash"] = json!(f.svm.latest_blockhash().to_string());
        self.call(extra)
    }
    fn fixture(&mut self, f: &Fixture, ixs: &[Instruction], payer: Address) -> Value {
        self.call(json!({"op":"fixture","payer":payer.to_string(),"blockhash":f.svm.latest_blockhash().to_string(),
   "instructions":ixs.iter().map(|i|json!({"programId":i.program_id.to_string(),"dataHex":hex(&i.data),
    "keys":i.accounts.iter().map(|k|json!({"pubkey":k.pubkey.to_string(),"isSigner":k.is_signer,"isWritable":k.is_writable})).collect::<Vec<_>>()})).collect::<Vec<_>>()}))
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}
fn signed(f: &mut Fixture) {
    f.svm = std::mem::take(&mut f.svm).with_sigverify(true);
    assert!(f.svm.get_sigverify());
}
fn decode(v: &Value) -> Transaction {
    assert_eq!(v["ok"], true, "client rejection: {v}");
    let wire = unhex(v["wireHex"].as_str().unwrap());
    assert_eq!(
        hex(&Sha256::digest(&wire)),
        v["wireSha256"].as_str().unwrap()
    );
    let evidence = root().join("logs/wires");
    std::fs::create_dir_all(&evidence).unwrap();
    std::fs::write(
        evidence.join(format!("{}.json", v["wireSha256"].as_str().unwrap())),
        serde_json::to_vec_pretty(v).unwrap(),
    )
    .unwrap();
    let tx: Transaction = bincode::deserialize(&wire).unwrap();
    assert_eq!(
        bincode::serialize(&tx).unwrap(),
        wire,
        "must execute exact TS wire bytes"
    );
    assert!(wire.len() <= 1232);
    tx
}
fn send(f: &mut Fixture, v: &Value, name: &str) -> litesvm::types::TransactionMetadata {
    std::fs::write(
        root().join("logs").join(format!("wire-{name}.json")),
        serde_json::to_vec_pretty(v).unwrap(),
    )
    .unwrap();
    let tx = decode(v);
    let meta = f
        .svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("{name}: {:?}\n{}", e.err, e.meta.pretty_logs()));
    record(
        name,
        json!({"result":"passed","wireSha256":v["wireSha256"],"size":v["size"],"accounts":v["accountCount"],
 "compute":meta.compute_units_consumed,"fee":meta.fee,"sigverify":f.svm.get_sigverify(),"logs":meta.logs}),
    );
    meta
}
fn reject(f: &mut Fixture, v: &Value, s: &Scope, d: Address, name: &str, signature: bool) {
    let before = f.settlement_snapshot(s, d);
    std::fs::write(
        root().join("logs").join(format!("wire-{name}.json")),
        serde_json::to_vec_pretty(v).unwrap(),
    )
    .unwrap();
    let tx = decode(v);
    let e = f.svm.send_transaction(tx).expect_err("must reject");
    if signature {
        assert!(
            format!("{:?}", e.err).contains("SignatureFailure"),
            "{:?}",
            e.err
        );
        assert_eq!(e.meta.compute_units_consumed, 0);
    }
    if !signature {
        assert!(
            e.meta.compute_units_consumed > 0,
            "expected instruction execution; actual error: {:?}",
            e.err
        );
        assert!(!format!("{:?}", e.err).contains("SignatureFailure"));
    }
    f.assert_rollback(&before, f.caller, e.meta.fee);
    record(
        name,
        json!({"result":"passed","expectedFailure":format!("{:?}",e.err),"fee":e.meta.fee,
 "compute":e.meta.compute_units_consumed,"sigverify":true,"logs":e.meta.logs}),
    );
}
fn record(name: &str, v: Value) {
    let path = root().join("logs").join(format!("case-{name}.json"));
    std::fs::write(path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
}
fn setup() -> (Worker, Fixture, Scope) {
    let w = Worker::new();
    let mut f = Fixture::new();
    let s = f.scope(1);
    let other = f.scope(2);
    f.create_and_fund(&s);
    f.create_and_fund(&other);
    f.assign(&s);
    f.submit_and_attest(&s);
    signed(&mut f);
    (w, f, s)
}
fn fallback(f: &Fixture) -> Address {
    let mut b = f.caller.as_ref().to_vec();
    b.extend_from_slice(b"bridge_1");
    b.extend_from_slice(TOKEN.as_ref());
    Address::new_from_array(Sha256::digest(b).into())
}
fn fixture_send(w: &mut Worker, f: &mut Fixture, ixs: &[Instruction], payer: Address, name: &str) {
    let v = w.fixture(f, ixs, payer);
    send(f, &v, name);
}
fn changed(w: &mut Worker, f: &mut Fixture) {
    let mut data = vec![6, 2, 1];
    data.extend_from_slice(f.sentinel.as_ref());
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(f.sponsor_ata, false),
            AccountMeta::new_readonly(f.sponsor, true),
        ],
        data,
    };
    fixture_send(w, f, &[ix], f.sponsor, "fixture-set-authority");
}
fn provision(w: &mut Worker, f: &mut Fixture, authority: Address) -> Address {
    let scope = f.scope(99);
    let (d, ixs) = f.provision_destination(&scope, authority);
    fixture_send(w, f, &ixs, f.caller, "fixture-noncanonical");
    d
}
fn missing(w: &mut Worker, f: &mut Fixture) {
    let owner = f.sponsor;
    let d = provision(w, f, owner);
    let amount = f.token_amount(f.sponsor_ata);
    let mut data = vec![12];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(DECIMALS);
    let transfer = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(f.sponsor_ata, false),
            AccountMeta::new_readonly(MINT, false),
            AccountMeta::new(d, false),
            AccountMeta::new_readonly(f.sponsor, true),
        ],
        data,
    };
    let close = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(f.sponsor_ata, false),
            AccountMeta::new(f.sponsor, false),
            AccountMeta::new_readonly(f.sponsor, true),
        ],
        data: vec![9],
    };
    fixture_send(
        w,
        f,
        &[transfer, close],
        f.sponsor,
        "fixture-close-canonical",
    );
    assert!(f.svm.get_account(&f.sponsor_ata).is_none());
}
fn donate(w: &mut Worker, f: &mut Fixture, s: &Scope) {
    let mut data = vec![12];
    data.extend_from_slice(&SURPLUS.to_le_bytes());
    data.push(DECIMALS);
    let ix = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(f.sponsor_ata, false),
            AccountMeta::new_readonly(MINT, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new_readonly(f.sponsor, true),
        ],
        data,
    };
    fixture_send(w, f, &[ix], f.sponsor, "fixture-surplus");
}
fn success(name: &str, surplus: bool, mode: &str) {
    let (mut w, mut f, s) = setup();
    if surplus {
        donate(&mut w, &mut f, &s);
    }
    if mode == "missing" {
        missing(&mut w, &mut f);
    } else if mode != "canonical" {
        changed(&mut w, &mut f);
    }
    let mut input = json!({});
    if mode == "existing" {
        let owner = f.sponsor;
        let d = provision(&mut w, &mut f, owner);
        input["sponsorDestination"] = json!(d.to_string());
    }
    if mode == "prefunded" || mode == "overfunded" {
        let d = fallback(&f);
        let amount = if mode == "prefunded" {
            f.svm.minimum_balance_for_rent_exemption(0)
        } else {
            3_000_000
        };
        let ix = f.system_transfer(f.caller, d, amount);
        let payer = f.caller;
        fixture_send(&mut w, &mut f, &[ix], payer, "fixture-prefund");
    }
    let before = f.token_amount(f.student_ata);
    let sol = f.account(f.sponsor).lamports;
    let rent = f.account(s.vault).lamports;
    let unaffected = f.snapshot(&[
        f.scope(2).milestone,
        f.scope(2).vault,
        s.submission,
        f.internship,
        MINT,
    ]);
    let plan = w.prepare(&f, json!({"input":input}));
    assert_eq!(plan["ok"], true, "{plan}");
    let d: Address = plan["selection"]["destination"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let destination_before = f
        .svm
        .get_account(&d)
        .filter(|a| a.owner == TOKEN)
        .map(|_| f.token_amount(d))
        .unwrap_or(0);
    let caller_before = f.account(f.caller).lamports;
    let destination_lamports_before = f.svm.get_account(&d).map(|a| a.lamports).unwrap_or(0);
    let meta = send(&mut f, &plan, name);
    assert_token_cpis(&meta, if surplus { 2 } else { 1 }, 1);
    assert_eq!(f.token_amount(f.student_ata), before + REWARD);
    assert_eq!(
        f.token_amount(d),
        destination_before + if surplus { SURPLUS } else { 0 }
    );
    assert_eq!(&f.account(d).data[32..64], f.sponsor.as_ref());
    assert!(f.svm.get_account(&s.vault).is_none());
    assert_eq!(f.account(f.sponsor).lamports, sol + rent);
    f.assert_status(&s, SETTLED);
    let c = f.program_account(s.completion, 249, COMPLETION_DISC);
    let mut expected = COMPLETION_DISC.to_vec();
    for k in [s.milestone, f.student, f.sponsor, f.verifier, s.submission] {
        expected.extend_from_slice(k.as_ref());
    }
    expected.extend_from_slice(&REQUIREMENTS);
    expected.extend_from_slice(&EVIDENCE);
    expected.extend_from_slice(&(NOW + 20).to_le_bytes());
    expected.extend_from_slice(&(NOW + 20).to_le_bytes());
    expected.push(s.completion_bump);
    assert_eq!(c.data, expected);
    let token_rent = f.svm.minimum_balance_for_rent_exemption(165);
    let contribution =
        if plan["selection"]["kind"] == "created" || plan["selection"]["kind"] == "prefunded" {
            token_rent.saturating_sub(destination_lamports_before)
        } else {
            0
        };
    assert_eq!(
        f.account(f.caller).lamports,
        caller_before - meta.fee - c.lamports - contribution
    );
    let path = root().join("logs").join(format!("case-{name}.json"));
    let mut metrics: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    metrics["tokenRent"] = json!(token_rent);
    metrics["completionRent"] = json!(c.lamports);
    metrics["vaultRentReturned"] = json!(rent);
    metrics["destinationRentContribution"] = json!(contribution);
    metrics["kind"] = plan["selection"]["kind"].clone();
    std::fs::write(path, serde_json::to_vec_pretty(&metrics).unwrap()).unwrap();
    f.assert_unchanged(&unaffected);
    f.assert_conserved();
    assert_eq!(plan["requiredSigners"], json!([f.caller.to_string()]));
    // Fresh VM blockhash separates program replay from exact signed-wire history.
    f.svm.expire_blockhash();
    let raw=w.call(json!({"op":"raw-settle","blockhash":f.svm.latest_blockhash().to_string(),"input":{"sponsorDestination":d.to_string()}}));
    reject(&mut f, &raw, &s, d, &format!("{name}-repeat"), false);
}
macro_rules! positive {
    ($n:ident,$surplus:expr,$mode:expr) => {
        #[test]
        fn $n() {
            success(stringify!($n), $surplus, $mode);
        }
    };
}
positive!(canonical_zero, false, "canonical");
positive!(canonical_surplus, true, "canonical");
positive!(missing_ata_zero, false, "missing");
positive!(missing_ata_surplus, true, "missing");
positive!(changed_authority_zero, false, "changed");
positive!(changed_authority_surplus, true, "changed");
positive!(prefunded_destination, true, "prefunded");
positive!(overfunded_destination, true, "overfunded");
positive!(existing_noncanonical, true, "existing");

#[test]
fn missing_signature() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({"unsigned":true}));
    let d = f.sponsor_ata;
    reject(&mut f, &v, &s, d, "missing_signature", true);
}
#[test]
fn wrong_signing_identity() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({"wrongSignature":true}));
    let d = f.sponsor_ata;
    reject(&mut f, &v, &s, d, "wrong_signing_identity", true);
}
#[test]
fn cross_milestone_signed_substitution() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(
        &f,
        json!({"mutate":{"slot":6,"address":f.scope(2).vault.to_string()}}),
    );
    let d = f.sponsor_ata;
    reject(
        &mut f,
        &v,
        &s,
        d,
        "cross_milestone_signed_substitution",
        false,
    );
}
#[test]
fn invalid_destination_authority() {
    let (mut w, mut f, s) = setup();
    changed(&mut w, &mut f);
    let caller = f.caller;
    let d = provision(&mut w, &mut f, caller);
    let v = w.prepare(&f, json!({"input":{"sponsorDestination":d.to_string()}}));
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "invalid_destination");
    let raw=w.call(json!({"op":"raw-settle","blockhash":f.svm.latest_blockhash().to_string(),"input":{"sponsorDestination":d.to_string()}}));
    reject(&mut f, &raw, &s, d, "invalid_destination_authority", false);
}
#[test]
fn wrong_mint_and_program_rejected_by_client() {
    let (mut w, f, _s) = setup();
    for field in ["rewardMint", "tokenProgram"] {
        let mut input = json!({});
        input[field] = json!(f.sentinel.to_string());
        let v = w.prepare(&f, json!({"input":input}));
        assert_eq!(v["ok"], false);
        assert_eq!(
            v["error"],
            if field == "rewardMint" {
                "incorrect_mint"
            } else {
                "incorrect_token_program"
            }
        );
    }
    record(
        "wrong_mint_and_program_rejected_by_client",
        json!({"result":"passed","clientRejections":2,"executedClientTransactions":0}),
    );
}
#[test]
fn invalid_prefunded_destination() {
    let (mut w, mut f, _s) = setup();
    changed(&mut w, &mut f);
    let d = fallback(&f);
    f.svm
        .set_account(
            d,
            solana_account::Account {
                lamports: 2_000_000,
                owner: PROGRAM_ID,
                ..Default::default()
            },
        )
        .unwrap();
    let v = w.prepare(&f, json!({}));
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "fallback_address_in_use");
    record(
        "invalid_prefunded_destination",
        json!({"result":"passed","fixture":"foreign-owned synthetic occupied address","clientRejection":v["error"]}),
    );
}
#[test]
fn stale_canonical_authority() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({}));
    changed(&mut w, &mut f);
    let d = f.sponsor_ata;
    reject(&mut f, &v, &s, d, "stale_canonical_authority", false);
    assert_eq!(f.token_amount(f.student_ata), 0);
}
#[test]
fn stale_fallback_occupied() {
    let (mut w, mut f, s) = setup();
    changed(&mut w, &mut f);
    let v = w.prepare(&f, json!({}));
    let d: Address = v["selection"]["destination"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let occupied=w.call(json!({"op":"fixture","payer":f.caller.to_string(),"blockhash":f.svm.latest_blockhash().to_string(),
 "instructions":v["instructions"].as_array().unwrap()[..2]}));
    send(&mut f, &occupied, "fixture-occupy-destination");
    reject(&mut f, &v, &s, d, "stale_fallback_occupied", false);
    let fresh = w.prepare(&f, json!({}));
    assert_eq!(fresh["ok"], false);
    assert_eq!(fresh["error"], "fallback_address_in_use");
}
#[test]
fn stale_fallback_prefunded_then_refresh() {
    let (mut w, mut f, s) = setup();
    donate(&mut w, &mut f, &s);
    changed(&mut w, &mut f);
    let stale = w.prepare(&f, json!({}));
    let d = fallback(&f);
    let ix = f.system_transfer(f.caller, d, f.svm.minimum_balance_for_rent_exemption(0));
    let caller = f.caller;
    fixture_send(&mut w, &mut f, &[ix], caller, "fixture-race-prefund");
    reject(&mut f, &stale, &s, d, "stale_fallback_prefunded", false);
    let fresh = w.prepare(&f, json!({}));
    assert_eq!(fresh["selection"]["kind"], "prefunded");
    send(&mut f, &fresh, "stale_fallback_prefunded_then_refresh");
    assert_eq!(f.token_amount(f.student_ata), REWARD);
    assert_eq!(f.token_amount(d), SURPLUS);
    f.assert_status(&s, SETTLED);
    f.assert_conserved();
}
#[test]
fn stale_milestone_after_other_settlement() {
    let (mut w, mut f, s) = setup();
    changed(&mut w, &mut f);
    let a = w.prepare(&f, json!({"seed":"plan_a"}));
    let b = w.prepare(&f, json!({"seed":"plan_b"}));
    send(&mut f, &a, "fixture-competing-settlement");
    let d: Address = b["selection"]["destination"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    reject(
        &mut f,
        &b,
        &s,
        d,
        "stale_milestone_after_other_settlement",
        false,
    );
    assert!(f.svm.get_account(&d).is_none());
    assert_eq!(f.token_amount(f.student_ata), REWARD);
    f.assert_status(&s, SETTLED);
}
#[test]
fn stale_completion_collision() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({}));
    let mut data = vec![0; 249];
    data[..8].copy_from_slice(&COMPLETION_DISC);
    f.svm
        .set_account(
            s.completion,
            solana_account::Account {
                owner: PROGRAM_ID,
                lamports: f.svm.minimum_balance_for_rent_exemption(249),
                data,
                ..Default::default()
            },
        )
        .unwrap();
    let d = f.sponsor_ata;
    reject(&mut f, &v, &s, d, "stale_completion_collision", false);
}
#[test]
fn stale_escrow_shortfall() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({}));
    let mut a = f.account(s.vault);
    a.data[64..72].copy_from_slice(&(REWARD - 1).to_le_bytes());
    f.svm.set_account(s.vault, a).unwrap();
    let d = f.sponsor_ata;
    reject(&mut f, &v, &s, d, "stale_escrow_shortfall", false);
    f.assert_status(&s, VERIFIED);
}
#[test]
fn exact_client_wire_replay() {
    let (mut w, mut f, s) = setup();
    let v = w.prepare(&f, json!({}));
    send(&mut f, &v, "fixture-first-client-settlement");
    let before = f.settlement_snapshot(&s, f.sponsor_ata);
    let e = f
        .svm
        .send_transaction(decode(&v))
        .expect_err("duplicate must fail");
    assert!(format!("{:?}", e.err).contains("AlreadyProcessed"));
    assert_eq!(e.meta.compute_units_consumed, 0);
    f.assert_rollback(&before, f.caller, 0);
    record(
        "exact_client_wire_replay",
        json!({"result":"passed","error":format!("{:?}",e.err),"compute":0,"fee":0,"sigverify":true}),
    );
}
#[test]
fn rollback_after_client_provisioning_and_settlement() {
    let (mut w, mut f, s) = setup();
    donate(&mut w, &mut f, &s);
    changed(&mut w, &mut f);
    let v = w.prepare(&f, json!({"lateFailure":true}));
    let d = fallback(&f);
    let before = f.settlement_snapshot(&s, d);
    let e = f
        .svm
        .send_transaction(decode(&v))
        .expect_err("last instruction must fail");
    assert_token_cpis(&e.meta, 2, 1);
    assert!(e
        .meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {PROGRAM_ID} success")));
    f.assert_rollback(&before, f.caller, e.meta.fee);
    assert!(f.svm.get_account(&d).is_none());
    assert!(f.svm.get_account(&s.completion).is_none());
    f.assert_status(&s, VERIFIED);
    f.assert_conserved();
    record(
        "rollback_after_client_provisioning_and_settlement",
        json!({"result":"passed","error":format!("{:?}",e.err),"compute":e.meta.compute_units_consumed,"fee":e.meta.fee,"size":v["size"],"logs":e.meta.logs,"sigverify":true}),
    );
}
#[test]
fn rollback_after_client_provisioning_wrong_destination() {
    let (mut w, mut f, s) = setup();
    changed(&mut w, &mut f);
    let caller = f.caller;
    let bad = provision(&mut w, &mut f, caller);
    let v = w.prepare(&f, json!({"mutate":{"slot":9,"address":bad.to_string()}}));
    let d = fallback(&f);
    let before = f.settlement_snapshot(&s, d);
    let e = f
        .svm
        .send_transaction(decode(&v))
        .expect_err("wrong authority after provisioning");
    assert_token_cpis(&e.meta, 0, 0);
    assert!(e
        .meta
        .logs
        .iter()
        .any(|l| l == "Program log: Instruction: InitializeAccount3"));
    f.assert_rollback(&before, f.caller, e.meta.fee);
    assert!(f.svm.get_account(&d).is_none());
    record(
        "rollback_after_client_provisioning_wrong_destination",
        json!({"result":"passed","error":format!("{:?}",e.err),"compute":e.meta.compute_units_consumed,"fee":e.meta.fee,"logs":e.meta.logs,"sigverify":true}),
    );
}
#[test]
fn signed_unauthorized_student_submission() {
    let (mut w, mut f, _s) = setup();
    f.svm = std::mem::take(&mut f.svm).with_sigverify(false);
    let s = f.scope(3);
    f.create_and_fund(&s);
    f.assign(&s);
    signed(&mut f);
    let ix = instruction(
        "submit_milestone",
        &[
            (f.caller, true, true),
            (f.internship, false, false),
            (s.milestone, false, true),
            (s.submission, false, true),
            (solana_sdk_ids::system_program::ID, false, false),
        ],
        &EVIDENCE,
    );
    let v = w.fixture(&f, &[ix], f.caller);
    let d = f.sponsor_ata;
    reject(
        &mut f,
        &v,
        &s,
        d,
        "signed_unauthorized_student_submission",
        false,
    );
}
#[test]
fn signed_unauthorized_verifier_attestation() {
    let (mut w, mut f, _s) = setup();
    f.svm = std::mem::take(&mut f.svm).with_sigverify(false);
    let s = f.scope(3);
    f.create_and_fund(&s);
    f.assign(&s);
    signed(&mut f);
    let submit = instruction(
        "submit_milestone",
        &[
            (f.student, true, true),
            (f.internship, false, false),
            (s.milestone, false, true),
            (s.submission, false, true),
            (solana_sdk_ids::system_program::ID, false, false),
        ],
        &EVIDENCE,
    );
    let payer = f.student;
    fixture_send(
        &mut w,
        &mut f,
        &[submit],
        payer,
        "fixture-signed-student-submission",
    );
    let mut args = f.student.as_ref().to_vec();
    args.extend_from_slice(&REQUIREMENTS);
    args.extend_from_slice(&EVIDENCE);
    let ix = instruction(
        "attest_milestone",
        &[
            (f.caller, true, false),
            (f.internship, false, false),
            (s.milestone, false, true),
            (s.submission, false, false),
        ],
        &args,
    );
    let v = w.fixture(&f, &[ix], f.caller);
    let d = f.sponsor_ata;
    reject(
        &mut f,
        &v,
        &s,
        d,
        "signed_unauthorized_verifier_attestation",
        false,
    );
}

// Lifecycle tests below execute the production TypeScript builders. Internship,
// mint/ATA setup, milestone creation/funding and optional assignment are trusted
// fixtures; every operation named as the subject of a test comes from Node.
fn lifecycle_setup(assigned: bool) -> (Worker, Fixture, Scope) {
    let w = Worker::new();
    let mut f = Fixture::new();
    let s = f.scope(1);
    f.create_and_fund(&s);
    let other = f.scope(2);
    f.create_and_fund(&other);
    if assigned {
        f.assign(&s);
    }
    signed(&mut f);
    (w, f, s)
}

fn lifecycle_wire(w: &mut Worker, f: &Fixture, s: &Scope, action: &str, mut extra: Value) -> Value {
    extra["op"] = json!("lifecycle");
    extra["action"] = json!(action);
    extra["milestoneId"] = json!(s.id.to_string());
    extra["blockhash"] = json!(f.svm.latest_blockhash().to_string());
    let wire = w.call(extra);
    assert_eq!(
        wire["ok"], true,
        "production client rejected test request: {wire}"
    );
    assert_eq!(
        wire["origin"], "lifecycle",
        "must not reconstruct a Rust fixture instruction"
    );
    assert_eq!(wire["action"], action);
    assert!(f.svm.get_sigverify());
    wire
}

fn lifecycle_reject(
    f: &mut Fixture,
    wire: &Value,
    s: &Scope,
    payer: Address,
    name: &str,
    expected: Option<&str>,
    signature_failure: bool,
) -> litesvm::types::TransactionMetadata {
    let mut before = f.settlement_snapshot(s, f.sponsor_ata);
    before.extend(f.snapshot(&[f.student, f.verifier]));
    let e = f
        .svm
        .send_transaction(decode(wire))
        .expect_err("lifecycle attack must fail");
    if signature_failure {
        assert!(
            format!("{:?}", e.err).contains("SignatureFailure"),
            "{:?}",
            e.err
        );
        assert_eq!(e.meta.compute_units_consumed, 0);
    } else {
        assert!(e.meta.compute_units_consumed > 0, "{:?}", e.err);
        assert!(!format!("{:?}", e.err).contains("SignatureFailure"));
    }
    if let Some(reason) = expected {
        assert!(
            e.meta.logs.iter().any(|line| line.contains(reason)),
            "{:?}\n{}",
            e.err,
            e.meta.pretty_logs()
        );
    }
    f.assert_rollback(&before, payer, e.meta.fee);
    record(
        name,
        json!({"result":"passed","origin":wire["origin"],"action":wire["action"],
        "error":format!("{:?}",e.err),"sigverify":true,"fee":e.meta.fee,"logs":e.meta.logs}),
    );
    e.meta
}

#[test]
fn lifecycle_assignment_and_submission_from_production_client() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    let other = f.scope(2);
    let unaffected = f.snapshot(&[
        other.milestone,
        other.vault,
        f.internship,
        MINT,
        f.sponsor_ata,
        f.student_ata,
    ]);
    let assignment = lifecycle_wire(&mut w, &f, &s, "assign", json!({}));
    assert_eq!(
        assignment["requiredSigners"],
        json!([f.sponsor.to_string()])
    );
    send(&mut f, &assignment, "lifecycle-assignment");
    f.assert_status(&s, ASSIGNED);
    assert_eq!(&f.account(s.milestone).data[72..104], f.student.as_ref());
    f.set_time(NOW + 10);
    let submission = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    assert_eq!(
        submission["requiredSigners"],
        json!([f.student.to_string()])
    );
    let student_sol = f.account(f.student).lamports;
    let meta = send(&mut f, &submission, "lifecycle-submission");
    f.assert_status(&s, 3);
    let account = f.program_account(s.submission, 113, SUBMISSION_DISC);
    let mut expected = SUBMISSION_DISC.to_vec();
    expected.extend_from_slice(s.milestone.as_ref());
    expected.extend_from_slice(f.student.as_ref());
    expected.extend_from_slice(&EVIDENCE);
    expected.extend_from_slice(&(NOW + 10).to_le_bytes());
    expected.push(s.submission_bump);
    assert_eq!(account.data, expected);
    assert_eq!(
        f.account(f.student).lamports,
        student_sol - account.lamports - meta.fee
    );
    f.assert_unchanged(&unaffected);
    f.assert_conserved();
}

#[test]
fn lifecycle_assignment_wrong_authority() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    let payer = f.caller;
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "assign",
        json!({"payer":payer.to_string(),"mutate":{"slot":0,"address":payer.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-unauthorized-assignment",
        Some("InvalidRole"),
        false,
    );
}

#[test]
fn lifecycle_assignment_rejects_designated_verifier_as_student() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    let payer = f.sponsor;
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "assign",
        json!({"input":{"student":f.verifier.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-invalid-student",
        Some("InvalidRole"),
        false,
    );
}

#[test]
fn lifecycle_assignment_replay_and_deadline() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "assign", json!({}));
    send(&mut f, &v, "lifecycle-first-assignment");
    f.svm.expire_blockhash(); // Fresh wire tests the state gate, not history rejection.
    let repeat = lifecycle_wire(&mut w, &f, &s, "assign", json!({}));
    lifecycle_reject(
        &mut f,
        &repeat,
        &s,
        payer,
        "lifecycle-repeat-assignment",
        Some("InvalidState"),
        false,
    );
    let other = f.scope(2);
    f.set_time(ASSIGN_BY);
    let late = lifecycle_wire(&mut w, &f, &other, "assign", json!({}));
    lifecycle_reject(
        &mut f,
        &late,
        &other,
        payer,
        "lifecycle-late-assignment",
        Some("DeadlinePassed"),
        false,
    );
}

#[test]
fn lifecycle_submission_wrong_student() {
    let (mut w, mut f, s) = lifecycle_setup(true);
    let payer = f.caller;
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "submit",
        json!({"payer":payer.to_string(),"input":{"student":payer.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-wrong-student",
        Some("InvalidRole"),
        false,
    );
    assert!(f.svm.get_account(&s.submission).is_none());
}

#[test]
fn lifecycle_duplicate_submission() {
    let (mut w, mut f, s) = lifecycle_setup(true);
    let payer = f.student;
    f.set_time(NOW + 10);
    let v = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    send(&mut f, &v, "lifecycle-first-submission");
    f.svm.expire_blockhash();
    let repeat = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    lifecycle_reject(
        &mut f,
        &repeat,
        &s,
        payer,
        "lifecycle-duplicate-submission",
        None,
        false,
    );
    f.assert_status(&s, 3);
}

#[test]
fn lifecycle_submission_cutoff_rolls_back_initialization() {
    let (mut w, mut f, s) = lifecycle_setup(true);
    let payer = f.student;
    f.set_time(SUBMIT_BY);
    let v = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-late-submission",
        Some("DeadlinePassed"),
        false,
    );
    assert!(f.svm.get_account(&s.submission).is_none());
}

#[test]
fn lifecycle_submission_after_refund_rejects_terminal_state() {
    let (mut w, mut f, s) = lifecycle_setup(true);
    f.set_time(SUBMIT_BY);
    let refund = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    send(&mut f, &refund, "lifecycle-refund-before-submission");
    let payer = f.student;
    let submit = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    lifecycle_reject(
        &mut f,
        &submit,
        &s,
        payer,
        "lifecycle-submit-after-refund",
        Some("InvalidState"),
        false,
    );
    f.assert_status(&s, REFUNDED);
    assert!(f.svm.get_account(&s.submission).is_none());
}

fn lifecycle_refund_success(assigned: bool, name: &str) {
    let (mut w, mut f, s) = lifecycle_setup(assigned);
    donate(&mut w, &mut f, &s); // Signed real SPL fixture donation.
    f.set_time(SUBMIT_BY);
    let before = f.token_amount(f.sponsor_ata);
    let sponsor_sol = f.account(f.sponsor).lamports;
    let rent = f.account(s.vault).lamports;
    let other = f.scope(2);
    let unaffected = f.snapshot(&[
        other.milestone,
        other.vault,
        f.internship,
        MINT,
        f.student_ata,
    ]);
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    assert_eq!(v["requiredSigners"], json!([f.sponsor.to_string()]));
    let meta = send(&mut f, &v, name);
    assert_token_cpis(&meta, 1, 1);
    assert_eq!(f.token_amount(f.sponsor_ata), before + REWARD + SURPLUS);
    assert_eq!(f.account(f.sponsor).lamports, sponsor_sol + rent - meta.fee);
    f.assert_status(&s, REFUNDED);
    assert!(f.svm.get_account(&s.vault).is_none());
    assert!(f.svm.get_account(&s.completion).is_none());
    assert!(f.svm.get_account(&s.submission).is_none());
    f.assert_unchanged(&unaffected);
    f.assert_conserved();
}

#[test]
fn lifecycle_funded_refund_returns_principal_surplus_and_rent() {
    lifecycle_refund_success(false, "lifecycle-funded-refund");
}
#[test]
fn lifecycle_assigned_refund_returns_principal_surplus_and_rent() {
    lifecycle_refund_success(true, "lifecycle-assigned-refund");
}

#[test]
fn lifecycle_refund_wrong_authority() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    f.set_time(SUBMIT_BY);
    let payer = f.caller;
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "refund",
        json!({"payer":payer.to_string(),"mutate":{"slot":0,"address":payer.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-unauthorized-refund",
        Some("InvalidRole"),
        false,
    );
}

#[test]
fn lifecycle_refund_before_cutoff() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    f.set_time(SUBMIT_BY - 1);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-early-refund",
        Some("RefundTooEarly"),
        false,
    );
}

#[test]
fn lifecycle_refund_after_submission() {
    let (mut w, mut f, s) = lifecycle_setup(true);
    f.set_time(NOW + 10);
    let submit = lifecycle_wire(&mut w, &f, &s, "submit", json!({}));
    send(&mut f, &submit, "lifecycle-submit-before-refund");
    f.set_time(SUBMIT_BY);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-refund-after-submission",
        Some("InvalidState"),
        false,
    );
}

#[test]
fn lifecycle_refund_noncanonical_sponsor_destination_is_rejected() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    let owner = f.sponsor;
    let destination = provision(&mut w, &mut f, owner);
    let untouched = f.snapshot(&[destination]);
    f.set_time(SUBMIT_BY);
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "refund",
        json!({"mutate":{"slot":6,"address":destination.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        owner,
        "lifecycle-noncanonical-refund",
        Some("InvalidDestination"),
        false,
    );
    f.assert_unchanged(&untouched);
    f.assert_conserved();
}

#[test]
fn lifecycle_refund_changed_canonical_authority_is_rejected() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    changed(&mut w, &mut f);
    f.set_time(SUBMIT_BY);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    let meta = lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-changed-refund-authority",
        None,
        false,
    );
    assert_token_cpis(&meta, 0, 0);
    f.assert_status(&s, FUNDED);
}

#[test]
fn lifecycle_refund_cross_milestone_vault_is_rejected() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    f.set_time(SUBMIT_BY);
    let payer = f.sponsor;
    let v = lifecycle_wire(
        &mut w,
        &f,
        &s,
        "refund",
        json!({"mutate":{"slot":4,"address":f.scope(2).vault.to_string()}}),
    );
    lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-cross-vault-refund",
        Some("ConstraintSeeds"),
        false,
    );
    f.assert_conserved();
}

#[test]
fn lifecycle_refund_transfer_failure_rolls_back() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    // Deliberately synthetic, unbacked u64::MAX destination reaches Token overflow.
    let payer = f.sponsor;
    let destination = f.sponsor_ata;
    f.synthetic_token_overflow(destination);
    f.set_time(SUBMIT_BY);
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    let meta = lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-refund-transfer-rollback",
        None,
        false,
    );
    assert_token_cpis(&meta, 1, 0);
    assert!(meta
        .logs
        .iter()
        .any(|l| l.contains(&format!("Program {TOKEN} failed"))));
    f.assert_status(&s, FUNDED);
}

#[test]
fn lifecycle_refund_close_failure_rolls_back_transfer() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    // Synthetic SOL overflow, not claimed economically reachable.
    f.synthetic_close_overflow();
    f.set_time(SUBMIT_BY);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({}));
    let meta = lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-refund-close-rollback",
        None,
        false,
    );
    assert_token_cpis(&meta, 1, 1);
    assert!(meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {TOKEN} success")));
    assert!(meta
        .logs
        .iter()
        .any(|l| l.contains(&format!("Program {TOKEN} failed"))));
    f.assert_status(&s, FUNDED);
    f.assert_conserved();
}

#[test]
fn lifecycle_refund_later_instruction_failure_is_atomic() {
    let (mut w, mut f, s) = lifecycle_setup(false);
    f.set_time(SUBMIT_BY);
    let payer = f.sponsor;
    let v = lifecycle_wire(&mut w, &f, &s, "refund", json!({"lateFailure":true}));
    let meta = lifecycle_reject(
        &mut f,
        &v,
        &s,
        payer,
        "lifecycle-refund-later-rollback",
        None,
        false,
    );
    assert_token_cpis(&meta, 1, 1);
    assert!(meta
        .logs
        .iter()
        .any(|l| l == &format!("Program {PROGRAM_ID} success")));
    f.assert_status(&s, FUNDED);
    f.assert_conserved();
}

#[test]
fn lifecycle_all_builders_require_valid_cryptographic_signatures() {
    for action in ["assign", "submit", "refund"] {
        for wrong in [false, true] {
            let (mut w, mut f, s) = lifecycle_setup(action == "submit");
            if action == "refund" {
                f.set_time(SUBMIT_BY);
            }
            let payer = if action == "submit" {
                f.student
            } else {
                f.sponsor
            };
            let extra = if wrong {
                json!({"wrongSignature":true})
            } else {
                json!({"unsigned":true})
            };
            let v = lifecycle_wire(&mut w, &f, &s, action, extra);
            lifecycle_reject(
                &mut f,
                &v,
                &s,
                payer,
                &format!("lifecycle-{action}-bad-signature-{wrong}"),
                None,
                true,
            );
        }
    }
}
