CREATE TABLE IF NOT EXISTS "skill_package_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"archive_key" text NOT NULL,
	"manifest_key" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "storage" jsonb;
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "upload" jsonb;
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "restore" jsonb;
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "migration_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "maintenance_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "company_skill_repository_snapshots" ADD COLUMN IF NOT EXISTS "restore_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "package_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "package_file_map" jsonb;
--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "migration_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_package_deletions_due_idx" ON "skill_package_deletions" USING btree ("delete_after","id");
--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD CONSTRAINT "company_skill_versions_package_snapshot_id_company_skill_repository_snapshots_id_fk" FOREIGN KEY ("package_snapshot_id") REFERENCES "public"."company_skill_repository_snapshots"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_skill_snapshots_migration_idx" ON "company_skill_repository_snapshots" USING btree ("migration_at") WHERE "company_skill_repository_snapshots"."migration_at" is not null;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_skill_snapshots_maintenance_idx" ON "company_skill_repository_snapshots" USING btree ("maintenance_at") WHERE "company_skill_repository_snapshots"."maintenance_at" is not null;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_skill_versions_migration_idx" ON "company_skill_versions" USING btree ("migration_at") WHERE "company_skill_versions"."migration_at" is not null;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_skill_versions_package_snapshot_idx" ON "company_skill_versions" USING btree ("package_snapshot_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_skill_versions_repository_snapshot_idx" ON "company_skill_versions" USING btree ("repository_snapshot_id");
