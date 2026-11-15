// Frozen main 0e7589f3 lifecycle v2 implementation for genuine migration fixtures.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { deriveInternship, deriveMilestone, deriveSponsorFallbackDestination,
  settleMilestoneInstruction } from "@proofwork/finance-client";
import { address, check, exact, LifecycleError, MAX_ID, u64 } from "../../src/common.js";
import { migrateLifecycleSchema } from "./schema-v2.js";
import { createVerificationJobs, type VerificationJobs, type JobRecoveryControl } from "../../src/jobs.js";

export type ReservationState = "reserved" | "prepared" | "pending" | "confirmed" | "failed" | "reconciliation";
export interface FallbackBindings {
  readonly caller: string; readonly sponsor: string; readonly student: string;
  readonly internshipId: bigint; readonly milestoneId: bigint; readonly seed: string;
}
export interface Reservation {
  readonly id: string; readonly kind: "internship" | "milestone" | "fallback"; readonly scope: string;
  readonly value: bigint | string; readonly address: string; readonly state: ReservationState; readonly revision: number;
  readonly bindings: readonly string[]; readonly messageDigest?: string; readonly transactionId?: string;
}
const states = ["reserved", "prepared", "pending", "confirmed", "failed", "reconciliation"];
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const fixed = (id: bigint) => u64(id).toString().padStart(20, "0");
const ident = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function signature(value: unknown): void {
  check(typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value));
  let n = 0n; const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const zeroes = value.length - value.replace(/^1+/, "").length;
  check(n !== 0n && zeroes + Math.ceil(n.toString(16).length / 2) === 64);
}
/** Local coordination only. No release/delete/retry/confirmation or signing API. */
export class LifecycleStore {
  #db: DatabaseSync; #closed = false;
  #jobs!: VerificationJobs; #jobRecovery!: JobRecoveryControl;
  get jobs(): VerificationJobs { return this.#jobs; }
  /** Trusted control plane only; do not pass this capability to ordinary workers. */
  get jobRecovery(): JobRecoveryControl { return this.#jobRecovery; }
  constructor(path: string, busyTimeoutMs = 1000) {
    check(typeof path === "string" && isAbsolute(path) && !path.includes("\0")
      && Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 5000);
    let db: DatabaseSync | undefined;
    try {
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing) check(existing.isFile() && !existing.isSymbolicLink());
      // Let SQLite own all database opens; unrelated open/close calls can
      // interfere with POSIX advisory locks shared by same-process connections.
      db = new DatabaseSync(path, { timeout: busyTimeoutMs, allowExtension: false });
      if (!existing) chmodSync(path, 0o600);
      this.#db = db;
      check(db.prepare("PRAGMA journal_mode=DELETE").get()!.journal_mode === "delete", "storage_failure");
      db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF");
      this.#transaction(() => migrateLifecycleSchema(db!));
      const facade = createVerificationJobs((fn, write = true) => this.#transaction(() => fn(this.#db), write));
      this.#jobs = facade.jobs; this.#jobRecovery = facade.recovery;
    } catch (error) {
      try { db?.close(); } catch { /* Sanitize initialization failure. */ }
      throw this.#error(error);
    }
  }
  #error(error: unknown): LifecycleError {
    if (error instanceof LifecycleError) return error;
    const e = error as { errcode?: number };
    const base = e?.errcode === undefined ? undefined : e.errcode & 255;
    return new LifecycleError(base === 5 || base === 6 ? "storage_busy"
      : (e?.errcode !== undefined && (e.errcode & 255) === 19) ? "conflict" : "storage_failure");
  }
  #guard<T>(fn: () => T): T {
    check(!this.#closed, "closed");
    try { return fn(); } catch (error) { throw this.#error(error); }
  }
  #transaction<T>(fn: () => T, write = true): T {
    return this.#guard(() => {
      this.#db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      try { const result = fn(); this.#db.exec("COMMIT"); return result; }
      catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    });
  }
  #row(raw: Record<string, unknown>): Reservation {
    try {
      check(typeof raw.bindings === "string" && raw.bindings.length <= 1024);
      const b: unknown = JSON.parse(raw.bindings);
      check(Array.isArray(b) && b.every(x => typeof x === "string") && (b.length === 4 || b.length === 9));
      check(ident(raw.id) && ["internship", "milestone", "fallback"].includes(String(raw.kind))
        && states.includes(String(raw.state)) && Number.isSafeInteger(raw.revision)
        && (raw.revision as number) >= 0 && (raw.revision as number) <= 4);
      address(raw.scope); address(raw.address);
      check(raw.identity === digest(JSON.stringify(b)) && b[0] === raw.kind
        && b[1] === raw.scope && b[2] === raw.value && b[3] === raw.address);
      let value: bigint | string;
      if (raw.kind !== "fallback") {
        check(b.length === 4 && typeof raw.value === "string" && /^[0-9]{20}$/.test(raw.value));
        value = u64(BigInt(raw.value));
        const expected = raw.kind === "internship" ? deriveInternship(raw.scope as string, value) : deriveMilestone(raw.scope as string, value);
        check(expected[0].toBase58() === raw.address);
      } else {
        check(b.length === 9 && /^[A-Za-z0-9_-]{1,32}$/.test(b[2]!));
        for (const at of [b[4], b[5], b[8]]) address(at);
        for (const id of [b[6], b[7]]) check(/^(0|[1-9][0-9]*)$/.test(id!) && u64(BigInt(id!)) >= 0n);
        check(deriveMilestone(deriveInternship(b[4]!, BigInt(b[6]!))[0], BigInt(b[7]!))[0].toBase58() === b[8]);
        settleMilestoneInstruction({caller:b[1]!,sponsor:b[4]!,student:b[5]!,internshipId:BigInt(b[6]!),milestoneId:BigInt(b[7]!)});
        value = b[2]!;
      }
      check(raw.message_digest === null || (typeof raw.message_digest === "string" && /^[0-9a-f]{64}$/.test(raw.message_digest) && /[1-9a-f]/.test(raw.message_digest)));
      if (raw.transaction_id !== null) signature(raw.transaction_id);
      check(raw.state !== "confirmed", "corrupt_store"); // No trusted confirmation adapter exists in this phase.
      check(raw.state === "reserved" ? raw.message_digest === null && raw.transaction_id === null && raw.revision === 0
        : raw.state === "prepared" ? raw.message_digest !== null && raw.transaction_id === null
        : raw.state === "pending" ? raw.message_digest !== null && raw.transaction_id !== null : true);
      return Object.freeze({ id: raw.id as string, kind: raw.kind as Reservation["kind"], scope: raw.scope as string,
        value, address: raw.address as string, state: raw.state as ReservationState, revision: raw.revision as number,
        bindings: Object.freeze(b as string[]), messageDigest: raw.message_digest as string ?? undefined,
        transactionId: raw.transaction_id as string ?? undefined });
    } catch { throw new LifecycleError("corrupt_store"); }
  }
  #insert(kind: Reservation["kind"], scope: string, value: string, at: string, b: string[]): Reservation {
    const id = randomUUID(), data = JSON.stringify(b);
    this.#db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?,?,'reserved',0,NULL,NULL)")
      .run(id, kind, scope, value, at, data, digest(data));
    this.#db.prepare("INSERT INTO history VALUES(?,0,'reserved')").run(id);
    return this.#get(id)!;
  }
  #get(id: string): Reservation | undefined {
    const raw = this.#db.prepare("SELECT * FROM reservations WHERE id=?").get(id);
    if (!raw) return undefined;
    const row = this.#row(raw); this.#events(row); return row;
  }
  #reserve(kind: "internship" | "milestone", scope: string, minimumId: bigint): Reservation {
    address(scope); u64(minimumId);
    return this.#transaction(() => {
      const raw = this.#db.prepare("SELECT next FROM counters WHERE kind=? AND scope=?").get(kind, scope);
      check(!raw || raw.next !== null, "id_exhausted");
      if (raw) check(typeof raw.next === "string" && /^[0-9]{20}$/.test(raw.next) && BigInt(raw.next) <= MAX_ID, "corrupt_store");
      const id = raw && BigInt(raw.next as string) > minimumId ? BigInt(raw.next as string) : minimumId;
      const next = id === MAX_ID ? null : fixed(id + 1n);
      this.#db.prepare("INSERT INTO counters VALUES(?,?,?) ON CONFLICT(kind,scope) DO UPDATE SET next=excluded.next")
        .run(kind, scope, next);
      const at = (kind === "internship" ? deriveInternship(scope, id) : deriveMilestone(scope, id))[0].toBase58();
      return this.#insert(kind, scope, fixed(id), at, [kind, scope, fixed(id), at]);
    });
  }
  reserveInternship(sponsor: string, minimumId = 0n): Reservation { return this.#reserve("internship", sponsor, minimumId); }
  reserveMilestone(internship: string, minimumId = 0n): Reservation { return this.#reserve("milestone", internship, minimumId); }
  async reserveFallback(input: FallbackBindings): Promise<Reservation> {
    exact(input, ["caller", "sponsor", "student", "internshipId", "milestoneId", "seed"]);
    try { input = structuredClone(input); } catch { throw new LifecycleError("invalid_input"); }
    let at: string, scope: string, value: string, b: string[];
    try {
      const ix = settleMilestoneInstruction(input);
      scope = address(input.caller); value = input.seed;
      at = (await deriveSponsorFallbackDestination(scope, value)).toBase58();
      b = ["fallback", scope, value, at, address(input.sponsor), address(input.student),
        u64(input.internshipId).toString(), u64(input.milestoneId).toString(), ix.keys[2]!.pubkey.toBase58()];
    } catch { throw new LifecycleError("invalid_input"); }
    return this.#transaction(() => this.#insert("fallback", scope, value, at, b));
  }
  get(id: string): Reservation | undefined { check(ident(id)); return this.#transaction(() => this.#get(id), false); }
  listOutstanding(afterId?: string, limit = 100): readonly Reservation[] {
    check(afterId === undefined || ident(afterId));
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 100);
    return this.#transaction(() => Object.freeze(this.#db.prepare(
      "SELECT * FROM reservations WHERE id>? ORDER BY id LIMIT ?"
    ).all(afterId ?? "", limit).map(row => this.#get(row.id as string)!)), false);
  }
  #events(row: Reservation): readonly { readonly revision: number; readonly state: ReservationState }[] {
    const events = this.#db.prepare("SELECT revision,state FROM history WHERE reservation_id=? ORDER BY revision LIMIT 6").all(row.id);
    check(events.length === row.revision + 1 && events[0]?.state === "reserved"
      && events.at(-1)?.state === row.state && events.every((e, n) => {
        if (e.revision !== n || e.state === "confirmed") return false;
        if (n === 0) return e.state === "reserved";
        const before = events[n - 1]!.state;
        return e.state === "prepared" ? before === "reserved" : e.state === "pending" ? before === "prepared"
          : ["failed", "reconciliation"].includes(String(e.state))
            && ["reserved", "prepared", "pending"].includes(String(before));
      }), "corrupt_store");
    check((row.messageDigest !== undefined) === events.some(e => e.state === "prepared")
      && (row.transactionId !== undefined) === events.some(e => e.state === "pending"), "corrupt_store");
    return Object.freeze(events.map(e => Object.freeze({ revision: e.revision as number, state: e.state as ReservationState })));
  }
  history(id: string): readonly { readonly revision: number; readonly state: ReservationState }[] {
    check(ident(id)); return this.#transaction(() => {
      const row = this.#get(id); check(row, "not_found"); return this.#events(row);
    }, false);
  }
  /** Revision-CAS, immutable public operation binding; ambiguous and failed reservations stay consumed. */
  transition(id: string, revision: number, to: Exclude<ReservationState, "reserved" | "confirmed">,
    metadata: { messageDigest: string } | { transactionId: string } | Record<string, never> = {}): Reservation {
    check(ident(id) && Number.isSafeInteger(revision) && revision >= 0);
    check(["prepared", "pending", "failed", "reconciliation"].includes(to), "invalid_transition");
    exact(metadata, to === "prepared" ? ["messageDigest"] : to === "pending" ? ["transactionId"] : []);
    let copy: Record<string, unknown>;
    try { copy = structuredClone(metadata); } catch { throw new LifecycleError("invalid_input"); }
    return this.#transaction(() => {
      const previous = this.#get(id); check(previous, "not_found"); check(previous.revision === revision, "conflict");
      check(to === "prepared" ? previous.state === "reserved" : to === "pending" ? previous.state === "prepared"
        : ["reserved", "prepared", "pending"].includes(previous.state), "invalid_transition");
      let message = previous.messageDigest ?? null, tx = previous.transactionId ?? null;
      if (to === "prepared") {
        check(typeof copy.messageDigest === "string" && /^[0-9a-f]{64}$/.test(copy.messageDigest) && /[1-9a-f]/.test(copy.messageDigest));
        message = copy.messageDigest;
      }
      if (to === "pending") { signature(copy.transactionId); tx = copy.transactionId as string; }
      this.#db.prepare("UPDATE reservations SET state=?,revision=revision+1,message_digest=?,transaction_id=? WHERE id=? AND revision=?")
        .run(to, message, tx, id, revision);
      this.#db.prepare("INSERT INTO history VALUES(?,?,?)").run(id, revision + 1, to);
      return this.#get(id)!;
    });
  }
  close(): void { if (!this.#closed) this.#guard(() => { this.#db.close(); this.#closed = true; }); }
}
