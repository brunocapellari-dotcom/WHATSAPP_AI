# WHATSAPP_AI — mandatory agent execution contract

**Current delivery: freight reports only.** Use PR #18 as the canonical
product implementation, not default-branch code. OCI deployment work is
on PR #21 (verify the current PR number before assuming it). Do not
work on news or NIVON.

## Every autonomous session must produce useful work

1. Check latest remote commit and CI **once**. Read only affected paths.
2. Pick **one** highest-impact runnable task from the active delivery
   queue. Do not begin with a repository-wide architecture survey.
3. Make a real code/infrastructure change, add targeted tests, run them.
4. Commit to your assigned branch and publish it. Include SHA and test
   evidence in the final response. Stop after this bounded deliverable.
5. If blocked by a missing login/QR, record it and finish any independent
   work; do not repeatedly ask for the same authorization.

## Ownership

- **Implementation agent (Codex by default):** develop and test one
  narrowly specified task. Prefer short prompts and a bounded execution.
- **Claude Code:** only for an isolated blocker or a specific review
  requested after concrete implementation; **never** unlimited
  repository-wide recurring audits.
- One agent per worktree/branch. Never concurrently edit the same files.

## Financial and external-side-effect limits

- OCI creation is authorized only after **verifying** tenant home
  region, available permanent Always Free quota, existing resources and
  absence of charges. A free trial credit or an Always Free eligibility
  badge is not itself proof. Otherwise stop the cloud action.
- Do not upgrade, buy services, use a billable resource, merge to main,
  delete existing data, access unauthorized WhatsApp groups, or send real
  WhatsApp messages without the required separate authorization.
- No credentials, tokens, QR images, messages, exports, Terraform
  state/plan, or private keys may be committed or copied into chat/CI.

## Current completion priority

1. OCI Terraform **validate** green; first safe deployment only after
   live-account preflight, then SSH and Docker runtime.
2. Native ARM64 WPPConnect image build and observed health.
3. Authorized QR pairing and live inbound freight sample.
4. End-to-end database, reports, encrypted backup/restore.
5. Explicitly consented outbound test, then full go-live gate review.

**Proof standard:** code or green CI != deployed or running. Always state
the difference. Maintain single-issue focus; no automatic 50-task loops.
