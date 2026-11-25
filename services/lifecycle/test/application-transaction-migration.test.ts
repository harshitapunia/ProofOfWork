import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore } from "../src/storage.js";
import {
  RESERVATION_SCHEMA_V1,
  JOB_SCHEMA_V2,
  HANDOFF_SCHEMA_V3,
  INTENT_SCHEMA_V4,
  EXECUTION_SCHEMA_V5,
  APPLICATION_TRANSACTION_SCHEMA_V6,
} from "../src/schema.js";
test("v5 database migrates additively and preserves old schema and rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-v6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite"),
    raw = new DatabaseSync(path);
  t.after(() => raw.close());
  for (const sql of [
    ...RESERVATION_SCHEMA_V1,
    ...JOB_SCHEMA_V2,
    ...HANDOFF_SCHEMA_V3,
    ...INTENT_SCHEMA_V4,
    ...EXECUTION_SCHEMA_V5,
  ])
    raw.exec(sql);
  raw.exec("PRAGMA application_id=1347376972; PRAGMA user_version=5");
  raw
    .prepare(
      "INSERT INTO counters VALUES('internship','fixture','00000000000000000001')"
    )
    .run();
  const before = raw
    .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
    .all();
  const store = new LifecycleStore(path);
  t.after(() => store.close());
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 6);
  assert.deepEqual(
    raw.prepare("SELECT * FROM counters").all(),
    [
      { kind: "internship", scope: "fixture", next: "00000000000000000001" },
    ].map((v) => Object.assign(Object.create(null), v))
  );
  const after = raw
    .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
    .all();
  for (const row of before) assert(after.some((v) => v.sql === row.sql));
  for (const sql of APPLICATION_TRANSACTION_SCHEMA_V6)
    assert(after.some((v) => v.sql === sql));
});
test("partial application schema is rejected without migration or row deletion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-v6-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite"),
    raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw.exec(APPLICATION_TRANSACTION_SCHEMA_V6[0]!);
  assert.throws(() => new LifecycleStore(path));
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 0);
  assert(
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='application_transactions'"
      )
      .get()
  );
});
