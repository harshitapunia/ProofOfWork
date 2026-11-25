import { useEffect, useRef, useState } from "react";
import { requestPhantomTransaction } from "./wallet-execution";
import { ENVELOPE, ApiError, getWallet, message, request } from "./api";
interface Review {
  kind: "attestation_review";
  jobId: string;
  reviewId: string;
  wallet: string;
  feePayer: string;
  verifier: string;
  messageBase58: string;
  expiresAt: string;
  liveExecution: boolean;
  signatureCount: number;
  feeLamports: number;
  scopeDigest: string;
  operationKey: string;
}
/** Both signers use their own wallet session. Only the separately approved payer may submit. */
export function AttestationReview({
  wallet,
  onExpired,
}: {
  wallet: string;
  onExpired: () => void;
}) {
  const [jobId, setJobId] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const generation = useRef(0),
    signed = useRef(false),
    sent = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const check = (r: Review, n: number) => {
    if (
      n !== generation.current ||
      getWallet().publicKey?.toBase58() !== wallet ||
      r.wallet !== wallet ||
      (!Number.isFinite(Date.parse(r.expiresAt)) || Date.now() >= Date.parse(r.expiresAt)) ||
      !r.liveExecution
    )
      throw new Error("Wallet or review changed; no automatic retry.");
  };
  async function act(action: "review" | "sign" | "broadcast" | "confirm") {
    if (busy) return;
    const n = generation.current;
    setBusy(true);
    setError("");
    try {
      const body = { ...ENVELOPE, jobId };
      if (action === "review") {
        const r = (
          await request<Review>(
            "/api/v1/attestation/review",
            "attestation_review",
            body
          )
        ).data;
        check(r, n);
        setReview(r);
        setStatus(
          "Exact verified attestation message ready for separate wallet approvals."
        );
      } else if (action === "sign") {
        if (!review || signed.current) throw Error("Signing attempt consumed.");
        signed.current = true;
        check(review, n);
        await request(
          "/api/v1/attestation/authorize",
          "wallet_execution_authorization",
          body
        );
        check(review, n);
        const wire = await requestPhantomTransaction(getWallet(), review);
        check(review, n);
        const wireBase64 = btoa(
          Array.from(wire, (b) => String.fromCharCode(b)).join("")
        );
        const result = await request<{ signatureCount: number }>(
          "/api/v1/attestation/validate",
          "attestation_signature",
          { ...body, wireBase64 }
        );
        check(review, n);
        setReview({ ...review, signatureCount: result.data.signatureCount });
        setStatus(
          "Your signature was checked against the exact authorized message. Nothing sent."
        );
      } else if (action === "broadcast") {
        if (!review || sent.current || wallet !== review.feePayer)
          throw Error("Submission unavailable.");
        check(review, n);
        sent.current = true;
        const result = await request<{ state: string; signature: string }>(
          "/api/v1/attestation/broadcast",
          "wallet_execution_submission",
          body
        );
        if (n === generation.current)
          setStatus(
            result.data.state +
              ": " +
              result.data.signature +
              ". Confirm separately; never automatically resend."
          );
      } else {
        const result = await request<{ state: string; signature: string }>(
          "/api/v1/attestation/confirm",
          "attestation_confirmation",
          body
        );
        if (n === generation.current)
          setStatus(
            result.data.state +
              ": " +
              result.data.signature +
              ". Refresh the milestone observation separately."
          );
      }
    } catch (e) {
      if (n === generation.current) {
        if (e instanceof ApiError && e.status === 401) onExpired();
        else setError(message(e));
      }
    } finally {
      if (n === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Independent attestation wallet approvals">
      <h2>Independent attestation approvals</h2>
      <p>
        Requires successful trusted GitHub verification, an approved runner and
        an exact operator-approved Devnet action. The verifier and separate fee
        payer sign the same message in their own Phantom sessions. Approval
        expires within 30 seconds; expiry never permits an automatic retry.
      </p>
      <label>
        Attestation job ID
        <input
          value={jobId}
          maxLength={36}
          autoComplete="off"
          onChange={(e) => {
            generation.current++;
            setJobId(e.target.value);
            setReview(null);
            setStatus("");
            setError("");
            setBusy(false);
            signed.current = false;
            sent.current = false;
          }}
        />
      </label>
      <div className="actions">
        <button
          disabled={busy || jobId.length !== 36}
          onClick={() => void act("review")}
        >
          Refresh attestation review
        </button>
        <button
          disabled={busy || !review || signed.current}
          onClick={() => void act("sign")}
        >
          Approve attestation signature in Phantom
        </button>
        <button
          disabled={
            busy ||
            !review ||
            wallet !== review.feePayer ||
            review.signatureCount !== 2 ||
            sent.current
          }
          onClick={() => void act("broadcast")}
        >
          Broadcast jointly signed attestation
        </button>
        <button
          disabled={busy || jobId.length !== 36}
          onClick={() => void act("confirm")}
        >
          Check attestation confirmation
        </button>
      </div>
      {review && (
        <div className="notice">
          <p>
            Verifier: {review.verifier}. Fee payer: {review.feePayer}. Fee:{" "}
            {review.feeLamports} lamports. Checked signatures:{" "}
            {review.signatureCount}/2. Expires: {review.expiresAt}.
          </p>
          <p>Scope commitment: {review.scopeDigest}</p>
          <label>
            Exact attestation message (base58)
            <textarea readOnly value={review.messageBase58} />
          </label>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
