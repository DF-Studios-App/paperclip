-- Environment requirements use the same durable runtime journal as explicit skill assignments.
CREATE FUNCTION paperclip_environment_selects_runtime_skill(p_company uuid, p_environment uuid, p_skill uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM environments e
    JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
    JOIN plugin_managed_resources r ON r.plugin_id = p.id AND r.company_id = p_company
      AND r.resource_kind = 'skill' AND r.resource_id = p_skill
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.manifest_json->'environmentDrivers', '[]'::jsonb)) AS declared_driver(value)
    WHERE e.id = coalesce(p_environment, (SELECT default_environment_id FROM instance_settings LIMIT 1))
      AND e.driver = 'plugin' AND declared_driver.value->>'driverKey' = e.config->>'driverKey'
      AND coalesce(declared_driver.value->'skillKeys', '[]'::jsonb) ? r.resource_key);
$$;
--> statement-breakpoint
CREATE FUNCTION paperclip_environment_runtimes_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; candidate record;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'plugin_company_settings' THEN
    IF coalesce((previous->>'enabled')::boolean, true) IS NOT DISTINCT FROM coalesce((current->>'enabled')::boolean, true) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (CASE TG_TABLE_NAME
    WHEN 'environments' THEN previous->'config' IS NOT DISTINCT FROM current->'config' AND previous->'driver' IS NOT DISTINCT FROM current->'driver'
    WHEN 'plugins' THEN previous->'manifest_json' IS NOT DISTINCT FROM current->'manifest_json' AND previous->'status' IS NOT DISTINCT FROM current->'status'
    ELSE previous->'default_environment_id' IS NOT DISTINCT FROM current->'default_environment_id' END) THEN RETURN NEW; END IF;
  FOR candidate IN SELECT a.id, a.company_id FROM agents a
    WHERE a.status NOT IN ('pending_approval', 'terminated') AND (CASE TG_TABLE_NAME
      WHEN 'environments' THEN coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
        = coalesce((current->>'id')::uuid, (previous->>'id')::uuid)
      WHEN 'plugins' THEN EXISTS (SELECT 1 FROM environments e
        WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
          AND e.driver = 'plugin' AND e.config->>'pluginKey' = coalesce(current->>'plugin_key', previous->>'plugin_key'))
      WHEN 'plugin_company_settings' THEN a.company_id = coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid)
        AND EXISTS (SELECT 1 FROM environments e JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
          WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
            AND e.driver = 'plugin' AND p.id = coalesce((current->>'plugin_id')::uuid, (previous->>'plugin_id')::uuid))
      ELSE a.default_environment_id IS NULL END)
    ORDER BY a.company_id, a.id FOR NO KEY UPDATE OF a LOOP
    PERFORM paperclip_record_agent_runtime(candidate.company_id, candidate.id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
