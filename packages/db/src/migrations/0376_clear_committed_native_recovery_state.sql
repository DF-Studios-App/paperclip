-- paperclip:migration-compat online_compatible: the UPDATE only clears recovery state on committed finalizations with no lease owner; on the database behind the running server (2026-11-16) it matches 0 rows, so it takes no row lock there, and other deployments are unmeasured.
UPDATE "native_run_finalizations"
SET "recovery_state" = NULL, "recovery_request_id" = NULL, "updated_at" = now()
WHERE "phase" = 'committed' AND "lease_owner" IS NULL AND "recovery_state" IS NOT NULL;
