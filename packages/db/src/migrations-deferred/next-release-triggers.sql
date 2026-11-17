-- Deferred contract. These statements are NOT in the migrations journal and do not run in this release.
-- They were split out of 0372, 0378 and 0415 because the previous release keeps writing to the tables
-- they touch while the migration runs. Move them into packages/db/src/migrations in the next release,
-- add the journal entry, and classify them then. See README.md in this folder.

-- From 0415: new package-deletion functions. Created here, not in the listed file, so the file stays rerunnable.
CREATE OR REPLACE FUNCTION paperclip_queue_skill_package_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.storage IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.storage->>'archiveKey' IS DISTINCT FROM NEW.storage->>'archiveKey') THEN
    INSERT INTO skill_package_deletions(company_id, provider, archive_key, manifest_key, delete_after)
    VALUES (OLD.company_id, OLD.storage->>'provider', OLD.storage->>'archiveKey', OLD.storage->>'manifestKey', now() + interval '30 days');
  END IF;
  IF OLD.upload IS NOT NULL AND (TG_OP = 'DELETE' OR (
    OLD.upload->>'token' IS DISTINCT FROM NEW.upload->>'token'
    AND OLD.upload->>'archiveKey' IS DISTINCT FROM NEW.storage->>'archiveKey'
  )) THEN
    INSERT INTO skill_package_deletions(company_id, provider, archive_key, manifest_key, delete_after)
    VALUES (OLD.company_id, OLD.upload->>'provider', OLD.upload->>'archiveKey', OLD.upload->>'manifestKey',
      greatest(now() + interval '1 hour', (OLD.upload->>'expiresAt')::timestamptz));
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- From 0415: new package-cleanup function.
CREATE OR REPLACE FUNCTION paperclip_schedule_skill_package_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'company_skills' THEN
    version_id := OLD.current_version_id;
    IF version_id IS NOT NULL AND (TG_OP = 'DELETE' OR version_id IS DISTINCT FROM NEW.current_version_id) THEN
      UPDATE company_skill_repository_snapshots SET maintenance_at = now() + interval '30 days'
        WHERE id IN (SELECT repository_snapshot_id FROM company_skill_versions WHERE id = version_id
                     UNION SELECT package_snapshot_id FROM company_skill_versions WHERE id = version_id);
    END IF;
  ELSE
    UPDATE company_skill_repository_snapshots SET maintenance_at = now() + interval '1 day'
      WHERE id = OLD.repository_snapshot_id OR id = OLD.package_snapshot_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- From 0415: default change on an existing column. Previous release inserts would receive a new default.
ALTER TABLE "company_skill_repository_snapshots" ALTER COLUMN "file_inventory" SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- From 0378: replaces a function that the existing trigger on company_skills and related tables already calls.
CREATE OR REPLACE FUNCTION paperclip_invalidate_skill_source_runtimes(p_company uuid, sources uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND (paperclip_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug)
          OR paperclip_environment_selects_runtime_skill(p_company, a.default_environment_id, s.id)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
-- From 0378: replaces the trigger function behind the existing skill runtime constraint trigger.
CREATE OR REPLACE FUNCTION paperclip_skill_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'paperclip_runner' AND keys && ARRAY['paperclipai/paperclip/paperclip', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box']) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{paperclipSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{paperclipSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys))
      OR paperclip_environment_selects_runtime_skill(company, a.default_environment_id, coalesce((current->>'id')::uuid, (previous->>'id')::uuid)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- From 0378: trigger on environments. Fires on previous-release writes.
CREATE TRIGGER paperclip_environment_runtime_changed AFTER INSERT OR UPDATE ON environments
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
-- From 0378: trigger on plugins.
CREATE TRIGGER paperclip_plugin_environment_runtime_changed AFTER UPDATE ON plugins
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
-- From 0378: trigger on plugin_company_settings.
CREATE TRIGGER paperclip_plugin_company_environment_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON plugin_company_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
-- From 0378: trigger on instance_settings.
CREATE TRIGGER paperclip_default_environment_runtime_changed AFTER UPDATE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_environment_runtimes_changed();
--> statement-breakpoint
-- From 0372: trigger on issues. Fires on previous-release status and parent updates.
CREATE TRIGGER paperclip_restore_point_tree_update AFTER UPDATE OF status, parent_id ON issues
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
EXECUTE FUNCTION paperclip_restore_point_tree_changed();
--> statement-breakpoint
-- From 0372: trigger on issues delete.
CREATE TRIGGER paperclip_restore_point_tree_delete AFTER DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION paperclip_restore_point_tree_changed();
--> statement-breakpoint
-- From 0415: trigger on company_skill_repository_snapshots.
DROP TRIGGER IF EXISTS skill_package_deletion_receipts ON company_skill_repository_snapshots;
--> statement-breakpoint
-- From 0415: trigger on company_skill_repository_snapshots.
CREATE TRIGGER skill_package_deletion_receipts AFTER UPDATE OF storage, upload OR DELETE
ON company_skill_repository_snapshots FOR EACH ROW EXECUTE FUNCTION paperclip_queue_skill_package_deletion();
--> statement-breakpoint
-- From 0415: trigger on company_skills.
DROP TRIGGER IF EXISTS skill_package_current_cleanup ON company_skills;
--> statement-breakpoint
-- From 0415: trigger on company_skills.
CREATE TRIGGER skill_package_current_cleanup AFTER UPDATE OF current_version_id OR DELETE ON company_skills
FOR EACH ROW EXECUTE FUNCTION paperclip_schedule_skill_package_cleanup();
--> statement-breakpoint
-- From 0415: trigger on company_skill_versions.
DROP TRIGGER IF EXISTS skill_package_version_cleanup ON company_skill_versions;
--> statement-breakpoint
-- From 0415: trigger on company_skill_versions.
CREATE TRIGGER skill_package_version_cleanup AFTER DELETE ON company_skill_versions
FOR EACH ROW EXECUTE FUNCTION paperclip_schedule_skill_package_cleanup();
