# SPRINT7_PROMPT_P0_IMPROVEMENTS.md

Use `MASTER_AGENT_GUIDE.md` as the primary execution contract. If any rule here conflicts with `MASTER_AGENT_GUIDE.md`, follow the stricter rule. If `MASTER_AGENT_GUIDE.md` is missing in your workspace, fall back to `.codex/AGENTS.md`, `AGENT_APP_SWAP.md`, and this file.

## Task Goal

Fix the **P0 backup-system architecture and correctness issues** so the backup subsystem is safe to run in production, especially when deployed as a **separate `backup-worker` container** that must not degrade or interfere with the main `app` request path.

This sprint is **not optional cleanup**. Treat it as production-blocking work.

---

## Required Reading Order

Read these files first, in order:

1. `MASTER_AGENT_GUIDE.md`
2. `.codex/AGENTS.md`
3. `docs/BACKUP_SYSTEM_PLAN.md`
4. `AGENT_APP_SWAP.md`
5. `compose.apps.yml`
6. `.env.example`
7. `services/s3proxy/src/config.js`
8. `services/s3proxy/src/db.js`
9. `services/s3proxy/src/index.js`
10. `services/s3proxy/src/backupRunner.js`
11. `services/s3proxy/src/backup/backupManager.js`
12. `services/s3proxy/src/backup/backupJournal.js`
13. `services/s3proxy/src/backup/backupWorker.js`
14. `services/s3proxy/src/backup/destinations/index.js`
15. `services/s3proxy/src/backup/destinations/localDest.js`
16. `services/s3proxy/src/backup/destinations/mockDest.js`
17. `services/s3proxy/src/routes/backup.js`
18. `services/s3proxy/src/routes/health.js`
19. `services/s3proxy/src/routes/metrics.js`
20. `services/s3proxy/test/backup-system.test.js`
21. Any other tests or docs touched by your changes.

Do not start coding until you have read the above.

---

## Sprint Scope

You must fix all items below in one pass. Do not intentionally leave partial work.

### P0-A. Separate-worker topology must be correct and safe

Current repo has both `app` and `backup-worker` services, but the environment wiring is inconsistent and can cause wrong runtime topology.

You must make the deployment model explicit and safe:

1. **Production default topology**
   - Main `app` service must keep backup HTTP/admin routes available.
   - Long-running backup execution must be owned by `backup-worker` when the worker profile is enabled.
   - The main `app` process must not accidentally become the worker just because backup env vars are present.

2. **Env contract**
   - Normalize and document the enable flags.
   - Remove ambiguous dual-switch behavior between `S3PROXY_BACKUP_ENABLED` and `BACKUP_SYSTEM_ENABLE` unless there is a clear documented purpose.
   - Choose one clear model and apply it consistently in:
     - `.env.example`
     - `compose.apps.yml`
     - `services/s3proxy/src/config.js`
     - relevant docs

3. **Expected behavior**
   - If backup routes are enabled on `app`, creating a job must not require the `app` process itself to do the long-running work.
   - If the `backup-worker` profile is not running, behavior must be explicit and documented.
   - Do not create a silent split-brain or a configuration where both containers may independently poll and process the same pending job without coordination.

### P0-B. Introduce safe job-claiming / worker ownership

Current backup processing logic uses `getPendingJob()` and immediately processes the row without a real ownership/claim protocol.

You must add a minimal safe ownership model so that concurrent processes do not race on the same job.

Requirements:

1. Add a worker/job claim mechanism to SQLite-backed job state.
2. A worker must atomically transition a job from `pending` to `running` with ownership metadata.
3. Store enough metadata to debug ownership, at minimum:
   - `running_instance_id` or equivalent
   - `heartbeat_at` or equivalent timestamp
4. Prevent two workers from processing the same job concurrently.
5. Add a stale-job recovery rule that is **time-based**, not unconditional.
6. Never reset a running job back to pending just because a process started.

If schema changes are needed, update `services/s3proxy/src/db.js` safely and idempotently.

### P0-C. Background worker must be durable and intentionally long-lived

The `backup-worker` container must behave like a proper daemon loop.

Requirements:

1. `services/s3proxy/src/backupRunner.js` must stay alive intentionally.
2. It must not rely on fragile timer behavior that may terminate the process unexpectedly.
3. It must log startup mode clearly.
4. It must surface polling/claim failures clearly in logs.
5. It must continue polling after recoverable errors.
6. It must support graceful shutdown.

### P0-D. Long-running backup execution must not block admin request path

The backup plan says backup runs in background. Preserve that.

Requirements:

1. `POST /admin/backup/jobs` must remain a fast enqueue/create operation.
2. No long object-copy loop may run inline inside the HTTP request lifecycle.
3. If you add new administrative actions, keep them asynchronous unless they are truly lightweight.

### P0-E. Add missing pause/resume-safe processing semantics in job execution

Current processing logic loads routes and starts copy tasks, but it does not have a robust resume/ownership model.

You must make job execution safer:

1. Persist meaningful progress while the job is running.
2. Update heartbeat/ownership during execution.
3. On restart, allow only stale claimed jobs to be recovered.
4. Keep cancellation behavior correct.
5. Do not regress existing successful end-to-end backup flow.

### P0-F. Path traversal hardening for destination keys

Current destination key construction uses raw backend keys inside a filesystem-like path.

You must harden path/key generation so that malicious or weird object keys cannot escape the intended backup root or generate unsafe archive paths.

Requirements:

1. Sanitize or encode path segments used by local filesystem destinations.
2. Preserve the ability to map back to the original backend key.
3. Do not silently collapse distinct object keys into the same destination path.
4. Keep mock/local destination behavior testable.

### P0-G. Fix and strengthen tests so they reflect actual behavior

The backup test suite must validate the new contract instead of the old assumptions.

Requirements:

1. Update `services/s3proxy/test/backup-system.test.js` to match the real runtime contract.
2. Add tests for:
   - job creation + async processing
   - single-worker claim behavior
   - no double-processing for the same job under repeated polling attempts
   - progress persistence
   - cancel behavior if applicable
   - destination path safety for suspicious backend keys
3. Keep tests deterministic and self-contained.
4. Do not rely on external services.

---

## Important Non-Goals

Do **not** spend this sprint on these unless directly required to complete P0 safely:

- Full restore system
- Full backend migration system
- Admin UI redesign
- New destination adapters beyond current repo scope
- Performance polishing that is not required for correctness

If you must touch adjacent code to keep the system coherent, keep changes minimal and explain why.

---

## Detailed Expectations By File

### `compose.apps.yml`

You must:

- Make the worker/app topology explicit.
- Ensure env naming is coherent.
- Avoid a configuration where the main app unintentionally acts as the worker.
- Keep service name `app` unchanged.
- Keep `backup-worker` as a separate service/profile if that is the chosen production path.

### `.env.example`

You must:

- Document the backup flags clearly.
- Remove ambiguity between route enablement and worker execution enablement if present.
- Add comments that explain how to run:
  - app-only
  - app + backup-worker

### `services/s3proxy/src/config.js`

You must:

- Centralize the env contract.
- Avoid hidden defaults that cause production surprises.
- Expose the fields needed for ownership/heartbeat/stale timeout if introduced.

### `services/s3proxy/src/db.js`

You must:

- Add any required job ownership / heartbeat columns.
- Keep migrations idempotent.
- Add useful indexes if needed for worker polling.

### `services/s3proxy/src/backup/backupJournal.js`

You must:

- Make this the source of truth for job claim/update semantics.
- Add functions for atomic claiming, heartbeats, and stale recovery if appropriate.
- Keep state transitions explicit and safe.

### `services/s3proxy/src/backup/backupManager.js`

You must:

- Stop using naive `getPendingJob()` processing as the only coordination mechanism.
- Use the journal/DB claim flow.
- Ensure processing updates heartbeats and progress.
- Ensure completion/failure/cancel transitions cleanly release ownership.

### `services/s3proxy/src/backupRunner.js`

You must:

- Make the loop lifecycle robust.
- Handle shutdown and retries explicitly.

### `services/s3proxy/src/backup/backupWorker.js`

You must:

- Preserve streaming behavior.
- Keep retry logic sane.
- Keep ledger updates correct.
- Ensure path sanitization / destination key handling is safe.

### `services/s3proxy/src/routes/backup.js`

You must:

- Keep request path lightweight.
- Return clear status for job creation and cancellation.
- If worker execution is unavailable by configuration, return a clear, truthful response instead of pretending the job will be processed.

### `services/s3proxy/test/backup-system.test.js`

You must:

- Rewrite/assert behavior against the real async job model.
- Cover job claiming and no-double-processing.

---

## Acceptance Criteria

All of the following must be true before you mark the task complete:

1. A backup job can be created through the API without running the object-copy loop inline in the request.
2. The `backup-worker` process can poll repeatedly and stay alive.
3. Two worker loops cannot both process the same pending job successfully.
4. Job ownership and heartbeat are persisted and observable in SQLite state.
5. Stale running jobs are only recoverable after the defined timeout.
6. Path traversal via crafted object keys is blocked.
7. Tests are updated and pass for the changed backup behavior.
8. Docs/env comments reflect the actual runtime model.
9. `.opushforce.message` is updated according to project rules.

---

## Validation Commands

Run all commands that are relevant and report exact results.

Required minimum:

```bash
npm run dockerapp-validate:compose
npm --prefix services/s3proxy test
```

Also run if touched:

```bash
npm run dockerapp-validate:env
```

If any command cannot run, state the exact reason and whether the blocker is environmental or code-related.

---

## Implementation Notes

- Prefer small, composable functions over hidden side effects.
- Do not fake atomic behavior in JavaScript if it must be enforced in SQLite.
- Be honest about any limitation you could not close.
- Keep naming consistent with the existing codebase style.
- Do not leave dead code paths or half-implemented flags.
- Do not silently swallow backup ownership errors.

---

## Output Contract

Return only:

1. `RESULT: OK` or `RESULT: BLOCKED`
2. `CHANGED_FILES: <comma-separated relative paths>`
3. `VALIDATION:` followed by each command and outcome
4. Full content for changed files only, using this exact wrapper:

```text
===FILE:<relative/path>===
<full file content>
===END_FILE===
```

Rules:

- No diff format.
- No unchanged files.
- Keep explanation minimal and factual.
- If blocked, state the blocker first, then still include any useful partial changed files.

---

## Final Reminder

This sprint is about making the backup system **production-safe at P0 level**, not just “working in the happy path”.

Do not stop after fixing only one symptom.
You must close the topology, ownership, durability, request-path, safety, and test gaps together.
