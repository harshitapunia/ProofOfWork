import type { WorkflowVerification } from "./workflow-verification.js";
import type { WorkflowStateReader } from "./workflow-state.js";
import { WalletExecutionReviewer } from "./devnet-wallet-review.js";
import { prepareWorkflow } from "./workflow-preparation.js";
/** Explicit composition only. The existing CLI/default server never constructs this service. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { LifecycleStore } from "@proofwork/lifecycle";
import { ApplicationQueries, type ApplicationChainSource } from "./application-queries.js";
import { APPLICATION_API_VERSION, applicationReply, applicationRequestId, type ApiReply, type ApplicationResource } from "./application-api-contracts.js";
import { WalletSessions, WalletAuthError, sessionCookie, readSessionCookie, challengeCookie, readChallengeCookie } from "./wallet-sessions.js";
const PREFIX = "/api/v1/";
export class WalletApplicationHttp {
  #active = 0;
  readonly #services: Readonly<{ store: LifecycleStore; timeoutMs: number; chain?: ApplicationChainSource; workflowState?: WorkflowStateReader; workflowVerification?: WorkflowVerification; walletReview?: WalletExecutionReviewer }> | undefined;
  constructor(readonly sessions: WalletSessions, services?: { store: LifecycleStore; timeoutMs: number; chain?: ApplicationChainSource; workflowState?: WorkflowStateReader; workflowVerification?: WorkflowVerification; walletReview?: WalletExecutionReviewer }) {
    if (!(sessions instanceof WalletSessions)) throw new WalletAuthError("invalid_auth_configuration", 503);
    if (services) {
      // Reuse query configuration validation, but do not install an authentication bypass.
      new ApplicationQueries(services.store, { timeoutMs: services.timeoutMs, ...(services.chain ? { chain: services.chain } : {}) });
      this.#services = Object.freeze({ ...services });
    }
    Object.freeze(this);
  }
  private reply(response: ServerResponse, r: ApiReply): void { response.writeHead(r.statusCode).end(JSON.stringify(r.body)); }
  private async body(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"]
      || (request.headers["content-length"] && Number(request.headers["content-length"]) > 8192))
      throw new WalletAuthError("invalid_request", 400);
    return new Promise((resolve, reject) => {
      let size = 0; const chunks: Buffer[] = [];
      const finish = (error?: WalletAuthError) => {
        clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", failed);
        if (error) { request.resume(); reject(error); }
        else { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new WalletAuthError("invalid_request", 400)); } }
      };
      const data = (chunk: Buffer) => { size += chunk.length; if (size > 8192) finish(new WalletAuthError("request_too_large", 413)); else chunks.push(Buffer.from(chunk)); };
      const end = () => finish(), failed = () => finish(new WalletAuthError("invalid_request", 400));
      const timer = setTimeout(() => finish(new WalletAuthError("request_timeout", 408)), 2000);
      request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", failed);
    });
  }
  /** Returns false for legacy verify, health and unregistered routes; no public activation flag. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url ?? "";
    if (path === PREFIX + "health") {
      if (request.method !== "GET" || request.headers.origin) return false;
      this.reply(response, applicationReply(applicationRequestId(), "health", null, 200, Object.freeze({ kind: "health",
        process: "serving", readiness: "limited", authentication: "wallet_signature_single_instance",
        applicationReads: "authenticated_read_routes", storage: "not_probed", chain: "not_probed", execution: "disabled" }), "process_health", null, "limited"));
      return true;
    }
    const match = /^\/api\/v1\/jobs\/([^/?]+)(?:\/(milestone|execution))?$/.exec(path);
    const walletAction = ["review", "revalidate", "validate", "confirm", "broadcast"].find(action => path === PREFIX + "workflow/" + action);
    const observation = ["workflow/state", "workflow/verification", "workflow/dispatch"].find(action => path === PREFIX + action);
    const preparation = path === PREFIX + "workflow/prepare" || walletAction !== undefined || observation !== undefined;
    const auth = [PREFIX + "auth/challenge", PREFIX + "auth/verify", PREFIX + "auth/logout"].includes(path);
    if (!auth && !match && !preparation) return false;
    let resource: ApplicationResource | "authentication" | "unknown" = auth ? "authentication" : "unknown", id: string | null = null;
    const fail = (code: string, status: number) => applicationReply(applicationRequestId(), resource, id, status, null, "none", code);
    this.#active++;
    try {
      if (this.#active > 16) throw new WalletAuthError("application_capacity", 503);
      const duplicates = (name: string) => request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === name).length > 1;
      if (request.headers.host !== this.sessions.domain || ["host", "origin", "cookie", "authorization"].some(duplicates)
        || request.headers.forwarded || request.headers["x-forwarded-host"] || request.headers["x-forwarded-proto"]
        || (request.headers.origin !== undefined && request.headers.origin !== this.sessions.origin)
        || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin"))
        throw new WalletAuthError("invalid_request", 400);
      const method = auth || preparation ? "POST" : "GET";
      if (request.method !== method) { response.setHeader("allow", method); throw new WalletAuthError("method_not_allowed", 405); }
      if ((auth || preparation) && request.headers.origin !== this.sessions.origin) throw new WalletAuthError("invalid_request", 400);
      if (request.headers.authorization) throw new WalletAuthError("authentication_required", 401);
      const token = readSessionCookie(request.headers.cookie);
      if (preparation) {
        const session = this.sessions.resolve(token);
        if (!session) throw new WalletAuthError("authentication_required", 401);
        if (walletAction === "broadcast") throw new WalletAuthError("live_execution_disabled", 403);
        const input = await this.body(request);
        // Recheck after potentially slow body delivery; a revoked/expired cookie cannot prepare a plan.
        if (this.sessions.resolve(token)?.sessionId !== session.sessionId) throw new WalletAuthError("authentication_required", 401);
        if (observation) {
          const reader=this.#services?.workflowState;
          if(!reader)throw new WalletAuthError("chain_reader_unavailable",503);
          const assertSession=()=>{if(this.sessions.resolve(token)?.sessionId!==session.sessionId)throw new WalletAuthError("authentication_required",401);};
          let data;
          if(observation==="workflow/dispatch"){
            if(!this.#services?.workflowVerification)throw new WalletAuthError("verification_dispatch_unavailable",503);
            data=await this.#services.workflowVerification.dispatch(input,session.wallet,assertSession);
          }else if(observation==="workflow/state")data=await reader.read(input,session.wallet);
          else data={...await reader.handoff(input,session.wallet),dispatch:this.#services?.workflowVerification?"contributor_admission_required" as const:"unavailable" as const};
          if(this.sessions.resolve(token)?.sessionId!==session.sessionId)throw new WalletAuthError("authentication_required",401);
          this.reply(response,applicationReply(applicationRequestId(),"unknown",null,200,data,reader.provenance));
        } else if (walletAction) {
          const reviewer = this.#services?.walletReview;
          if (!reviewer) throw new WalletAuthError("wallet_review_unavailable", 503);
          const value = input as any;
          const keys = walletAction === "review" ? ["apiVersion","cluster","operation","workflow"]
            : ["confirm","validate"].includes(walletAction) ? ["apiVersion","cluster","reviewId","wireBase64"] : ["apiVersion","cluster","reviewId"];
          if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
            || value.apiVersion !== APPLICATION_API_VERSION || value.cluster !== "devnet") throw new WalletAuthError("invalid_request",400);
          if (walletAction !== "review" && (typeof value.reviewId !== "string" || !/^[a-f0-9-]{36}$/.test(value.reviewId))) throw new WalletAuthError("invalid_request",400);
          const data = walletAction === "review" ? await reviewer.review({operation:value.operation,workflow:value.workflow},session.wallet)
            : walletAction === "validate" ? {kind:"wallet_execution_signature" as const,signature:reviewer.validateSigned(value.reviewId,session.wallet,value.wireBase64).signature,liveExecution:false as const}
            : walletAction === "confirm" ? await reviewer.confirm(value.reviewId,session.wallet,value.wireBase64)
            : (await reviewer.revalidate(value.reviewId,session.wallet), {kind:"wallet_execution_revalidation" as const,liveExecution:false as const,state:"ready_for_review" as const});
          if (this.sessions.resolve(token)?.sessionId !== session.sessionId) throw new WalletAuthError("authentication_required",401);
          this.reply(response,applicationReply(applicationRequestId(),"unknown",null,200,data,"unverified_devnet_rpc"));
        } else this.reply(response, applicationReply(applicationRequestId(), "unknown", null, 200,
          prepareWorkflow(input, session.wallet), "unsigned_finance_client"));
      } else if (auth) {
        if (path.endsWith("/logout")) {
          if (!this.sessions.resolve(token)) throw new WalletAuthError("authentication_required", 401);
          const input = await this.body(request);
          // Logout accepts the same explicit version/Devnet envelope, no role or token fields.
          if (!input || typeof input !== "object" || Array.isArray(input)
            || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["apiVersion", "cluster"])
            || (input as any).apiVersion !== APPLICATION_API_VERSION || (input as any).cluster !== "devnet")
            throw new WalletAuthError("invalid_request", 400);
          this.sessions.revoke(token); response.setHeader("set-cookie", sessionCookie("", true));
          this.reply(response, applicationReply(applicationRequestId(), "authentication", null, 200, Object.freeze({ kind: "wallet_logout", revoked: true }), "wallet_signature_session"));
        } else if (path.endsWith("/challenge")) {
          const issued = this.sessions.issue(await this.body(request), request.headers.origin!, readChallengeCookie(request.headers.cookie));
          response.setHeader("set-cookie", challengeCookie(issued.requesterToken));
          this.reply(response, applicationReply(applicationRequestId(), "authentication", null, 200, issued.view, "server_challenge"));
        } else {
          const result = this.sessions.verify(await this.body(request), request.headers.origin!, readChallengeCookie(request.headers.cookie));
          response.setHeader("set-cookie", sessionCookie(result.token));
          this.reply(response, applicationReply(applicationRequestId(), "authentication", result.view.sessionId, 200, result.view, "wallet_signature_session"));
        }
      } else {
        if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0"))
          throw new WalletAuthError("invalid_request", 400);
        if (!this.sessions.resolve(token)) throw new WalletAuthError("authentication_required", 401);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(match![1]!)) throw new WalletAuthError("invalid_request", 400);
        id = match![1]!; resource = (match![2] ?? "job") as ApplicationResource;
        if (!this.#services) throw new WalletAuthError("application_unavailable", 503);
        const services = this.#services;
        // Each request captures its cookie. Revocation/expiration is rechecked by ApplicationQueries.
        const authentication = { resolve: async () => {
          const s = this.sessions.resolve(token);
          return s ? { subject: "wallet_" + s.sessionId, role: "wallet", wallet: s.wallet } : null;
        } };
        const query = new ApplicationQueries(services.store, { timeoutMs: services.timeoutMs, authentication,
          ...(services.chain ? { chain: services.chain } : {}) });
        this.reply(response, await query.read({ apiVersion: APPLICATION_API_VERSION, cluster: "devnet", resource, jobId: id }));
      }
    } catch (e) {
      const error = e instanceof WalletAuthError ? e : new WalletAuthError("application_unavailable", 503);
      // Close rejected requests rather than retain unread/stalled attacker bodies on keep-alive.
      response.setHeader("connection", "close"); response.once("finish", () => request.destroy());
      this.reply(response, fail(error.code, error.status));
    } finally { this.#active--; }
    return true;
  }
}
