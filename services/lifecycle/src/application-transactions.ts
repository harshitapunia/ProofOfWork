/** Durable one-send fence for approved application operations. No signer, sender or authorization factory. */
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { check, address, exact } from "./common.js";
export type ApplicationTransactionState =
  | "signing_reserved"
  | "signed"
  | "send_reserved"
  | "submitted"
  | "unknown"
  | "confirmed"
  | "failed";
export interface ApplicationTransaction {
  id: string;
  operationKey: string;
  wallet: string;
  approvalId: string;
  messageDigest: string;
  scopeDigest: string;
  context: string;
  state: ApplicationTransactionState;
  signature: string | null;
  sendReserved: boolean;
  revision: number;
}
export type ApplicationTransactionInput = Pick<
  ApplicationTransaction,
  | "id"
  | "operationKey"
  | "wallet"
  | "approvalId"
  | "messageDigest"
  | "scopeDigest"
  | "context"
>;
function signature(value: string) {
  check(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value));
  let n = 0n;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const zeroes = value.length - value.replace(/^1+/, "").length;
  check(n !== 0n && zeroes + Math.ceil(n.toString(16).length / 2) === 64);
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
function valid(v: ApplicationTransactionInput) {
  exact(v, [
    "approvalId",
    "context",
    "id",
    "messageDigest",
    "operationKey",
    "scopeDigest",
    "wallet",
  ]);
  address(v.wallet);
  check(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      v.id
    ) &&
      /^[A-Za-z0-9_-]{1,80}$/.test(v.approvalId) &&
      typeof v.operationKey === "string" &&
      v.operationKey.length > 0 &&
      v.operationKey.length <= 256 &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.wallet)
  );
  check(
    /^[a-f0-9]{64}$/.test(v.messageDigest) &&
      /^[a-f0-9]{64}$/.test(v.scopeDigest) &&
      typeof v.context === "string" &&
      v.context.length <= 24000
  );
  JSON.parse(v.context);
}
export function createApplicationTransactions(
  transaction: <T>(fn: (db: DatabaseSync) => T, write?: boolean) => T
) {
  const read = (
    db: DatabaseSync,
    id: string
  ): ApplicationTransaction | undefined => {
    const x = db
      .prepare("SELECT * FROM application_transactions WHERE id=?")
      .get(id);
    if (!x) return undefined;
    const v: ApplicationTransaction = {
      id: x.id as string,
      operationKey: x.operation_key as string,
      wallet: x.wallet as string,
      approvalId: x.approval_id as string,
      messageDigest: x.message_digest as string,
      scopeDigest: x.scope_digest as string,
      context: x.context as string,
      state: x.state as ApplicationTransactionState,
      signature: x.signature as string | null,
      sendReserved: x.send_reserved === 1,
      revision: x.revision as number,
    };
    valid({
      id: v.id,
      operationKey: v.operationKey,
      wallet: v.wallet,
      approvalId: v.approvalId,
      messageDigest: v.messageDigest,
      scopeDigest: v.scopeDigest,
      context: v.context,
    });
    check(
      x.context_digest === digest(v.context) &&
        [
          "signing_reserved",
          "signed",
          "send_reserved",
          "submitted",
          "unknown",
          "confirmed",
          "failed",
        ].includes(v.state) &&
        Number.isSafeInteger(v.revision) &&
        v.revision >= 0 &&
        (x.send_reserved === 0 || x.send_reserved === 1) &&
        x.format === "application-v1",
      "corrupt_store"
    );
    if (v.signature !== null) signature(v.signature);
    check(
      !v.sendReserved ||
        [
          "send_reserved",
          "submitted",
          "unknown",
          "confirmed",
          "failed",
        ].includes(v.state),
      "corrupt_store"
    );
    return Object.freeze(v);
  };
  return Object.freeze({
    reserve(input: ApplicationTransactionInput): ApplicationTransaction {
      valid(input);
      return transaction((db) => {
        check(
          !db
            .prepare(
              "SELECT id FROM application_transactions WHERE operation_key=? OR approval_id=? OR id=?"
            )
            .get(input.operationKey, input.approvalId, input.id),
          "application_attempt_consumed"
        );
        db.prepare(
          "INSERT INTO application_transactions VALUES(?,?,?,?,?,?,?,?,?,'signing_reserved',NULL,0,0)"
        ).run(
          input.id,
          input.operationKey,
          input.wallet,
          input.approvalId,
          input.messageDigest,
          input.scopeDigest,
          input.context,
          digest(input.context),
          "application-v1"
        );
        return read(db, input.id)!;
      });
    },
    get(id: string) {
      return transaction((db) => read(db, id), false);
    },
    getForOperation(key: string) {
      return transaction((db) => {
        const x = db
          .prepare(
            "SELECT id FROM application_transactions WHERE operation_key=?"
          )
          .get(key);
        return x ? read(db, x.id as string) : undefined;
      }, false);
    },
    transition(
      id: string,
      revision: number,
      to: ApplicationTransactionState,
      suppliedSignature?: string
    ): ApplicationTransaction {
      return transaction((db) => {
        const old = read(db, id);
        check(old && old.revision === revision, "conflict");
        const allowed: Record<
          ApplicationTransactionState,
          ApplicationTransactionState[]
        > = {
          signing_reserved: ["signed", "unknown"],
          signed: ["send_reserved", "confirmed", "failed"],
          send_reserved: ["submitted", "unknown", "confirmed", "failed"],
          submitted: ["unknown", "confirmed", "failed"],
          unknown: ["confirmed", "failed"],
          confirmed: [],
          failed: [],
        };
        check(allowed[old.state].includes(to), "invalid_transition");
        const sig = suppliedSignature ?? old.signature;
        if (sig !== null) signature(sig);
        check(
          old.signature === null || sig === old.signature,
          "transaction_substitution"
        );
        check(
          ![
            "signed",
            "send_reserved",
            "submitted",
            "confirmed",
            "failed",
          ].includes(to) || sig !== null
        );
        const result = db
          .prepare(
            "UPDATE application_transactions SET state=?,signature=?,send_reserved=?,revision=revision+1 WHERE id=? AND revision=?"
          )
          .run(
            to,
            sig,
            to === "send_reserved" ? 1 : Number(old.sendReserved),
            id,
            revision
          );
        check(result.changes === 1, "conflict");
        return read(db, id)!;
      });
    },
  });
}
