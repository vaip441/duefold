-- Content lifecycle corrections: trash purge of viewed documents, repeated
-- processing failure, reopened preview finalization, scoped grant-revocation
-- cache checks, the 32-bit ZIP export limit, and exports that expire while generating.

-- Viewer delivery rows reference versions and derivatives without cascade, so
-- purge removes them (and lists their watermark objects) exactly as room purge does.
CREATE OR REPLACE FUNCTION begin_trash_purge(p_trash_id text,p_job_id text,p_lease_owner text,p_lease_token text)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM room_trash t JOIN job_queue j ON j.id=p_job_id
    WHERE t.id=p_trash_id AND t.purge_after<=transaction_timestamp()
      AND j.job_type='room.trash.purge' AND j.payload->>'trashId'=t.id
      AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token
      AND j.lease_expires_at>transaction_timestamp()) THEN
    RAISE EXCEPTION 'trash purge lease lost or retention active' USING ERRCODE='55000';
  END IF;
  RETURN QUERY
  WITH RECURSIVE entries AS (
    SELECT e.* FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id WHERE t.id=p_trash_id
    UNION ALL SELECT child.* FROM entries parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
  ), versions AS (SELECT v.* FROM entries e JOIN document_version v ON v.document_id=e.document_id)
  SELECT v.object_key FROM versions v
  UNION SELECT d.object_key FROM versions v JOIN document_derivative d ON d.version_id=v.id
  UNION SELECT c.object_key FROM versions v JOIN derivative_cleanup_intent c ON c.version_id=v.id
  UNION SELECT o.object_key FROM versions v JOIN verified_derivative_object o ON o.version_id=v.id
  UNION SELECT w.object_key FROM versions v JOIN watermark_cache w ON w.version_id=v.id;
END $$;

CREATE OR REPLACE FUNCTION finalize_trash_purge(
  p_trash_id text,p_job_id text,p_lease_owner text,p_lease_token text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; document_ids text[]; folder_ids text[]; version_ids text[]; affected integer;
BEGIN
  SELECT t.room_id INTO selected_room
  FROM room_trash t JOIN job_queue j ON j.id=p_job_id
  WHERE t.id=p_trash_id AND t.purge_after<=transaction_timestamp()
    AND j.job_type='room.trash.purge' AND j.payload->>'trashId'=t.id
    AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token
    AND j.lease_expires_at>transaction_timestamp() FOR UPDATE OF t,j;
  IF selected_room IS NULL THEN RAISE EXCEPTION 'trash purge lease lost or retention active' USING ERRCODE='55000'; END IF;
  WITH RECURSIVE entries AS (
    SELECT e.* FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id WHERE t.id=p_trash_id
    UNION ALL SELECT child.* FROM entries parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id)
  SELECT COALESCE(array_agg(document_id) FILTER(WHERE document_id IS NOT NULL),'{}'),
    COALESCE(array_agg(folder_id) FILTER(WHERE folder_id IS NOT NULL),'{}') INTO document_ids,folder_ids FROM entries;
  SELECT COALESCE(array_agg(id),'{}') INTO version_ids FROM document_version WHERE document_id=ANY(document_ids);

  DELETE FROM verified_derivative_object x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM derivative_cleanup_intent x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM preview_delivery_telemetry x USING preview_activity a WHERE x.activity_id=a.id AND a.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM preview_activity x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM download_lease x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM watermark_cache x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_derivative x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_scan_evidence x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM scanner_observation x WHERE x.version_id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  UPDATE document x SET working_version_id=NULL WHERE x.id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM upload_intent x WHERE x.document_id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document_version x WHERE x.id=ANY(version_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM working_structure_entry x WHERE (x.document_id=ANY(document_ids) OR x.folder_id=ANY(folder_ids))
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM document x WHERE x.id=ANY(document_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM folder x WHERE x.id=ANY(folder_ids)
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  DELETE FROM room_trash t WHERE t.id=p_trash_id
    AND EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id AND j.state='running' AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp());
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'trash purge lease lost' USING ERRCODE='55000'; END IF;
  -- Retained audit uses only now-orphaned opaque identifiers. No title,
  -- description, filename, path, object key, hash, email, or content survives.
  INSERT INTO audit_event(id,event_type,actor_kind,room_id,resource_type,result,reason_code,correlation_id,detail)
  SELECT p_audit_id,'room.trash','system',selected_room,'trash','success','TRASH_PURGED',p_correlation_id,
    jsonb_build_object('retentionDays',30) FROM job_queue j WHERE j.id=p_job_id AND j.state='running'
      AND j.lease_owner=p_lease_owner AND j.lease_token=p_lease_token AND j.lease_expires_at>transaction_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'trash purge lease lost' USING ERRCODE='55000'; END IF;
END $$;

-- A removal is draft-only only when nothing beneath it is published either. A
-- published document moved into a new folder stays visible (DESIGN_SPEC §10.6)
-- until a Room Manager publishes that folder's removal.
CREATE OR REPLACE FUNCTION capture_draft_only_trash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
  IF NOT OLD.staged_removed AND NEW.staged_removed AND NOT EXISTS(
    WITH RECURSIVE subtree AS (
      SELECT NEW.id AS id,NEW.folder_id AS folder_id
      UNION ALL SELECT child.id,child.folder_id FROM subtree parent
        JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id)
    SELECT 1 FROM subtree s JOIN published_structure_entry p ON p.room_id=NEW.room_id AND p.entry_id=s.id
  ) THEN PERFORM place_entry_in_trash(NEW.id); END IF;
  RETURN NEW;
END $$;

-- Earlier releases trashed such a folder at once, so its purge would fail on the
-- published reference. The root returns to staged removal and the next
-- publication trashes it with a fresh 30-day retention.
WITH RECURSIVE subtree AS (
  SELECT t.id AS trash_id,t.room_id,e.id,e.folder_id FROM room_trash t
    JOIN working_structure_entry e ON e.id=t.root_entry_id
  UNION ALL SELECT parent.trash_id,parent.room_id,child.id,child.folder_id FROM subtree parent
    JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
), stale AS (
  SELECT DISTINCT s.trash_id FROM subtree s
    JOIN published_structure_entry p ON p.room_id=s.room_id AND p.entry_id=s.id
), stale_jobs AS (
  DELETE FROM job_queue j USING stale s WHERE j.idempotency_key='trash-purge:'||s.trash_id
)
DELETE FROM room_trash t USING stale s WHERE t.id=s.trash_id;

-- Every removal still outside trash holds published content, itself or beneath it,
-- so publication trashes all of them; place_entry_in_trash skips captured roots.
CREATE OR REPLACE FUNCTION publish_room_structure(
  p_room_id text,p_actor_id text,p_expected_working_revision integer,p_expected_published_revision integer,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_published integer; published_count integer; removed record;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501'; END IF;
  IF EXISTS(
    WITH RECURSIVE included AS (
      SELECT e.* FROM working_structure_entry e WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL SELECT child.* FROM included parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
        WHERE child.room_id=p_room_id AND NOT child.staged_removed)
    SELECT 1 FROM included e JOIN document d ON d.id=e.document_id WHERE d.working_version_id IS NOT NULL
      AND NOT version_has_publication_evidence(d.working_version_id,d.id)
  ) THEN RAISE EXCEPTION 'document version lacks publication evidence' USING ERRCODE='23514'; END IF;
  UPDATE room SET published_revision=published_revision+1,published_at=transaction_timestamp(),revision=revision+1
    WHERE id=p_room_id AND state<>'archived' AND working_revision=p_expected_working_revision
      AND published_revision=p_expected_published_revision RETURNING published_revision INTO next_published;
  IF next_published IS NULL THEN RAISE EXCEPTION 'stale publication' USING ERRCODE='40001'; END IF;
  FOR removed IN SELECT e.id FROM working_structure_entry e WHERE e.room_id=p_room_id AND e.staged_removed
  LOOP PERFORM place_entry_in_trash(removed.id); END LOOP;
  DELETE FROM published_structure_entry WHERE room_id=p_room_id;
  INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
  SELECT room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,
    order_key,source_revision,published_version_id
  FROM proposed_publication_snapshot(p_room_id);
  GET DIAGNOSTICS published_count=ROW_COUNT;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.publish','member',p_actor_id,p_room_id,'room',p_room_id,'success','STRUCTURE_PUBLISHED',p_correlation_id,
    jsonb_build_object('workingRevision',p_expected_working_revision,'publishedRevision',next_published,'entryCount',published_count,
      'versionIds',(SELECT COALESCE(jsonb_agg(published_version_id ORDER BY published_version_id),'[]'::jsonb)
        FROM published_structure_entry WHERE room_id=p_room_id AND published_version_id IS NOT NULL)));
  RETURN next_published;
END $$;

-- The retention sweep and audit shared by fail_document_processing and
-- fail_exhausted_document_processing (036). Only those definer functions call it.
CREATE FUNCTION record_document_processing_failure(
  p_version_id text, p_retained timestamptz, p_code text,
  p_audit_id text, p_correlation_id text, p_retention_job_id text
) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- A failed manual retry finds the first failure's sweep still queued, or
  -- finished as a no-op while the retry was processing. Terminal jobs cannot be
  -- re-armed, so they are replaced; a live one is re-armed for the new deadline,
  -- and clearing its lease fences any run still holding it.
  DELETE FROM job_queue WHERE idempotency_key = 'retention:' || p_version_id
    AND state IN ('succeeded','failed');
  INSERT INTO job_queue (id,job_type,idempotency_key,payload,available_at)
    VALUES (p_retention_job_id,'document.retention.sweep','retention:' || p_version_id,
      jsonb_build_object('versionId',p_version_id),p_retained)
    ON CONFLICT (idempotency_key) DO UPDATE SET state = 'pending',attempts = 0,
      available_at = EXCLUDED.available_at,lease_owner = NULL,lease_token = NULL,
      lease_expires_at = NULL,last_error_code = NULL,updated_at = transaction_timestamp();
  INSERT INTO audit_event
    (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id)
  VALUES (p_audit_id,'document.processing','system',p_version_id,'document_version',p_version_id,
    'failure',p_code,p_correlation_id);
END $$;
REVOKE ALL ON FUNCTION record_document_processing_failure(text,timestamptz,text,text,text,text)
  FROM PUBLIC,duefold_runtime,duefold_worker;
ALTER FUNCTION record_document_processing_failure(text,timestamptz,text,text,text,text)
  OWNER TO duefold_migration;

CREATE OR REPLACE FUNCTION fail_document_processing(
  p_version_id text, p_job_id text, p_lease_owner text, p_lease_token text,
  p_state text, p_kind text, p_code text, p_days integer,
  p_audit_id text, p_correlation_id text, p_retention_job_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE retained timestamptz;
BEGIN
  UPDATE document_version v SET state = p_state,failure_kind = p_kind,failure_code = p_code,
    retained_until = transaction_timestamp() + (p_days * interval '1 day'),
    processing_attempts = processing_attempts + 1
  FROM job_queue j WHERE v.id = p_version_id AND v.state = 'quarantine' AND j.id = p_job_id
    AND j.job_type = 'document.source.validate' AND j.payload->>'versionId' = v.id
    AND j.state = 'running' AND j.lease_owner = p_lease_owner AND j.lease_token = p_lease_token
    AND j.lease_expires_at > transaction_timestamp()
  RETURNING v.retained_until INTO retained;
  IF retained IS NULL THEN RAISE EXCEPTION 'job lease lost' USING ERRCODE = '55000'; END IF;
  PERFORM record_document_processing_failure(p_version_id,retained,p_code,
    p_audit_id,p_correlation_id,p_retention_job_id);
END $$;

CREATE OR REPLACE FUNCTION begin_preview_activity(p_id text,p_session_digest text,p_room_id text,
  p_document_id text,p_version_id text,p_correlation_id text,p_network_period text,p_network_hmac text,
  p_browser text,p_os text,p_device text,p_audit_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE activity text; identity record;
BEGIN
  SELECT * INTO identity FROM resolve_presented_viewer(p_session_digest);
  IF identity.viewer_id IS NULL
     OR NOT viewer_can_preview_document(identity.viewer_id,identity.session_id,p_room_id,p_document_id)
     OR NOT EXISTS(SELECT 1 FROM published_structure_entry p WHERE p.room_id=p_room_id
       AND p.resource_kind='document' AND p.resource_id=p_document_id AND p.published_version_id=p_version_id) THEN
    RETURN NULL;
  END IF;
  /*
   * This table is mutable session state (see the table comment); the immutable
   * record is the preview.start audit event, which is limited to exactly ONE per
   * viewer/session/version. Only the caller whose insert creates the row writes it.
   * Two tabs opening the same document race on UNIQUE(viewer_id,session_id,version_id):
   * the loser waits for the winner's commit and then uses the winner's row.
   */
  INSERT INTO preview_activity(id,viewer_id,session_id,room_id,document_id,version_id,correlation_id,
    network_period,network_hmac,browser_category,os_category,device_category)
  VALUES(p_id,identity.viewer_id,identity.session_id,p_room_id,p_document_id,p_version_id,p_correlation_id,
    p_network_period,p_network_hmac,p_browser,p_os,p_device)
  ON CONFLICT(viewer_id,session_id,version_id) DO NOTHING
  RETURNING id INTO activity;
  IF activity IS NOT NULL THEN
    INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
      resource_id,result,reason_code,correlation_id,detail)
    VALUES(p_audit_id,'preview.start','viewer',identity.viewer_id,identity.session_id,p_room_id,'document_version',
      p_version_id,'success','PREVIEW_STARTED',p_correlation_id,'{}'::jsonb);
    INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
    VALUES(replace(gen_random_uuid()::text,'-',''),'preview.inactivity.finalize','preview-inactivity:'||p_id||':initial',
      jsonb_build_object('activityId',p_id),statement_timestamp()+interval '2 minutes');
    RETURN p_id;
  END IF;
  /*
   * A summarized activity must not be handed back unchanged: delivery requires
   * state='active', so reusing a closed row made every reopened document fail.
   * Reopening reactivates the same row without a second start event. The state
   * condition lets only one of two concurrent reopens queue a finalizer.
   */
  UPDATE preview_activity SET state='active',summarized_at=NULL,
    heartbeat_at=statement_timestamp()
  WHERE viewer_id=identity.viewer_id AND session_id=identity.session_id
    AND version_id=p_version_id AND state<>'active'
  RETURNING id INTO activity;
  IF activity IS NOT NULL THEN
    -- The earlier finalizer already ended on the summarized row, so a reopened
    -- activity needs its own or an abandoned tab is never summarized. The key
    -- matches the heartbeat form finalize_or_reschedule_preview uses.
    INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
    VALUES(replace(gen_random_uuid()::text,'-',''),'preview.inactivity.finalize',
      'preview-inactivity:'||activity||':'||(extract(epoch FROM statement_timestamp())*1000000)::bigint,
      jsonb_build_object('activityId',activity),statement_timestamp()+interval '2 minutes')
    ON CONFLICT(idempotency_key) DO NOTHING;
    RETURN activity;
  END IF;
  SELECT id INTO activity FROM preview_activity WHERE viewer_id=identity.viewer_id
    AND session_id=identity.session_id AND version_id=p_version_id;
  RETURN activity;
END $$;

-- Successor keys carry the heartbeat to the microsecond. Whole seconds let a
-- heartbeat in the same second as the running job's key resolve to that job's own
-- key, so ON CONFLICT DO NOTHING queued no successor and the activity never closed.
-- A retry of the same run still derives the same key, so it cannot fork the chain.
CREATE OR REPLACE FUNCTION finalize_or_reschedule_preview(p_activity_id text,p_job_id text,p_owner text,p_token text,p_successor_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected preview_activity%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM job_queue j WHERE j.id=p_job_id
    AND j.job_type='preview.inactivity.finalize' AND j.payload->>'activityId'=p_activity_id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'preview inactivity lease lost' USING ERRCODE='55000';
  END IF;
  SELECT * INTO selected FROM preview_activity WHERE id=p_activity_id FOR UPDATE;
  IF selected.id IS NULL OR selected.state<>'active' THEN RETURN 'already-final'; END IF;
  IF selected.heartbeat_at>statement_timestamp()-interval '2 minutes' THEN
    INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at)
    VALUES(p_successor_id,'preview.inactivity.finalize',
      'preview-inactivity:'||p_activity_id||':'||(extract(epoch FROM selected.heartbeat_at)*1000000)::bigint,
      jsonb_build_object('activityId',p_activity_id),selected.heartbeat_at+interval '2 minutes')
    ON CONFLICT(idempotency_key) DO NOTHING;
    RETURN 'rescheduled';
  END IF;
  UPDATE preview_activity SET state='inactive',summarized_at=statement_timestamp() WHERE id=p_activity_id;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
    resource_id,result,reason_code,correlation_id,detail)
  VALUES(replace(gen_random_uuid()::text,'-',''),'preview.summary','viewer',selected.viewer_id,
    selected.session_id,selected.room_id,'document_version',selected.version_id,'success',
    'PREVIEW_INACTIVE',selected.correlation_id,
    jsonb_build_object('pageRanges',selected.page_ranges::text,'status','inactive'));
  RETURN 'summarized';
END $$;

-- Only the revoked grantee can lose access, so only their caches are re-checked.
CREATE OR REPLACE FUNCTION watermark_cache_grant_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected watermark_cache%ROWTYPE;
BEGIN
  IF OLD.state='active' AND NEW.state='revoked' THEN
    FOR selected IN SELECT c.* FROM watermark_cache c WHERE c.room_id=NEW.room_id
      AND c.state IN ('creating','active')
      AND (c.viewer_id=NEW.viewer_id OR c.viewer_id IN (SELECT cv.viewer_id FROM counterparty_viewer cv
        WHERE cv.counterparty_id=NEW.counterparty_id AND cv.room_id=NEW.room_id))
      AND NOT viewer_can_preview_document(c.viewer_id,c.session_id,c.room_id,c.document_id)
    LOOP PERFORM enqueue_watermark_deletion(selected); END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Without ZIP64 every archive offset and size is a 32-bit field. create_export_request
-- runs this preflight, so an archive estimated past that limit is never queued. The
-- refusal has its own reason so the member is told to split the selection, which an
-- invalid-selection 22023 would not say.
CREATE OR REPLACE FUNCTION export_preflight(
  p_actor_id text,p_room_id text,p_preset text,p_selected text[],p_include_originals boolean
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE files integer; estimated bigint; pii jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'export forbidden' USING ERRCODE='42501';
  END IF;
  IF NOT validate_export_selection(p_room_id,p_preset,p_selected)
     OR (p_include_originals AND p_preset<>'selected-documents') THEN
    RAISE EXCEPTION 'export selection invalid' USING ERRCODE='22023';
  END IF;
  IF p_preset='selected-documents' THEN
    SELECT count(*)::integer,
      COALESCE(sum(CASE WHEN p_include_originals THEN v.size_bytes ELSE 1024 END),0)::bigint
      INTO files,estimated
    FROM document d JOIN unnest(p_selected) x ON x=d.id
    LEFT JOIN LATERAL (
      SELECT dv.size_bytes FROM document_version dv
      WHERE dv.id=d.working_version_id AND version_has_publication_evidence(dv.id,d.id)
    ) v ON true;
    IF estimated>4294967295 THEN
      RAISE EXCEPTION 'EXPORT_TOO_LARGE' USING ERRCODE='54000';
    END IF;
    pii:='["document titles"]'::jsonb;
  ELSIF p_preset='participant-access' THEN
    SELECT count(*)::integer, GREATEST(count(*)*512,1)::bigint INTO files,estimated
    FROM viewer_room_membership WHERE room_id=p_room_id;
    pii:='["viewer identity","access grants","expiry"]'::jsonb;
  ELSE
    SELECT count(*)::integer, GREATEST(count(*)*1024,1)::bigint INTO files,estimated
    FROM published_structure_entry WHERE room_id=p_room_id AND resource_kind='document';
    pii:='["member and viewer evidence references","audit timestamps"]'::jsonb;
  END IF;
  RETURN jsonb_build_object('piiCategories',pii,'fileCount',files,'estimatedSize',estimated,
    'retentionEffect','Private temporary object; one download; expires and is deleted after one hour',
    'originalsIncluded',p_include_originals);
END $$;

-- An archive that outgrows the ZIP limit during generation (versions replaced after
-- the request) fails the same way on every attempt, so it ends here instead of retrying.
-- An export that expired meanwhile is already on export.cleanup's deletion path and stays there.
CREATE FUNCTION fail_export_job(p_export_id text,p_job_id text,p_owner text,p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM export_request e JOIN job_queue j ON j.id=p_job_id
    WHERE e.id=p_export_id AND j.job_type='export.generate' AND j.payload->>'exportId'=e.id
      AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
      AND j.lease_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'export job lease lost' USING ERRCODE='55000';
  END IF;
  UPDATE export_request SET state='failed' WHERE id=p_export_id AND state='generating';
END $$;
REVOKE ALL ON FUNCTION fail_export_job(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_export_job(text,text,text,text) TO duefold_worker;
ALTER FUNCTION fail_export_job(text,text,text,text) OWNER TO duefold_migration;

-- A multi-GiB archive can outlast the one-hour expiry. Returning false (rather than
-- refusing) for an export that expired while generating lets the job end without a
-- retry; expire_exports may have handed the key to export.cleanup before the upload
-- landed, so the caller deletes the object it just wrote.
-- A lost lease raises. An export that expired or left 'generating' before this
-- attempt (a retry after a crash, or one started past expires_at) returns NULL so
-- the job ends without retrying; expire_exports has handed its key to export.cleanup.
CREATE OR REPLACE FUNCTION read_export_job_payload(p_export_id text,p_job_id text,p_owner text,p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e export_request%ROWTYPE;
BEGIN
  SELECT x.* INTO e FROM export_request x JOIN job_queue j ON j.id=p_job_id
  WHERE x.id=p_export_id AND j.job_type='export.generate' AND j.payload->>'exportId'=x.id
    AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
    AND j.lease_expires_at>statement_timestamp();
  IF e.id IS NULL THEN RAISE EXCEPTION 'export job lease lost' USING ERRCODE='55000'; END IF;
  IF e.state<>'generating' OR e.expires_at<=statement_timestamp() THEN RETURN NULL; END IF;
  RETURN read_export_payload(e.id,e.created_by)||jsonb_build_object('exportObjectKey',e.object_key);
END $$;

CREATE OR REPLACE FUNCTION mark_export_job_ready(p_export_id text,p_job_id text,p_owner text,p_token text,p_size_bytes bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM export_request e JOIN job_queue j ON j.id=p_job_id
    WHERE e.id=p_export_id AND j.job_type='export.generate' AND j.payload->>'exportId'=e.id
      AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
      AND j.lease_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'export job lease lost' USING ERRCODE='55000';
  END IF;
  UPDATE export_request SET state='ready',size_bytes=p_size_bytes
    WHERE id=p_export_id AND state='generating' AND expires_at>statement_timestamp();
  RETURN FOUND;
END $$;
