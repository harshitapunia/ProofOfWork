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
const APP_ID = 0x504f574c;
function validate(db: DatabaseSync, expected: readonly string[]): void {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.sql).sort();
  check(JSON.stringify(actual) === JSON.stringify([...expected].sort()), "schema_mismatch");
}
/** Caller holds BEGIN IMMEDIATE: all DDL, version changes and validation roll back together. */
export function migrateLifecycleSchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()!.user_version;
  const application = db.prepare("PRAGMA application_id").get()!.application_id;
  check(version === 0 || version === 1 || version === 2 || version === 3, "schema_mismatch");
  if (version === 0) {
    check(application === 0, "schema_mismatch"); validate(db, []);
    for (const sql of RESERVATION_SCHEMA_V1) db.exec(sql);
    db.exec("PRAGMA application_id=" + APP_ID);
  } else {
    check(application === APP_ID, "schema_mismatch");
    validate(db, version === 1 ? RESERVATION_SCHEMA_V1 : version === 2 ? [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2] : [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2, ...HANDOFF_SCHEMA_V3]);
  }
  if (version === 0 || version === 1) {
    for (const sql of JOB_SCHEMA_V2) db.exec(sql);
    db.exec("PRAGMA user_version=2");
  }
  if (version !== 3) {
    for (const sql of HANDOFF_SCHEMA_V3) db.exec(sql);
    db.exec("PRAGMA user_version=3");
  }
  validate(db, [...RESERVATION_SCHEMA_V1, ...JOB_SCHEMA_V2, ...HANDOFF_SCHEMA_V3]);
}
