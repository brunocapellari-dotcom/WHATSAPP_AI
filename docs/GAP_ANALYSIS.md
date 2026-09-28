# Gap Analysis — current release candidate

The repository started empty. The current branch contains the complete production-oriented foundation; `EXISTE` means implemented in code, not yet release-validated.

| Capability | Status | Remaining gate/evidence |
|---|---|---|
| Architecture/backend/database | EXISTE | Full Release Gate on committed lockfile |
| Zero-cost runtime policy | EXISTE | Full config/test gate |
| WPPConnect existing-group path | EXISTE / REAL SESSION UNVERIFIED | Authorized live login, reconnect, media and reconciliation soak test |
| Meta adapter | OPTIONAL / DISABLED IN ZERO-COST | Only validate if owner explicitly enables non-zero-cost mode |
| Durable webhook inbox/quarantine | EXISTE | Full DB integration/restart gate |
| Multi-tenancy/RLS/FKs | EXISTE | Same-candidate PostgreSQL integration gate |
| Business tools/CRM | EXISTE | Real tenant catalog/ERP data before commercial use |
| Post-tool response synthesis | EXISTE | Local model E2E on real catalog |
| Human handoff suspension | EXISTE | Operator API E2E/staging |
| Operator queue/claim/release/resume/close | EXISTE | Local token/RBAC implemented; validate full HTTP E2E and real operator workflow |
| Operator manual replies | EXISTE | Real provider delivery/uncertainty staging |
| Financial/irreversible approval workflow | EXISTE | Operator approval E2E on real business data |
| Follow-up scheduling/delivery | EXISTE | Real provider scheduled delivery soak test |
| Multimodal | EXISTE / LOCAL | Real Qwen3-VL/whisper/Poppler/ClamAV staging |
| Spreadsheet/DOCX isolation | EXISTE | Full build/security gate |
| Freight extraction/dedup | EXISTE | Expand golden corpus with authorized real messages |
| IBGE municipalities | EXISTE | Execute/update sync on real candidate DB |
| RFB companies | SELECTIVE IMPORT CONTRACT EXISTS | Full national mirror intentionally not default because of very large footprint; ingest curated/needed official company subsets without personal QSA data |
| ANTT/RNTRC carriers | EXISTE / OFFICIAL SYNC | CKAN datastore sync implemented; run against current snapshot and validate live volume/schema in Release Gate environment |
| Canonical catalog global-write governance | EXISTE | RLS integration gate |
| Canonical entity fuzzy resolution | EXISTE | `pg_trgm` exact/fuzzy/fallback corpus gate; expand authorized aliases and ambiguity cases |
| AgroLog local export | EXISTE | Downstream importer/contract test with AgroLog |
| AgroLog HTTP gateway | OPTIONAL | Internal-only in zero-cost; not release dependency |
| Observability | EXISTE / LEAN | Metrics/logs now; tracing stack only after measured need |
| Backup/restore | IMPLEMENTED | Release Gate restore rehearsal must pass |
| SAST/secrets/vuln/SBOM | CONFIGURED | Semgrep/Gitleaks/Trivy/npm audit must pass together |
| CI | SELF-HOSTED CONFIGURED | Requires owner's self-hosted runner or direct local `npm run release:gate` |
| Reproducible dependencies | BLOCKER | Generate and commit `package-lock.json`, then use `npm ci` |
| Operator visual console | NOT REQUIRED FOR CURRENT BACKEND GATE | Add only when UI improves real operator workflow |
| Operator authentication/RBAC | EXISTE / LOCAL | Hashed tenant-bound tokens with OPERATOR/SUPERVISOR/ADMIN; external SSO is optional only if remote/multi-user UI later justifies it |
| Container hardening | EXISTE | Compose validation + runtime smoke test on target host |
| Documentation | EXISTE / UPDATED | Keep synchronized with architecture changes |

## Current P0 blocker

**The only known release-mechanics blocker that prevents objective whole-project validation here is the missing committed `package-lock.json` plus the absence of an available self-hosted runner/local Docker environment in this session.**

No release may be labeled operational from mocks or code review alone.

## Next execution sequence

1. On a network-enabled owned machine: `npm run lock:prepare`.
2. Review and commit `package-lock.json`.
3. Run `npm run release:gate`.
4. Fix every finding.
5. Restart the entire gate from zero after every code/dependency/migration change.
6. Start the local Compose stack.
7. Execute authorized WPPConnect real-session tests: login/reconnect, text, group, media, duplicate/replay, outage/recovery.
8. Execute local AI/multimodal corpus: text, image, audio, PDF, XLSX, DOCX.
9. Issue/revoke real local operator tokens, then exercise handoff, manual reply, supervisor approval and follow-up flows against the real provider.
10. Verify AgroLog NDJSON import and backup restore.
11. Merge only when the same candidate passes all mandatory rows in the Acceptance Matrix.
