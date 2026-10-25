# Short Design: Repository Documentation Drift Synchronization

**Date:** 2026-10-25  
**Topic:** Reconciling 7 documentation drift issues across `docs/SPEC.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, and `docs/ROADMAP.md`  
**Status:** Pending Approval  

---

## 1. Intent & Why
A cross-document review of the `vyen` repository identified 7 discrepancies between the actual codebase implementation (28 TypeScript modules, Layered Settings, Policy Engine, HookBus, Windows skips, Base URL normalization) and the project's documentation. Synchronizing these documents eliminates contradictions, prevents developer/agent confusion, and preserves architectural integrity.

---

## 2. Goals & Non-Goals

### Goals
1. **Sync `docs/ROADMAP.md`:** Mark Phase 1 (0.5.0) items as completed (Settings, Policy, Hooks), update module count from 25 to 28, and clarify that 5 platform test cases are cleanly skipped on Windows with `npm test` exiting 0.
2. **Clarify Subagent Lifecycle in `docs/SPEC.md` & `AGENTS.md`:** Distinguish between child session lifecycles (subagents have dedicated stores and trigger `endSession()` to clean up) and ephemeral nested runners (workflows, Agent Network) which set `sessionLifecycle = false` to suppress global lifecycle events.
3. **Update Versions & Release Notes:** Change `docs/SPEC.md` header to `# Vyen CLI` (version-agnostic) and add comprehensive 0.4.0 release notes in `CHANGELOG.md` covering settings, policy, hooks, trust-workspace, and gateway warning.
4. **Document Language Policy in `AGENTS.md`:** Explicitly note in §5 that `README.md` and `CHANGELOG.md` are maintained in Vietnamese, while code, comments, specs, tests, and commit messages are in English.
5. **Sync Security Details:** Update `README.md` to state that `--trust-workspace` applies to both `permissions.allow` and `hooks`; document gateway `/v1` normalization in `docs/SPEC.md`.
6. **Fix Document Indexing & Links:** Add `docs/MCP.md`, `docs/AUDIT.md`, and `docs/ROADMAP.md` to `AGENTS.md` §4; fix the relative link to `docs/REFERENCE_REVIEW.md` in `docs/SPEC.md`.

### Non-Goals
- Changing functional code in `src/*.ts`.
- Rewriting historical plans under `docs/superpowers/plans/`.

### Anti-Goals
- Breaking the strict character budget in `AGENTS.md` + `AGENT_LEARNINGS.md` ($\le 23,000$ characters) enforced by `tests/repo-hygiene.test.mjs`.

---

## 3. Constraints
- **Character Budget:** `AGENTS.md` + `AGENT_LEARNINGS.md` combined length must stay at or below 23,000 characters. To add the language exception, docs listing, and lifecycle clarifications, existing prose in `AGENTS.md` must be tightened by ~150-200 characters.
- **Verification Gates:** `npm run lint`, `npm run typecheck`, and all tests in `tests/*.test.mjs` must remain completely green with 0 errors.

---

## 4. Approaches Considered

- **Approach 1 (Selected):** Comprehensive, single-pass synchronization of all 5 files (`docs/SPEC.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/ROADMAP.md`).
  - *Tradeoff:* Completely resolves all 7 drift points in one consistent commit, ensuring no intermediate inconsistent state.
- **Approach 2 (Rejected):** Phased update (governance files first, history files second).
  - *Tradeoff:* Leaves documentation inconsistent between phases.

---

## 5. Specification of Changes

### A. `docs/SPEC.md`
- Change title to `# Vyen CLI`.
- Under Session Lifecycle / Owners: Explicitly distinguish subagent child sessions (which own a `SessionStore` and invoke `endSession()`) from ephemeral nested runners (Agent Network, workflow steps with `sessionLifecycle = false`).
- Under Configuration / Gateway: Document that `/v1` is automatically appended to URLs whose hostname is `api.yuristore.xyz`, `localhost:8000`, or `127.0.0.1:8000` when the path is empty.
- Fix reference: replace `See REFERENCE_REVIEW.md` with `See [REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md)`.

### B. `AGENTS.md`
- In `## 4. Docs`: Add `docs/MCP.md`, `docs/AUDIT.md`, `docs/ROADMAP.md`.
- In `## 5. Language`: Add note that `README.md` and `CHANGELOG.md` are maintained in Vietnamese.
- In `§3.4`: Clarify subagent child sessions vs ephemeral nested runners (`sessionLifecycle = false`).
- Compact slightly verbose phrasing across sections to ensure `AGENTS.md` length decreases net by at least 150 characters, ensuring combined length $\le 22,850$ characters.

### C. `README.md`
- In the Workspace Trust section, clarify that `--trust-workspace` is required to activate both `hooks` and `permissions.allow` from `.vyen/settings.json`.

### D. `CHANGELOG.md`
- Add a new section `## [0.4.0]` (or enhance current entry) with full details on Layered Settings (`.vyen/settings.json`), Permissions (`allow`, `ask`, `deny`), Lifecycle Hooks (`PreToolUse`, `PostToolUse`), `--trust-workspace`, and default gateway warning.

### E. `docs/ROADMAP.md`
- Update module count in Section 1.1 and R0.8 from 25 to 28 modules.
- In Section 1.1, mark Phase 1 as completed.
- In Section 1.1, 8.1, and Appendix A, update test status to reflect that 5 platform cases (POSIX mode bits and symlinks) are cleanly skipped on Windows (`process.platform === 'win32'`) and `npm test` exits 0 with 0 failures.
