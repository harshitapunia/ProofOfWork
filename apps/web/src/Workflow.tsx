import {AttestationReview} from "./AttestationReview";
import { WorkflowStatus } from "./WorkflowStatus";
import { ExecutionReview } from "./ExecutionReview";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ENVELOPE, ApiError, message, request, type Session } from "./api";
import { WORKFLOW_PATH } from "./routes";
interface Terms {
  title: string; note: string; sponsor: string; student: string; verifier: string;
  internshipId: string; milestoneId: string; rewardAmountRaw: string; assignBy: string; submitBy: string;
  owner: string; repository: string; manifest: string;
}
export interface Preparation {
  kind: "workflow_preparation"; stage: "unsigned_instruction_plan"; action: "organization" | "submission";
  terms: Terms; internship: string; milestone: string; requirementsHash: string; evidenceHash: string | null;
  steps: { action: string; feePayer: string; instructions: { programId: string; dataBase64: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }[] }[];
  accountState: "not_observed"; idsReserved: false; signed: false; broadcast: false;
  verification: "not_run"; proposalAuthority: "not_proven"; rewardPayment: "not_established";
}
const errors: Record<string, string> = {
  invalid_wallet: "Enter canonical, nonzero, on-curve Solana wallet addresses.",
  invalid_assignment: "Sponsor, student and independent verifier must be three different wallets.",
  invalid_integer: "Use unsigned decimal integers within u64. Reward must be positive raw DEMO units; no decimals or rounding.",
  invalid_deadlines: "Use future UTC deadlines: assignment before submission. Submission preparation must be before its cutoff.",
  invalid_manifest: "Paste the exact approved compact verifier manifest (sum-v1 or sum-v2), including pinned tests and runner image. No template or digest is invented.",
  invalid_github_evidence: "Check repository/contributor IDs, 40 lowercase hex commit, 64 lowercase hex nonce and positive PR number.",
  workflow_forbidden: "This wallet is not the sponsor or intended student for this proposal.",
  invalid_workflow: "Check every required field and the organization proposal format. Unknown fields are rejected.",
};
function seconds(value: string): string {
  const ms = Date.parse(value + "Z");
  if (!Number.isFinite(ms) || ms % 1000) throw new Error("Use UTC deadlines with whole seconds.");
  return String(ms / 1000);
}
export function Workflow({ session, role, onExpired }: { session: Session; role: "student" | "organization"; onExpired: () => void }) {
  const [result, setResult] = useState<Preparation | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [submittedWorkflow,setSubmittedWorkflow] = useState<object|null>(null);
  const [proposal, setProposal] = useState("");
  const current = useRef(0), pending = useRef<AbortController | null>(null);
  const clear = () => { current.current++; pending.current?.abort(); setResult(null); setSubmittedWorkflow(null); setError(""); setBusy(false); };
  useEffect(() => () => { current.current++; pending.current?.abort(); }, []);
  async function prepare(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); clear(); const revision = current.current, form = new FormData(e.currentTarget);
    const text = (k: string) => String(form.get(k) ?? "");
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    try {
      let terms: Terms;
      if (role === "organization") {
        terms = { title: text("title"), note: text("note"), sponsor: session.wallet, student: text("student"), verifier: text("verifier"),
          internshipId: text("internshipId"), milestoneId: text("milestoneId"), rewardAmountRaw: text("rewardAmountRaw"),
          assignBy: seconds(text("assignBy")), submitBy: seconds(text("submitBy")), owner: text("owner"), repository: text("repository"), manifest: text("manifest") };
        if (BigInt(terms.assignBy) <= BigInt(Math.floor(Date.now()/1000)) || BigInt(terms.assignBy) >= BigInt(terms.submitBy)) throw new Error(errors.invalid_deadlines);
      } else {
        try { const imported = JSON.parse(proposal); terms = imported.terms; if (!terms || typeof terms !== "object") throw new Error(); }
        catch { throw new Error("Paste the organization preparation JSON. It is an untrusted proposal, not proof of assignment."); }
      }
      const evidence = role === "student" ? { contributorId: text("contributorId"), commit: text("commit"), nonce: text("nonce"), pullRequest: Number(text("pullRequest")) } : undefined;
      const workflow = { ...ENVELOPE, action: role === "organization" ? "organization" : "submission", terms, ...(evidence ? { evidence } : {}) };
      const response = await request<Preparation>(WORKFLOW_PATH, "workflow_preparation", workflow, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
      if (current.current === revision) { setResult(response.data); setSubmittedWorkflow(workflow); }
    } catch (err) {
      if (current.current !== revision) return;
      if (err instanceof ApiError && err.status === 401) { onExpired(); return; }
      setError(err instanceof ApiError ? errors[err.code] ?? message(err) : err instanceof Error ? err.message : "Preparation unavailable.");
    } finally { if (current.current === revision) setBusy(false); }
  }
  const input = (name: string, label: string, options: { pattern?: string; maxLength?: number; type?: string } = {}) => <label>{label}<input name={name} required autoComplete="off" maxLength={options.maxLength ?? 120} {...options} /></label>;
  return <section className="workflow" aria-label="Milestone workflow">
    <h2>{role === "organization" ? "Prepare an internship & milestone" : "Prepare your GitHub submission"}</h2>
    <p>Unsigned preparation only. No IDs reserved, accounts created, tokens moved, work verified or transactions signed. Actual account state is not observed by this form.</p>
    <p>Use fictional internship information and non-monetary DEMO tokens only. A wallet sign-in is not transaction or GitHub authorization.</p>
    <form onSubmit={e => void prepare(e)} onChange={clear}>
      {role === "organization" ? <>
        <p>Sponsor: <span className="workflow-address">{session.wallet}</span> (authenticated wallet)</p>
        <div className="workflow-grid">
          {input("title", "Internship title (local note only)")}
          {input("student", "Intended student wallet", { pattern: "[1-9A-HJ-NP-Za-km-z]{32,44}", maxLength: 44 })}
          {input("verifier", "Independent verifier wallet", { pattern: "[1-9A-HJ-NP-Za-km-z]{32,44}", maxLength: 44 })}
          {input("internshipId", "Reserved internship ID", { pattern: "(0|[1-9][0-9]{0,19})", maxLength: 20 })}
          {input("milestoneId", "Reserved milestone ID", { pattern: "(0|[1-9][0-9]{0,19})", maxLength: 20 })}
          {input("rewardAmountRaw", "Reward (raw DEMO units; 1000000 = 1 DEMO)", { pattern: "[1-9][0-9]{0,19}", maxLength: 20 })}
          {input("assignBy", "Assignment deadline (UTC)", { type: "datetime-local" })}
          {input("submitBy", "Submission deadline (UTC, exclusive)", { type: "datetime-local" })}
          {input("owner", "GitHub repository owner", { pattern: "[A-Za-z0-9](?:[A-Za-z0-9]|-){0,38}", maxLength: 39 })}
          {input("repository", "GitHub repository name", { pattern: "[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,99}", maxLength: 100 })}
        </div>
        <label>Internship information (local note; not part of the verification commitment)<textarea name="note" maxLength={1000} /></label>
        <label>Exact approved requirements manifest<textarea name="manifest" required maxLength={4096} spellCheck={false} /></label>
        <p className="muted">Only the manifest is committed as requirements. The existing verifier supports sum-v1/sum-v2 manifests; arbitrary prose is not an executable verification specification. Supply a genuinely approved pinned runner image. Reserve increasing IDs with your coordinator before use; this stateless form does not allocate them.</p>
      </> : <>
        <label>Organization preparation JSON (untrusted until independently confirmed)<textarea name="proposal" required value={proposal} onChange={e => setProposal(e.target.value)} maxLength={20000} spellCheck={false} /></label>
        <p>Confirm the manifest and assignment with your sponsor. This form checks only that your authenticated wallet matches the proposed student. Use the authorized record reader below for existing job/chain observations.</p>
        <div className="workflow-grid">
          {input("contributorId", "Immutable GitHub contributor ID", { pattern: "[1-9][0-9]{0,19}", maxLength: 20 })}
          {input("commit", "Exact Git SHA-1 commit (40 lowercase hex)", { pattern: "[0-9a-f]{40}", maxLength: 40 })}
          {input("pullRequest", "GitHub pull request number", { pattern: "[1-9][0-9]*", maxLength: 15 })}
          {input("nonce", "Private evidence nonce (64 lowercase hex)", { pattern: "[0-9a-f]{64}", maxLength: 64 })}
        </div>
        <p className="muted">Retain the exact manifest and evidence preimage privately for the designated verifier. Never enter a GitHub token, wallet key or seed here. GitHub identity/provenance and runner checks have not run. One on-chain submission only; duplicate or late submissions fail.</p>
      </>}
      <button disabled={busy} aria-busy={busy}>{busy ? "Preparing instructions…" : role === "organization" ? "Prepare organization instructions" : "Validate evidence & prepare submission"}</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {result && <div className="workflow-result" role="status">
      {submittedWorkflow && <ExecutionReview workflow={submittedWorkflow} operations={result.steps.map(s=>s.action)} wallet={session.wallet} onExpired={onExpired}/>}
      <h3>Unsigned instruction plan prepared</h3><p>No on-chain action succeeded. Imported proposal authority and deployed program remain unverified.</p>
      <dl className="facts"><div><dt>Internship PDA</dt><dd>{result.internship}</dd></div><div><dt>Milestone PDA</dt><dd>{result.milestone}</dd></div><div><dt>Requirements commitment</dt><dd>{result.requirementsHash}</dd></div>{result.evidenceHash && <div><dt>Evidence commitment</dt><dd>{result.evidenceHash}</dd></div>}</dl>
      <ol>{result.steps.map(s => <li key={s.action}>{s.action.replaceAll("_", " ")} — required signer/payer: <span className="workflow-address">{s.feePayer}</span></li>)}</ol>
      <p>Creation → funding → assignment must succeed in program order. Assignment requires Funded state, consent and three distinct role wallets. Funding requires the existing canonical sponsor DEMO ATA and rent. Submission requires actual Assigned state and its exclusive deadline. Chain constraints remain authoritative.</p>
      <label>Review/share proposal and unsigned instruction data<textarea aria-label="Prepared instruction JSON" readOnly value={JSON.stringify(result, null, 2)} /></label>
      <p>Refresh blockhash, inspect accounts and obtain separate explicit wallet authorization before any future execution. This app does not request it.</p>
      <p><strong>Verification not run. Reward payment not established.</strong></p>
    </div>}
    <AttestationReview wallet={session.wallet} onExpired={onExpired}/><WorkflowStatus session={session} role={role} prepared={result} workflow={submittedWorkflow} onExpired={onExpired}/>
    <div className="actions"><button disabled title="No reviewed wallet transaction execution path is enabled.">Sign & broadcast unavailable</button><button disabled title="Separate GitHub authentication, confirmed account bindings and trusted isolated runner required.">Run GitHub verification unavailable</button></div>
  </section>;
}
