import type { DatabaseSync } from "node:sqlite";
import { check } from "./common.js";
export const RESERVATION_SCHEMA_V1 = [
  "CREATE TABLE counters(kind TEXT NOT NULL CHECK(kind IN ('internship','milestone')), scope TEXT NOT NULL, next TEXT CHECK(next IS NULL OR (length(next)=20 AND next NOT GLOB '*[^0-9]*' AND next<='18446744073709551615')), PRIMARY KEY(kind,scope)) STRICT",
  "CREATE TABLE reservations(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('internship','milestone','fallback')), scope TEXT NOT NULL, value TEXT NOT NULL, address TEXT NOT NULL UNIQUE, bindings TEXT NOT NULL CHECK(json_valid(bindings)), identity TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','prepared','pending','confirmed','failed','reconciliation')), revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=4), message_digest TEXT, transaction_id TEXT, UNIQUE(kind,scope,value)) STRICT",
  "CREATE TABLE history(reservation_id TEXT NOT NULL REFERENCES reservations(id), revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=4), state TEXT NOT NULL CHECK(state IN ('reserved','prepared','pending','confirmed','failed','reconciliation')), PRIMARY KEY(reservation_id,revision)) STRICT",
];

export const JOB_SCHEMA_V2 = [
  "CREATE TABLE verification_jobs(job_id TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, operation_key TEXT NOT NULL UNIQUE, bindings TEXT NOT NULL CHECK(json_valid(bindings)), binding_digest TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('created','claimed','verification_running','verification_completed','verification_rejected','authorization_pending','recovery_required','closed')), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 256), generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 2147483647), worker_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('none','passed','rejected')), reason TEXT) STRICT",
  "CREATE TABLE verification_job_history(job_id TEXT NOT NULL REFERENCES verification_jobs(job_id), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 256), event TEXT NOT NULL CHECK(json_valid(event)), digest TEXT NOT NULL, PRIMARY KEY(job_id,revision)) STRICT",
  "CREATE TRIGGER verification_job_no_delete BEFORE DELETE ON verification_jobs BEGIN SELECT RAISE(ABORT,'job_retained'); END",
  "CREATE TRIGGER verification_job_identity_immutable BEFORE UPDATE OF job_id,creation_id,operation_key,bindings,binding_digest,identity ON verification_jobs BEGIN SELECT RAISE(ABORT,'immutable_job'); END",
  "CREATE TRIGGER verification_history_no_delete BEFORE DELETE ON verification_job_history BEGIN SELECT RAISE(ABORT,'history_retained'); END",
  "CREATE TRIGGER verification_history_no_update BEFORE UPDATE ON verification_job_history BEGIN SELECT RAISE(ABORT,'history_immutable'); END",
];
export const HANDOFF_SCHEMA_V3 = [
  "CREATE TABLE verification_offline_handoffs(job_id TEXT NOT NULL REFERENCES verification_jobs(job_id), sequence INTEGER NOT NULL CHECK(sequence IN (0,1)), event TEXT NOT NULL CHECK(json_valid(event)), digest TEXT NOT NULL, PRIMARY KEY(job_id,sequence)) STRICT",
  "CREATE TRIGGER verification_handoff_no_delete BEFORE DELETE ON verification_offline_handoffs BEGIN SELECT RAISE(ABORT,'handoff_retained'); END",
  "CREATE TRIGGER verification_handoff_no_update BEFORE UPDATE ON verification_offline_handoffs BEGIN SELECT RAISE(ABORT,'handoff_immutable'); END",
];
export const INTENT_SCHEMA_V4 = [
  "CREATE TABLE transaction_intents(intent_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE REFERENCES verification_jobs(job_id), fee_payer TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('created','preparation_recorded','preparation_rejected','preparation_uncertain','reconciliation_required')), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 2)) STRICT",
  "CREATE TABLE transaction_intent_history(intent_id TEXT NOT NULL REFERENCES transaction_intents(intent_id), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 2), event TEXT NOT NULL CHECK(json_valid(event)), digest TEXT NOT NULL, PRIMARY KEY(intent_id,revision)) STRICT",
  "CREATE TRIGGER transaction_intent_no_delete BEFORE DELETE ON transaction_intents BEGIN SELECT RAISE(ABORT,'intent_retained'); END",
  "CREATE TRIGGER transaction_intent_identity_immutable BEFORE UPDATE OF intent_id,request_id,job_id,fee_payer,identity ON transaction_intents BEGIN SELECT RAISE(ABORT,'immutable_intent'); END",
  "CREATE TRIGGER transaction_intent_history_no_delete BEFORE DELETE ON transaction_intent_history BEGIN SELECT RAISE(ABORT,'intent_history_retained'); END",
  "CREATE TRIGGER transaction_intent_history_no_update BEFORE UPDATE ON transaction_intent_history BEGIN SELECT RAISE(ABORT,'intent_history_immutable'); END",
];
export const EXECUTION_SCHEMA_V5 = [
  "CREATE TABLE execution_attempts(attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, intent_id TEXT NOT NULL UNIQUE REFERENCES transaction_intents(intent_id), observation_authority TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 32)) STRICT",
  "CREATE TABLE execution_history(attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 32), event_id TEXT NOT NULL, event TEXT NOT NULL CHECK(json_valid(event)), digest TEXT NOT NULL, PRIMARY KEY(attempt_id,revision), UNIQUE(attempt_id,event_id)) STRICT",
  "CREATE TRIGGER execution_no_delete BEFORE DELETE ON execution_attempts BEGIN SELECT RAISE(ABORT,'execution_retained'); END",
  "CREATE TRIGGER execution_identity_immutable BEFORE UPDATE OF attempt_id,request_id,intent_id,observation_authority,identity ON execution_attempts BEGIN SELECT RAISE(ABORT,'immutable_execution'); END",
  "CREATE TRIGGER execution_history_no_delete BEFORE DELETE ON execution_history BEGIN SELECT RAISE(ABORT,'execution_history_retained'); END",
  "CREATE TRIGGER execution_history_no_update BEFORE UPDATE ON execution_history BEGIN SELECT RAISE(ABORT,'execution_history_immutable'); END",
];
export const APPLICATION_TRANSACTION_SCHEMA_V6=[
 "CREATE TABLE application_transactions(id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, wallet TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE, message_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, context TEXT NOT NULL CHECK(json_valid(context)), context_digest TEXT NOT NULL, format TEXT NOT NULL CHECK(format='application-v1'), state TEXT NOT NULL CHECK(state IN ('signing_reserved','signed','send_reserved','submitted','unknown','confirmed','failed')), signature TEXT, send_reserved INTEGER NOT NULL CHECK(send_reserved IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT",
 "CREATE TRIGGER application_transaction_no_delete BEFORE DELETE ON application_transactions BEGIN SELECT RAISE(ABORT,'application_transaction_retained'); END",
 "CREATE TRIGGER application_transaction_binding_immutable BEFORE UPDATE OF id,operation_key,wallet,approval_id,message_digest,scope_digest,context,context_digest,format ON application_transactions BEGIN SELECT RAISE(ABORT,'immutable_application_transaction'); END",
 "CREATE TRIGGER application_send_reservation_retained BEFORE UPDATE OF send_reserved ON application_transactions WHEN NEW.send_reserved<OLD.send_reserved BEGIN SELECT RAISE(ABORT,'send_reservation_retained'); END",
];
/** Append-only supersession edges. The original v6 rows remain byte-for-byte intact. */
export const APPLICATION_RECOVERY_SCHEMA_V7=[
 "CREATE TABLE application_attempt_successors(previous_id TEXT PRIMARY KEY REFERENCES application_transactions(id), next_id TEXT NOT NULL UNIQUE REFERENCES application_transactions(id), operation_key TEXT NOT NULL, CHECK(previous_id<>next_id)) STRICT",
 "CREATE INDEX application_successor_scope ON application_attempt_successors(operation_key)",
 "CREATE TRIGGER application_successor_no_delete BEFORE DELETE ON application_attempt_successors BEGIN SELECT RAISE(ABORT,'application_successor_retained'); END",
 "CREATE TRIGGER application_successor_immutable BEFORE UPDATE ON application_attempt_successors BEGIN SELECT RAISE(ABORT,'immutable_application_successor'); END",
];
const APP_ID = 0x504f574c;
function validate(db: DatabaseSync, expected: readonly string[]): void {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.sql).sort();
  check(JSON.stringify(actual) === JSON.stringify([...expected].sort()), "schema_mismatch");
}
/** Caller holds BEGIN IMMEDIATE: all DDL, version changes and validation roll back together. */
export function migrateLifecycleSchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()!.user_version;
  const application = db.prepare("PRAGMA application_id").get()!.application_id;
  check(version === 0 || version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7, "schema_mismatch");
  if (version === 0) {
    check(application === 0, "schema_mismatch"); validate(db, []);
    for (const sql of RESERVATION_SCHEMA_V1) db.exec(sql);
    db.exec("PRAGMA application_id=" + APP_ID);
  } else {
    check(application === APP_ID, "schema_mismatch");
    validate(db, version === 1 ? RESERVATION_SCHEMA_V1 : version === 2 ? [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2] : version === 3 ? [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2, ...HANDOFF_SCHEMA_V3] : [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2, ...HANDOFF_SCHEMA_V3, ...INTENT_SCHEMA_V4, ...(version >= 5 ? EXECUTION_SCHEMA_V5 : []), ...(version >= 6 ? APPLICATION_TRANSACTION_SCHEMA_V6 : []), ...(version >= 7 ? APPLICATION_RECOVERY_SCHEMA_V7 : [])]);
  }
  if (version === 0 || version === 1) {
    for (const sql of JOB_SCHEMA_V2) db.exec(sql);
    db.exec("PRAGMA user_version=2");
  }
  if (version < 3) {
    for (const sql of HANDOFF_SCHEMA_V3) db.exec(sql);
    db.exec("PRAGMA user_version=3");
  }
  if (version < 4) {
    for (const sql of INTENT_SCHEMA_V4) db.exec(sql);
    db.exec("PRAGMA user_version=4");
  }
  if (version < 5) { for (const sql of EXECUTION_SCHEMA_V5) db.exec(sql); db.exec("PRAGMA user_version=5"); }
  if(version<6){for(const sql of APPLICATION_TRANSACTION_SCHEMA_V6)db.exec(sql);db.exec("PRAGMA user_version=6");}
  if(version<7){for(const sql of APPLICATION_RECOVERY_SCHEMA_V7)db.exec(sql);db.exec("PRAGMA user_version=7");}
  validate(db, [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2, ...HANDOFF_SCHEMA_V3, ...INTENT_SCHEMA_V4, ...EXECUTION_SCHEMA_V5, ...APPLICATION_TRANSACTION_SCHEMA_V6, ...APPLICATION_RECOVERY_SCHEMA_V7]);
}
