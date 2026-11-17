# Application API foundation

This is a read-only, Devnet/DEMO foundation. It adds public process health and an
internal authorized query layer. It does not activate operational execution or
make private application data accessible over HTTP.

## Server and routes actually registered

The existing `node:http` verifier server, loopback CLI binding, Origin rejection,
JSON response headers, no-store policy, input limits and timeouts remain in use.

| Route | Status and purpose |
| --- | --- |
| `POST /verify` | Existing GitHub-evidence verifier contract, unchanged. Its GitHub bearer token is not application wallet or operator authentication. |
| `GET /api/v1/health` | New public, non-sensitive process-health response. No database or RPC probe. Always reports limited readiness, application authentication absent, private HTTP reads unregistered and execution disabled. |

Unsupported methods on the exact health path return 405 with `Allow: GET`.
Requests containing Origin are rejected. Other `/api/` paths, including job,
milestone, execution, signing and settlement paths, return versioned 404
`route_not_registered`. Query strings are not supported. No CORS configuration,
public network binding, authenticated private routes or route-enable flag is added.

## Internal service and authorization

`ApplicationQueries` takes the existing `LifecycleStore`, explicit `timeoutMs`
(integer 1–10000), an optional trusted per-request `ApplicationAuthentication`
resolver, and an optional `ApplicationChainSource`. Its only operation is:

```ts
queries.read({
  apiVersion: "proofwork-application-api-v1",
  cluster: "devnet",
  resource: "job", // or "milestone" or "execution"
  jobId: "<existing UUID>"
});
```

The resolver must establish an authenticated subject and role from approved
credentials and trusted wallet/role mapping. This PR supplies no production
resolver, identity provider, wallet challenge protocol or session mechanism.
Absent resolution fails closed. Test resolvers are dependencies of tests only.
A supplied address, the resolver interface itself, a GitHub evidence token, or a
role string is not proof of wallet ownership. Future HTTP composition must bind
the resolver to the current request; it must not use shared mutable global
principal state. Approval and implementation of that adapter are the specific
blocker to registering private HTTP routes.

| Authenticated role | Resource authorization |
| --- | --- |
| Organization | Resolver-verified wallet equals immutable recorded job sponsor. |
| Student | Resolver-verified wallet equals immutable recorded job student. |
| Operator | Trusted operator role; wallet is null. Same safe projections, no capabilities. |

The request cannot select a principal, wallet, endpoint, privileged action or
approval flag. Extra fields and getters are rejected. Unknown jobs and another
principal's jobs share `resource_not_found`. Authorization precedes intent,
attempt and RPC reads. After awaited reads, authentication is checked again and
job/intent/attempt identity, revision and reconciliation stamps are compared.
Changed identity or state suppresses the result; there is no retry or mutation.
This is a read-consistency guard, not a transaction execution fence.

All three resources are scoped to an existing verification job. No job listing,
arbitrary milestone browsing, pre-submission dashboard or pagination is shipped.

## Reused data and safe projections

The layer reuses `jobs.getJob`, full integrity-checked intent/attempt loaders and
the existing `DevnetLifecycleReader`. Two indexed read-only lookup methods,
`transactionIntents.getForJob(jobId)` and `executionAttempts.getForIntent(intentId)`,
follow existing UNIQUE relationships and delegate to the existing replay loaders.
They expose no SQL handle and add no schema, index, migration or write path.

- Job: job identity, recorded milestone, state, verification outcome, reconciliation
  flag and safe rejected/recovery classification. Full historical verification
  results are `not_persisted`; unavailable timestamps are null.
- Execution: optional intent/attempt IDs, preparation, phase, uncertainty and
  reconciliation. Missing intent/attempt is explicit. Observation evidence is
  `test_evidence_only` or unavailable; mode is always `offline-test-model`.
  Operational execution is unavailable, live transaction ID is null and reward
  payment is `not_established`.
- Milestone: existing decoded address/parent/participants, reward mint, status,
  amount, milestone ID and available timestamps. Integers that may exceed JS
  precision use decimal strings. Account bindings, requirements and submission
  commitment must match the authorized job. Private commitment preimages,
  repository/contributor identities and evidence are not returned.

Worker/operator IDs, credential material, wire/signature bytes, blockhashes,
message policy and raw internal records are never projected. Preparation or
attestation alone never establishes payment.

## Contracts, availability and provenance

`application-api-contracts.ts` exports versioned framework-independent TypeScript
view types. Replies contain `statusCode` and a body with `apiVersion`, generated
request ID, `cluster: devnet`, resource kind/ID, availability, provenance, data,
error and constant read-only permissions. Errors contain only a stable code;
data is null. No dependency exception text, stack trace or caller request-ID
echo is returned. Returned views and envelopes are frozen.

Health is `limited` with `process_health` provenance. Successful database
projections are `available` with `lifecycle_v5_offline` provenance; available means
the projection was read, not operational readiness. Chain provenance must be
explicitly configured as `offline_fixture` or `unverified_devnet_rpc`.
An unavailable chain source/account returns an unavailable error. A decoded
account is not independent proof of program deployment or authenticated live
state: `programDeployment` is `not_verified`, and `rpcAuthenticated` and
`onChainStateVerified` remain false even when RPC-shaped observations decode.
Other operational, signing, submission, retry, reservation-release and mutation
permissions remain denied in every response.

The existing reader retains its pinned Devnet endpoint and genesis check,
classic account layout decoding, ownership/PDA/parent/state validation and
confirmed/finalized commitment requirements. No fallback endpoint is added.
All API tests mock network access; this PR makes no claim of Devnet execution,
deployment or authenticated live state.

## Stable errors

| HTTP-style status | Codes |
| --- | --- |
| 400 | `invalid_request` |
| 401 | `authentication_required`, `authentication_changed` |
| 404 | `resource_not_found`, `route_not_registered` |
| 405 | `method_not_allowed` |
| 503 | `authentication_unavailable`, `resource_changed`, `chain_reader_unavailable`, `chain_timeout`, `chain_state_mismatch`, `chain_state_unavailable`, `chain_state_invalid`, `chain_context_invalid`, `chain_unavailable`, `storage_integrity_failure`, `storage_unavailable`, `dependency_unavailable` |

Authentication failures/timeouts, unavailable storage, corrupt histories,
invalid/missing account data and dependency errors fail closed. Timeouts bound
the caller's wait; they do not cancel an underlying dependency. A late read-only
completion cannot publish a response, authorize work or cause an automatic retry.

## Configuration and next integration boundary

Public health needs no new credential or external endpoint. Existing verifier
configuration and CLI loopback restrictions remain unchanged. Internal query
composition needs an already-open v5 store, an explicit timeout and, before
private access, an approved authenticated per-request adapter with tested wallet
and operator-role mapping. Optional milestone reads need the existing reader and
an honest provenance label; the label cannot grant trust or authority.

Schema v5 and DELETE journal mode remain unchanged. Operational journal
persistence/schema v6, production custody, admission/fencing, signing,
broadcasting, submission, retries, reservation release, settlement execution and
deployment remain blocked. No new environment bypass, secret or provider is
invented. No Rust, ABI, financial policy or finance-client production code changes.

Frontend work must wait for Harshita's resource and approved authentication and
deployment policy. The internal contracts can be consumed in a future reviewed
adapter; the only new network API available now is health. Students and
organizations cannot yet fetch their private dashboard over HTTP. The next
focused task is agreeing and implementing real authentication/wallet ownership
and operator-role verification, then exposing these projections through that
boundary with HTTP authorization tests. No frontend framework is selected here.
