# Team workflow

| Owner | Responsibility |
|---|---|
| Palak | Own `settle_milestone`, `refund_unclaimed_milestone`, completion records, and settlement/refund security tests. |
| Harshita | Own `create_internship`, `create_milestone`, `fund_milestone`, the finance TypeScript client, and creation/funding tests. Own `assign_student`, `submit_milestone`, and `attest_milestone`, plus the GitHub automated verification service, verification authorization and replay protection, verification security tests, the student and verification TypeScript client, and end-to-end integration coordination. |
| Ganga | Complete frontend ownership in `apps/web/`. Own the organization and student dashboards, internship opportunities, Proof Vault, frontend UI tests, and frontend integration. |

Palak and Harshita jointly approve shared account layouts, PDA seeds, status transitions, and instruction signatures before implementing on separate feature branches. Review changes to shared interfaces together before integration. Ganga consumes stable interfaces from both blockchain developers. Private signing keys and blockchain security enforcement stay outside the frontend.

See [Shared Rust foundation](SHARED_FOUNDATION.md) for the shared modules and review boundaries.

The revised finance split above is approved by both Harshita and Palak and supersedes older all-finance assignments. Shared ABI and escrow-helper interfaces still require joint review.
