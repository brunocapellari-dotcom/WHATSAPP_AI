# GO-LIVE STATUS — WhatsApp AI

Updated: 2026-10-09

## Official release target

**ZERO-COST LOCAL** is the official first GO-LIVE target.

Paid GCP infrastructure is no longer a release dependency. Cloud Run, Cloud SQL,
Cloud Armor and the external Load Balancer remain available as an optional
post-release deployment profile.

| ID | Task | Priority | Status | Dependency | Acceptance | Evidence / blocker |
|---|---|---:|---|---|---|---|
| WA-001 | Signed provider-independent webhook | P0 | DONE | none | invalid signature/replay rejected | CI regression |
| WA-002 | Encrypted raw persistence | P0 | DONE | local PostgreSQL | raw payload encrypted + provenance retained | PostgreSQL integration tests |
| WA-003 | Freight parser / quality gate | P0 | DONE | none | incomplete data is never invented | CI regression |
| WA-004 | UPDATE/CANCELLATION/dedup | P0 | DONE | none | deterministic, tenant-safe mutation handling | CI regression |
| WA-005 | PostgreSQL RLS | P0 | DONE | local PostgreSQL runtime roles | DB rejects cross-tenant access | PostgreSQL integration tests |
| WA-006 | Durable outbox + DLQ | P0 | DONE | local PostgreSQL | bounded retry, stale-claim recovery, DEAD state | CI regression |
| WA-007 | WPPConnect provider bridge | P0 | DONE | dedicated WhatsApp number | encrypted local bridge outbox, HMAC, dedup, media redaction | provider CI green before merge |
| WA-008 | Metadata-only attachment boundary | P0 | DONE | none | no unscanned media bytes enter parsing | security regression |
| WA-009 | Zero-cost local compose | P0 | TESTING | Docker/Compose on existing machine | PostgreSQL + migration + ingress + bridge + WPPConnect start reproducibly | current branch / CI pending |
| WA-010 | Local backup + restore drill | P0 | TESTING | WA-009 | dump hash validates and temporary restore succeeds | scripts + CI contract pending |
| WA-011 | Local AgroLog delivery | P0 | READY | AgroLog receiver running locally | signed HMAC delivery over approved local hostname | worker profile implemented |
| WA-012 | Authorized WhatsApp pairing | P0 | BLOCKED | physical phone / authorized account | dedicated account reaches CONNECTED state | human-only QR scan required |
| WA-013 | Two-run real E2E | P0 | BLOCKED | WA-009 + WA-012 + local AgroLog | two different freight messages reach AgroLog without code edits | requires local runtime + pairing |
| WA-014 | Paid GCP deployment | P2 | POST_GO_LIVE | optional budget | cloud profile remains reproducible | not required for zero-cost launch |

## Zero-cost constraints

The release must not require:

- paid cloud compute;
- managed database;
- paid load balancer/WAF;
- paid domain;
- paid WhatsApp API;
- paid observability;
- paid queue.

Existing hardware, internet and electricity are assumed available and are not
software/cloud subscription costs.

## Remaining human-only action

Pair one dedicated, authorized WhatsApp account locally. No QR, token, password
or secret may be pasted into chat.

## Final gate

GO-LIVE is declared only after:

1. local compose starts cleanly;
2. backup + non-destructive restore drill passes;
3. authorized WhatsApp is paired;
4. local AgroLog receiver uses the matching HMAC secret;
5. two different real messages complete the full pipeline without code changes.
