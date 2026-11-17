-- paperclip:migration-compat online_compatible: the foreign key is added NOT VALID and the backfill matches 0 rows on the database behind the running server (2026-11-16; projects has 3 rows), and other deployments are unmeasured.
ALTER TABLE "projects" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
UPDATE "projects" p
SET "environment_id" = e."id", "execution_workspace_policy" = p."execution_workspace_policy" - 'environmentId'
FROM "environments" e
WHERE lower(p."execution_workspace_policy" ->> 'environmentId') = e."id"::text;
