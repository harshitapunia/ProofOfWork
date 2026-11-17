# Wallet-authenticated read-only application API

**IMPLEMENTED:** explicit, single-process server composition for wallet login and
private reads. **TESTED OFFLINE:** real Ed25519 proofs from disposable in-memory
test keys, real temporary v5 stores and existing account decoders, loopback HTTP
and mocked RPC. **NOT PRODUCTION-APPROVED:** protocol, public origin, TLS, hosting,
session persistence and deployment policy still require team review/approval.

The default CLI and `createVerifierServer(service)` continue to register only
`POST /verify` and public `GET /api/v1/health`. They do not construct this feature.
There is no environment activation flag, caller-provided approval switch,
localhost authentication bypass or automatic deployment change.

## Authentication protocol and challenge

`WalletSessions` is constructed by trusted server composition with explicit
`{origin, domain, cluster: "devnet"}`. Origin must be a canonical HTTPS origin,
with no credentials/path/query/fragment; domain must exactly equal its host.
No real public origin is selected by this PR. Reserved example domains occur
only in offline tests. An injectable clock is a trusted test dependency, never
request input; the default is the server clock. Clock rollback clears all
challenges/sessions and fails closed.

The protocol uses a strict raw-message subset of
[Sign In With Solana](https://github.com/phantom/sign-in-with-solana): domain and
wallet, a fixed ProofOfWork read-only login statement, URI, Version 1, Chain ID
`solana:devnet`, a 256-bit random alphanumeric nonce, issue/expiration times and
request ID. Challenge ID and nonce are the same server-generated random value.
The challenge response supplies both `signInInput` and exact UTF-8 message text.
It is public login context, not a signing or execution authorization capability.

Only the server-retained original message is accepted. The client base64-encodes
the exact returned UTF-8 bytes and the 64-byte Ed25519 signature. A wallet choosing
a different address must obtain a new challenge. Noncanonical base64, altered
bytes, wrong keys, missing nonce, extra fields, transaction-shaped messages,
other clusters, unknown IDs and expired/consumed challenges reject. No parser
normalizes a client-authored login message. Raw Ed25519 SIWS text is the only
supported format; OCMS envelopes, hardware-wallet transaction fallbacks and
arbitrary transaction signatures are not supported.

Verification uses the existing resolved `@noble/curves@1.9.7`, now an explicit
pinned verifier dependency. Strict `zip215:false` verification and non-small-order,
torsion-free public keys are required. No custom curve/signature arithmetic is
implemented. No dependency version is upgraded. See the library's
[verification semantics](https://github.com/paulmillr/noble-curves/tree/1.9.7#ed25519)
and Solana's [server verification guidance](https://solana.com/docs/frontend/messages-and-auth).
Operational signer/simulation/protocol modules are not reused for login authority.

## Expiration, replay and bounds

- Challenge TTL: 120 seconds, rejecting at the exact deadline.
- At most 256 live challenges and four per wallet. No live challenge is evicted
  to make room. Expired entries are pruned on use.
- At most 60 issuance calls and 120 proof calls per fixed server-minute window,
  including malformed requests that reach those operations. This is a bounded
  single-instance guard, not approved public edge rate limiting.
- A well-shaped proof with a known challenge ID consumes it before proof
  validation/session insertion. Failed signatures and capacity failures cannot
  reuse it. Malformed shapes do not run cryptographic verification. Context
  failures cannot consume another origin's challenge.
- Lookup, consumption, cryptographic verification and session creation contain
  no await, so simultaneous duplicate proofs have exactly one winner in one JS
  process. No distributed/process-shared replay guarantee is claimed.
- At most 256 sessions, without live-session eviction. Session TTL is 300 seconds,
  fixed from login; reads do not extend it.
- New HTTP JSON bodies are bounded to 8192 bytes and two seconds. At most 16
  concurrent recognized requests are admitted by one handler. Rejected bodies
  close their connection. Existing server header/request timeouts remain.

Unauthenticated callers can exhaust these global budgets and cause temporary
unavailability. Do not expose this review composition publicly without approved
edge limits, connection controls, monitoring and deployment configuration.
No client-IP/proxy trust assumption, global registry or new SQL table is added.

## Sessions and browser policy

After a valid signature, a fresh 256-bit random token is delivered **only** in a
`__Host-proofwork_session` cookie with `Secure; HttpOnly; SameSite=Strict; Path=/`
and `Max-Age=300`, no Domain. There is no JSON token field or token query transport.
The public session view contains wallet, authentication method, random non-secret
session ID, original origin/domain/Devnet context and authentication/expiry times.
The map retains only a SHA-256 token lookup key and that context, never raw tokens.
Responses and errors do not echo Cookie/Authorization headers, proof bytes or
private material. No application logging of credentials is introduced.

Login and logout require exact configured Origin and Host. Private GETs permit
an absent Origin (normal same-origin browser GET), but any supplied Origin must
match exactly. A supplied Sec-Fetch-Site must be `same-origin`. Duplicate
Host/Origin/Cookie/Authorization headers, ambiguous duplicate session cookies,
Forwarded and forwarded-host/proto headers reject. Reverse-proxy trust is not
implicitly enabled. Authorization bearer headers are not accepted by these
routes, including GitHub bearer credentials.

No CORS allow-origin/credentials headers or permissive preflight is added.
Cookies need a real same-origin HTTPS browser deployment; there is no insecure
cookie option. Offline HTTP tests send the cookie header manually over loopback
to exercise handlers; they do not claim browser/TLS deployment validation.
Use no localStorage/sessionStorage token storage. HttpOnly limits direct token
theft by scripts but cannot make a compromised same-origin application safe.
Logout is POST-only with exact-Origin CSRF protection, revokes server state and
clears the cookie. Browser expiry is not the security boundary: server expiry and
revocation are checked for every read and again after awaited query operations.

Restart loses all challenges and sessions; stale cookies fail closed. There is no
refresh, persistent login, cross-process revocation or distributed storage. Sharing
a single instance between different application origins is unsupported.

## Request identity and authorization

`WalletApplicationHttp` receives actual WalletSessions and optionally the existing
LifecycleStore, query timeout and existing chain reader. Pass it as the second
argument to `createVerifierServer` only in separately reviewed trusted composition.
The default CLI does not do so, and this PR does not create a new deployable entry
point or public listener. Supplying a class/configuration is not production approval.

Each read creates ApplicationQueries with a resolver that captures only that
request's cookie. It resolves current session state each time; there is no shared
mutable principal variable. The new internal `wallet` principal means verified
wallet ownership only. ApplicationQueries authorizes it per job when wallet equals
the immutable sponsor or student; it confers neither a global organization/student
identity nor operator privileges. Existing trusted internal role interfaces remain
compatible. HTTP never resolves an operator or trusts requested roles.

Existing query validation, safe projections, unknown/unauthorized 404 behavior,
full storage-history checks and post-await principal/revision consistency checks
remain. No query/state-machine logic is duplicated in the HTTP layer. Closed or
missing services fail 503. No raw DB handles/records, private verification preimages,
protected execution evidence or internal authorization capabilities are exposed.

## Actual registered routes

The following routes exist **only in explicit WalletApplicationHttp composition**:

| Method and path | Input / result |
| --- | --- |
| POST /api/v1/auth/challenge | Exact `{apiVersion, cluster, wallet}`; returns server challenge and SIWS input. |
| POST /api/v1/auth/verify | Exact `{apiVersion, cluster, challengeId, messageBase64, signatureBase64}`; returns safe session view and secure cookie. |
| POST /api/v1/auth/logout | Session cookie and exact `{apiVersion, cluster}`; revokes and clears cookie. |
| GET /api/v1/jobs/:jobId | Session cookie; existing authorized verification-job view. |
| GET /api/v1/jobs/:jobId/milestone | Session cookie; existing authorized decoded milestone view. |
| GET /api/v1/jobs/:jobId/execution | Session cookie; existing offline-execution projection. |

API version is `proofwork-application-api-v1`, cluster is `devnet`. Query strings
are not supported and do not authenticate. Unsupported methods return 405/Allow;
unregistered paths return 404. New replies reuse the existing versioned envelope,
request IDs, no-store/JSON/nosniff headers and constant denied operational permissions.
Auth projections add `authentication` resource and server-challenge/session provenance.
Health stays public/limited and does not probe DB/RPC; explicit composition reports
wallet authentication/read-route registration, while the default reports them absent.
Legacy POST /verify, its independent GitHub evidence authentication, body limits
and loopback CLI behavior are unchanged. Operator, sign, send, retry, reservation,
settlement, write, administration and listing routes remain unregistered everywhere.

Invalid input/context is 400; missing/expired/revoked session or bad proof is 401;
unknown/unauthorized resources are indistinguishable 404s; unsupported method is
405; body timeout 408; oversized streaming body 413; auth rate limit 429; missing
services/capacity/dependency failure is 503. Stable auth codes include
`authentication_required`, `authentication_failed`, `authentication_capacity`,
`authentication_rate_limited`, `authentication_unavailable`, `application_capacity`,
`application_unavailable`, `invalid_request`, `request_too_large`, `request_timeout`,
and `method_not_allowed`; existing query error codes remain unchanged. No stack,
credential, exception message or partially authorized data is returned.

## Preserved blockchain and storage boundaries

Existing Devnet endpoint/genesis, program identity, PDA/account decoders and
finance bindings remain. Fixture state remains `offline_fixture`; unverified RPC
observations remain unverified. Missing accounts return unavailable and no deployed
program, authenticated live state, payment or settlement is invented. Authentication
is not transaction signing permission. Signing/submission/retry/release flags stay
denied. No signer, sender, RPC write, token operation or deployment is introduced.

Schema v5, DELETE/EXTRA, permanent operation identity, operational journal model,
execution/reconciliation logic, finance-client serialization, Rust/ABI/PDA/financial
policies and all six pinned CI jobs remain. No migration, new database or session
table is added. Actual local/hosted totals and CodeRabbit outcomes are recorded in
the delivery report; historical counts are not a claim of production execution.

## Activation blockers and next work

Before any production/public activation, obtain explicit approval for this login
protocol, actual public application origin/domain, TLS, cookie/session policy,
persistence/retention and restart behavior, multi-instance challenge/revocation
guarantees, trusted reverse proxies, edge connection/rate limits, logging/audit and
monitoring, operator identity policy, and deployment itself. None is inferred from
Harshita's authorization to implement and review this PR. No Palak approval is
invented; shared Rust/ABI/financial definitions are untouched.

The implemented composition is useful for offline backend integration review.
Browser/frontend readiness still needs Harshita's frontend resource, approved
same-origin HTTPS hosting and a reviewed wallet signIn/signMessage integration,
CSRF/cookie behavior tests in that deployment, expiry/logout UX and a decision on
multi-instance operation. No frontend design system or code is implemented here.
Dashboard listings and pre-job models remain separate product work. Operational
custody/signing, authenticated live provenance, journal persistence and settlement
execution remain separately blocked.
