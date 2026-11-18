import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, ENVELOPE, authenticate, getWallet, message, request, uuid, type Execution, type Job, type Milestone, type Observation, type Session } from "./api";
import { demoInternships } from "./demo";

type Mode = "demo" | "api";
interface RecordView { job: Observation<Job>; milestone: Observation<Milestone> | null; execution: Observation<Execution> | null; limitations: string[] }
const short = (s: string) => s.length > 18 ? s.slice(0, 7) + "…" + s.slice(-5) : s;
const words = (s: string) => s.replaceAll("_", " ");
function Status({ children }: { children: string }) { return <span className={"status " + (children === "Verified" ? "positive" : children === "Submitted" ? "pending" : "")}>{words(children)}</span>; }
function Mark() { return <span className="mark" aria-hidden="true">p<span /></span>; }
function Unavailable({ action }: { action: string }) { return <button className="quiet" disabled title="No reviewed transaction or write integration is enabled in this frontend.">{action} unavailable</button>; }

export function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "home");
  const [mode, setMode] = useState<Mode>("demo");
  const [session, setSession] = useState<Session | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState("");
  const [record, setRecord] = useState<RecordView | null>(null);
  const [jobId, setJobId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const generation = useRef(0), readGeneration = useRef(0);
  const authInFlight = useRef(false);
  const main = useRef<HTMLElement>(null);
  const isHome = route === "home";
  const role = route === "organization" ? "organization" : "student";
  const detail = route.startsWith("internship/") ? demoInternships.find(i => i.id === route.split("/")[1]) : undefined;

  function invalidate(text: string) {
    generation.current++; readGeneration.current++;
    setSession(null); setRecord(null); setLoading(false); setNotice(text);
  }
  useEffect(() => {
    const change = () => { setRoute(location.hash.slice(1) || "home"); setLoadError(""); };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => { main.current?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [route]);
  useEffect(() => {
    const p = window.phantom?.solana;
    if (!p?.on || !p.removeListener) return;
    const changed = () => {
      invalidate("Wallet changed or disconnected. Private records were cleared; sign in again.");
      // Best effort server revocation, never evidence of a successful logout when the request fails.
      void request("/api/v1/auth/logout", "wallet_logout", ENVELOPE).catch(() => {});
    };
    p.on("accountChanged", changed); p.on("disconnect", changed);
    return () => { p.removeListener("accountChanged", changed); p.removeListener("disconnect", changed); };
  }, [session?.wallet]);
  useEffect(() => {
    if (!session) return;
    const expires = () => { if (Date.now() >= Date.parse(session.expiresAt)) invalidate("Your session expired. Sign in again to read private records."); };
    const timer = setTimeout(expires, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    window.addEventListener("focus", expires); document.addEventListener("visibilitychange", expires);
    return () => { clearTimeout(timer); window.removeEventListener("focus", expires); document.removeEventListener("visibilitychange", expires); };
  }, [session]);
  async function login() {
    if (authInFlight.current) return;
    authInFlight.current = true; setAuthBusy(true); setAuthError(""); setNotice("");
    const token = ++generation.current;
    try {
      const result = await authenticate(getWallet(), () => generation.current === token);
      if (generation.current === token) { setSession(result); setMode("api"); setRecord(null); setWalletOpen(false); }
    } catch (error) { if (generation.current === token) setAuthError(message(error)); }
    finally { authInFlight.current = false; setAuthBusy(false); }
  }
  async function logout() {
    if (authInFlight.current) return;
    setAuthBusy(true); setAuthError("");
    try {
      await request("/api/v1/auth/logout", "wallet_logout", ENVELOPE);
      invalidate("Signed out. Private records were cleared.");
      try { await getWallet().disconnect(); } catch { /* Session is revoked even if the extension cannot disconnect. */ }
    } catch (error) { invalidate("Private records cleared. Server sign-out could not be confirmed; its session may remain until expiry."); setAuthError(message(error)); }
    finally { setAuthBusy(false); }
  }
  function changeMode(next: Mode) {
    readGeneration.current++; setLoading(false); setMode(next); setRecord(null); setLoadError("");
    if (route.startsWith("internship/") || route === "record") location.hash = "student";
  }
  async function readJob(e: FormEvent) {
    e.preventDefault(); setLoadError(""); setRecord(null);
    if (!uuid(jobId.trim())) { setLoadError("Enter the complete job UUID supplied by your coordinator."); return; }
    if (!session || Date.parse(session.expiresAt) <= Date.now()) { invalidate("Sign in to read an authorized record."); return; }
    const token = ++readGeneration.current, auth = generation.current, id = jobId.trim();
    setLoading(true);
    try {
      const job = await request<Job>(`/api/v1/jobs/${id}`, "verification_job");
      if (job.data.jobId !== id) throw new ApiError("invalid_api_response");
      const results = await Promise.allSettled([
        request<Milestone>(`/api/v1/jobs/${id}/milestone`, "milestone_state"),
        request<Execution>(`/api/v1/jobs/${id}/execution`, "execution_status"),
      ]);
      for (const result of results) if (result.status === "rejected" && result.reason instanceof ApiError && result.reason.status === 401) throw result.reason;
      if (token !== readGeneration.current || auth !== generation.current) return;
      const m = results[0], x = results[1];
      if ((m.status === "fulfilled" && m.value.data.address !== job.data.milestone) || (x.status === "fulfilled" && x.value.data.jobId !== id)) throw new ApiError("invalid_api_response");
      setRecord({ job, milestone: m.status === "fulfilled" ? m.value : null, execution: x.status === "fulfilled" ? x.value : null,
        limitations: results.flatMap(result => result.status === "rejected" ? [message(result.reason)] : []) });
    } catch (error) {
      if (token !== readGeneration.current || auth !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) invalidate("Your session expired. Sign in again to read this record.");
      setLoadError(message(error));
    } finally { if (token === readGeneration.current) setLoading(false); }
  }
  const walletPanel = <section className="wallet-panel" aria-label="Wallet authentication">
    <div><h2>{session ? "Your read-only session" : "Connect, then prove ownership."}</h2><p>Phantom raw-message signing only. No transaction, transfer or payment authorization.</p></div>
    {session ? <><p className="address">{session.wallet}</p><p>Session ends {new Date(session.expiresAt).toLocaleTimeString()}.</p><button onClick={() => void logout()} disabled={authBusy}>Sign out</button></> : <><button onClick={() => void login()} disabled={authBusy} aria-busy={authBusy}>{authBusy ? "Waiting for wallet…" : "Connect Phantom & sign in"}</button><p className="muted">Use a supported Phantom extension or Phantom’s mobile in-app browser. Hardware-wallet and transaction fallbacks are unavailable.</p></>}
    {authError && <p role="alert" className="error">{authError}</p>}
  </section>;
  const sampleLedger = <div className="sample-ledger" data-slot="milestone-ledger">
    <div className="ledger-head"><span>Openfield Studio</span><span className="muted">Fictional project</span></div>
    <h3>Analytics kit</h3><div className="ledger-summary"><span>Milestone ledger</span><span>DEMO tokens</span></div>
    {demoInternships[0].milestones.map((m, i) => <a href="#internship/openfield" className="ledger-row" key={m.title}><span className="ordinal">{i + 1}</span><span><strong>{m.title}</strong><small>{m.evidence}</small></span><Status>{m.status}</Status></a>)}
    <div className="ledger-foot"><span>Reward payment</span><strong>Not established</strong></div>
    <p className="sample-label">Illustrative workflow. No live funds or chain observations.</p>
  </div>;
  return <>
    <a className="skip" href="#main-content" onClick={e => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
    {isHome ? <header className="landing-nav container"><a className="brand" href="#home"><Mark />ProofOfWork</a><nav aria-label="Main navigation"><a href="#student">For students</a><a href="#organization">For organizations</a></nav><button className="quiet" aria-label={session ? "Wallet session for " + session.wallet : undefined} aria-expanded={walletOpen} onClick={() => setWalletOpen(!walletOpen)}>{session ? short(session.wallet) : "Connect wallet"}</button></header> : <aside className="sidebar"><a className="brand" href="#home"><Mark />ProofOfWork</a><nav aria-label="Workspace navigation"><a href="#student" aria-current={route === "student" ? "page" : undefined}>Student workspace</a><a href="#organization" aria-current={route === "organization" ? "page" : undefined}>Organization workspace</a><a href="#home">How it works</a></nav><div className="sidebar-note"><span className="network">Solana Devnet</span><p>Real work. Independent verification. Non-monetary DEMO tokens.</p><span className="muted">Hackathon prototype</span></div></aside>}
    <div className={isHome ? "" : "workspace"}>
      {!isHome && <header className="workspace-bar"><span>Workspace / {detail || route === "record" ? "Internship details" : role === "student" ? "Student" : "Organization"}</span><button className="quiet" aria-label={session ? "Wallet session for " + session.wallet : undefined} aria-expanded={walletOpen} onClick={() => setWalletOpen(!walletOpen)}>{session ? short(session.wallet) : "Connect wallet"}</button></header>}
      {walletOpen && <div className="container">{walletPanel}</div>}
      {notice && <div className="container"><p role="status" className="notice">{notice}</p></div>}
      <main id="main-content" ref={main} tabIndex={-1}>
        {isHome ? <>
          <section className="hero container"><div className="hero-copy"><h1>Good work.<br />Proven, milestone<br />by milestone.</h1><p>Connect internship work, GitHub evidence and independent verification in one place.</p><div className="actions"><a className="button" href="#student">Explore student workspace</a><a className="text-link" href="#organization">View organization workspace</a></div></div>{sampleLedger}</section>
          <section className="process-band"><div className="container process-content"><h2>Every milestone leaves a record.</h2><ol className="process-list"><li><strong>Agree & fund</strong><span>Organizations define milestones and escrow Devnet DEMO tokens.</span></li><li><strong>Submit evidence</strong><span>Students complete the work and provide GitHub evidence.</span></li><li><strong>Verify independently</strong><span>The verifier checks the agreed conditions.</span></li><li><strong>Review settlement</strong><span>Verified milestones may become eligible for on-chain settlement.</span></li></ol></div></section>
          <section className="container entry-section"><div><h2>Start with the work.</h2><p>Follow a fictional internship, or connect to authorized backend records.</p></div><a className="entry-link" href="#student"><strong>For students</strong><span>Follow your milestones and verification progress.</span><span className="entry-icon" aria-hidden="true">↗</span></a><a className="entry-link" href="#organization"><strong>For organizations</strong><span>Review work, escrow states and settlement boundaries.</span><span className="entry-icon" aria-hidden="true">↗</span></a></section>
          <footer className="container landing-footer"><span>ProofOfWork</span><p>A Devnet prototype. DEMO tokens have no monetary value. This frontend does not move tokens.</p><a href="#student">Open workspace</a></footer>
        </> : <div className="page-content">
          <div className="mode-bar"><div><strong>{mode === "demo" ? "Demonstration mode" : "Authenticated API mode"}</strong><span>{mode === "demo" ? "Fictional records. No live Devnet data." : "Read-only records. Provenance shown per observation."}</span></div><div className="mode-switch" role="group" aria-label="Data source"><button aria-pressed={mode === "demo"} onClick={() => changeMode("demo")}>Demonstration</button><button aria-pressed={mode === "api"} onClick={() => changeMode("api")}>Backend API</button></div></div>
          <div className="page-heading"><div><h1>{detail && mode === "demo" ? detail.title : route === "record" ? "Milestone record" : role === "student" ? "Your work, on record." : "A clearer view of the work."}</h1><p>{detail && mode === "demo" ? detail.organization + " / " + detail.area : role === "student" ? "Track the milestones between an assignment and verified work." : "Review milestone progress without losing the evidence behind it."}</p></div><span className="network">Devnet / DEMO</span></div>
          {mode === "demo" ? detail ? <>
            <a className="text-link" href="#student">Back to internships</a><p className="detail-intro">{detail.description}</p>
            <section aria-label="Milestone breakdown"><div className="section-title"><h2>Milestone breakdown</h2><span>{detail.milestones.filter(m => m.status === "Verified").length} verified / {detail.milestones.length} milestones</span></div><div className="milestone-list">{detail.milestones.map((m, i) => <article className="milestone-detail" key={m.title}><span className="ordinal">{i + 1}</span><div><h3>{m.title}</h3><p>{m.evidence}</p><span className="muted">{m.verification}</span></div><div className="milestone-value"><Status>{m.status}</Status><strong>{m.amount} DEMO</strong></div></article>)}</div></section>
            <section className="settlement-note"><div><h2>Verification is not a payout.</h2><p>Sample escrow states are illustrative. Reward payment is not established. Settlement still requires valid chain evidence.</p></div><Unavailable action="Settlement" /></section><div className="actions"><Unavailable action="Submit GitHub evidence" /><Unavailable action="Fund milestone" /></div><p className="muted">No reviewed write or transaction integration is enabled.</p>
          </> : <>
            <div className="summary-strip"><div><span>{role === "student" ? "Sample internships" : "Sample projects"}</span><strong>{demoInternships.length}</strong></div><div><span>Verified milestones</span><strong>1 <small>/ 5 sample milestones</small></strong></div><div><span>Reward payments</span><strong className="summary-text">Not established</strong></div></div>
            <section><div className="section-title"><h2>{role === "student" ? "Your internships" : "Internship overview"}</h2><span>Fictional demonstration records</span></div><div className="internship-list">{demoInternships.map((i, index) => <a className="internship-row" href={"#internship/" + i.id} key={i.id}><span className={"company-mark company-" + index} aria-hidden="true">{index === 0 ? "o" : "s"}</span><div><span className="muted">{i.organization}</span><h3>{i.title}</h3><p>{i.area}</p></div><div className="row-progress"><span>{i.milestones.filter(m => m.status === "Verified").length} / {i.milestones.length} verified</span><progress aria-label={i.title + " verification progress"} value={i.milestones.filter(m => m.status === "Verified").length} max={i.milestones.length} /></div><span className="row-link">View milestones</span></a>)}</div></section>
            <section><div className="section-title"><h2>{role === "student" ? "Next in your workflow" : "Milestone activity"}</h2><a className="text-link" href="#internship/openfield">View internship</a></div><div className="table-scroll" tabIndex={0} aria-label="Sample milestone activity"><table><thead><tr><th>Milestone</th><th>GitHub evidence</th><th>Verification</th><th>Reward allocation</th></tr></thead><tbody>{demoInternships[0].milestones.map(m => <tr key={m.title}><th scope="row">{m.title}</th><td>{m.status === "Assigned" ? "Not submitted" : "Sample evidence"}</td><td><Status>{m.status}</Status></td><td className="amount">{m.amount} DEMO</td></tr>)}</tbody></table></div></section>
            <div className="bottom-note"><p>Funding and reward figures are fictional. No token balances or payments are established.</p><Unavailable action={role === "student" ? "Submit work" : "Create internship"} /></div>
          </> : <>
            <section className="api-reader"><h2>Open an authorized record</h2><p>No listing API is available. Enter a job ID shared by your coordinator. Access is checked against the recorded sponsor or student wallet, independently of this workspace view.</p>
              {!session ? <div className="empty"><h3>Sign in to read your records.</h3><p>No private data has been loaded.</p><button onClick={() => setWalletOpen(true)}>Open wallet sign-in</button></div> : <form onSubmit={e => void readJob(e)}><label htmlFor="job-id">Verification job ID</label><div className="input-row"><input id="job-id" value={jobId} onChange={e => setJobId(e.target.value)} placeholder="Job UUID from your coordinator" autoComplete="off" required maxLength={36} /><button disabled={loading} aria-busy={loading}>{loading ? "Loading record…" : "Load record"}</button></div></form>}
              {loading && <p role="status">Loading authorized job, milestone and execution observations…</p>}{loadError && <p role="alert" className="error">{loadError}</p>}
              {session && !record && !loading && !loadError && <p className="empty-caption">No record loaded. Nothing is inferred from a connected wallet.</p>}
            </section>
            {record && <>
              <section><div className="section-title"><h2>Verification job</h2><Status>{record.job.data.state}</Status></div><dl className="facts"><div><dt>Job ID</dt><dd>{record.job.data.jobId}</dd></div><div><dt>Verification outcome</dt><dd>{record.job.data.verificationOutcome}</dd></div><div><dt>Provenance</dt><dd>{words(record.job.provenance)}</dd></div><div><dt>GitHub evidence</dt><dd>Full verification evidence is not persisted by this API.</dd></div><div><dt>Reconciliation</dt><dd>{record.job.data.reconciliationRequired ? "Required" : "Not flagged"}</dd></div></dl></section>
              {record.milestone && <section><div className="section-title"><h2>Milestone observation</h2><Status>{record.milestone.data.status}</Status></div><dl className="facts">{[["Milestone", record.milestone.data.address], ["Internship", record.milestone.data.internship], ["Recorded sponsor", record.milestone.data.sponsor], ["Recorded student", record.milestone.data.student], ["Reward allocation (raw token units)", record.milestone.data.rewardAmountRaw], ["Reward mint", record.milestone.data.rewardMint], ["Observation", words(record.milestone.provenance) + " / slot " + record.milestone.data.slot], ["Program deployment", "Not verified"], ["Escrow balance", "Not supplied by this API"], ["Settlement eligibility", record.milestone.data.status === "Verified" ? "Verified state observed; on-chain constraints still require validation" : "Not established"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
              {record.execution && <section><h2>Execution observation</h2><p>{record.execution.data.phase ? words(record.execution.data.phase) : "No execution phase recorded"}. Provenance: {words(record.execution.provenance)}.</p><p>Offline test model only. Operational execution unavailable; no live transaction ID.</p></section>}
              {record.limitations.map((limit, i) => <p className="notice" key={i}>{limit}</p>)}
              <section className="settlement-note"><div><h2>Reward payment not established.</h2><p>Neither a verified state nor an offline execution record proves a payout. This frontend cannot transfer tokens.</p></div><Unavailable action="Settlement" /></section>
            </>}
          </>}
          <footer className="workspace-footer"><span>ProofOfWork / Hackathon prototype</span><span>DEMO tokens have no monetary value.</span></footer>
        </div>}
      </main>
    </div>
  </>;
}
