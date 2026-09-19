-- Duefold member workspace readers.
--
-- Earlier migrations removed duefold_runtime's table-wide SELECT on room, folder,
-- working_structure_entry and published_structure_entry, and room_trash is
-- REVOKE ALL from runtime. That was correct, but it left no way to answer the
-- three questions the member workspace is built on: which rooms can I see, what
-- is in the working structure, and what is in the trash. The per-item revision
-- probes in 004 cannot enumerate children, and using member_search_room as a
-- tree enumerator would make a search index do authorization work it was not
-- designed for and cannot express parent/child structure.
--
-- These readers restore no table privilege. Each is SECURITY DEFINER, authorizes
-- internally through the same member_can_mutate_room predicate existing
-- mutations already use, and is granted EXECUTE to duefold_runtime only.

-- One definition of "what would publishing change", extracted verbatim from
-- dry_run_bulk_publish so the workspace's pending-change markers and the
-- publication preview cannot disagree. Two independent diff implementations
-- WILL diverge; that exact defect already shipped here once, when the dry-run
-- compared only display_name while apply wrote seven fields.
CREATE FUNCTION publication_change_set(p_room_id text)
RETURNS TABLE(entry_id text,path text,changes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE old_paths AS (
    SELECT p.*,p.display_name::text AS full_path
    FROM published_structure_entry p WHERE p.room_id=p_room_id AND p.parent_folder_id IS NULL
    UNION ALL
    SELECT child.*,(parent.full_path || ' / ' || child.display_name)::text
    FROM old_paths parent JOIN published_structure_entry child
      ON child.room_id=p_room_id AND child.parent_folder_id=parent.resource_id
  ), compared AS (
    SELECT COALESCE(n.entry_id,o.entry_id) entry_id,COALESCE(n.path,o.full_path) path,
      array_remove(ARRAY[
        CASE WHEN o.entry_id IS NULL THEN 'add' END,
        CASE WHEN n.entry_id IS NULL THEN 'remove' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.display_name IS DISTINCT FROM o.display_name THEN 'rename' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.parent_folder_id IS DISTINCT FROM o.parent_folder_id THEN 'move' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.order_key IS DISTINCT FROM o.order_key THEN 'reorder' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.description IS DISTINCT FROM o.description THEN 'description' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND n.published_version_id IS DISTINCT FROM o.published_version_id THEN 'version' END,
        CASE WHEN n.entry_id IS NOT NULL AND o.entry_id IS NOT NULL AND (n.resource_kind IS DISTINCT FROM o.resource_kind OR n.resource_id IS DISTINCT FROM o.resource_id) THEN 'replace' END
      ],NULL)::text[] changes
    FROM proposed_publication_snapshot(p_room_id) n FULL JOIN old_paths o ON o.entry_id=n.entry_id
  )
  SELECT entry_id,path,changes FROM compared WHERE cardinality(changes)>0
$$;

-- Rebuilt to consume the shared change set rather than carry its own copy of the
-- comparison. Behaviour is unchanged: same message, affectedCount, paths, items
-- and confirmation string, same manager-only gate and same evidence precondition.
CREATE OR REPLACE FUNCTION dry_run_bulk_publish(p_actor_id text,p_room_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF EXISTS(
    WITH RECURSIVE included AS (
      SELECT e.* FROM working_structure_entry e WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL AND NOT e.staged_removed
      UNION ALL SELECT child.* FROM included parent JOIN working_structure_entry child ON child.parent_folder_id=parent.folder_id
        WHERE child.room_id=p_room_id AND NOT child.staged_removed)
    SELECT 1 FROM included e JOIN document d ON d.id=e.document_id
    WHERE d.working_version_id IS NOT NULL AND NOT version_has_publication_evidence(d.working_version_id,d.id)
  ) THEN RAISE EXCEPTION 'document version lacks publication evidence' USING ERRCODE='23514'; END IF;
  WITH summary AS (
    SELECT count(*)::integer affected_count,
      COALESCE(jsonb_agg(path ORDER BY path),'[]'::jsonb) paths,
      COALESCE(jsonb_agg(jsonb_build_object('entryId',entry_id,'path',path,'changes',changes) ORDER BY path),'[]'::jsonb) items
    FROM publication_change_set(p_room_id)
  )
  SELECT jsonb_build_object(
    'message','Publish '||affected_count||' structure change'||CASE WHEN affected_count=1 THEN '' ELSE 's' END||'.',
    'affectedCount',affected_count,'paths',paths,'items',items,
    'confirmation','PUBLISH '||affected_count||' CHANGES') INTO impact FROM summary;
  RETURN impact;
END $$;

-- A. Which rooms can this member reach, and WHY.
--
-- member_can_mutate_room returns true for every room in the installation when the
-- actor's global_role is owner or admin, with no room_assignment at all. That is
-- correct for mutation authorization, but filtering a room LIST on it silently
-- turns "my rooms" into "every room". access_source makes that visible instead of
-- accidental: the workspace labels a global-role room as reached by role, never as
-- one a colleague assigned. Archived rooms are included with their state so
-- members can still reach records; the workspace must not
-- present an archived room as a live working surface.
CREATE FUNCTION read_member_rooms(p_actor_id text)
RETURNS TABLE(room_id text,title text,description text,state text,revision integer,
  working_revision integer,published_revision integer,room_role text,access_source text,
  can_publish boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.id,r.title,r.description,r.state,r.revision,r.working_revision,r.published_revision,
    a.room_role,
    CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END,
    member_can_mutate_room(p_actor_id,r.id,true)
  FROM room r
  LEFT JOIN room_assignment a ON a.room_id=r.id AND a.member_id=p_actor_id
  WHERE member_can_mutate_room(p_actor_id,r.id,false)
  ORDER BY r.title,r.id
$$;

-- B. The working structure, with each entry's publication delta.
--
-- Working and published values are resolved together in ONE reader because "is
-- this change live" is a correctness claim about server state, not a presentation
-- detail: diffing two separately fetched trees in the browser can drift and show a
-- stale "live" badge. change_kinds comes from publication_change_set, the same
-- expression the publish preview uses.
--
-- Ordering is returned as a dense position with neighbour facts, never the
-- fractional order_key. Leaking the key invites a client to compute its own and
-- post it; the reorder API takes a target position instead.
CREATE FUNCTION read_member_working_structure(p_actor_id text,p_room_id text)
RETURNS TABLE(entry_id text,resource_kind text,resource_id text,parent_folder_id text,
  display_name text,description text,revision integer,staged_removed boolean,depth integer,
  sibling_position integer,can_move_up boolean,can_move_down boolean,change_kinds text[],
  has_publishable_version boolean,is_published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE authorized AS (
    SELECT member_can_mutate_room(p_actor_id,p_room_id,false) allowed
  ), tree AS (
    SELECT e.*,0 AS depth FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL
      AND (SELECT allowed FROM authorized)
    UNION ALL
    SELECT child.*,parent.depth+1 FROM tree parent JOIN working_structure_entry child
      ON child.parent_folder_id=parent.folder_id
    WHERE child.room_id=p_room_id AND parent.depth<5
  ), ordered AS (
    /*
     * Position and movement flags are computed over the ACTIVE sibling set only,
     * matching the mutation resolver, which excludes staged-removed siblings when
     * placing an entry. Counting removed rows here enabled a "move down" that was
     * a no-op or landed at a different active position, because the reader and the
     * mutation disagreed about what the siblings were. Staged-removed entries keep
     * a NULL position and no movement affordance: they are pending removals, not
     * orderable rows.
     */
    SELECT t.*,
      CASE WHEN t.staged_removed THEN NULL ELSE row_number() OVER (
        PARTITION BY t.parent_folder_id,t.staged_removed ORDER BY t.order_key,t.id
      )::integer END sibling_position,
      count(*) FILTER (WHERE NOT t.staged_removed) OVER (
        PARTITION BY t.parent_folder_id
      )::integer sibling_count
    FROM tree t
  )
  SELECT o.id,
    CASE WHEN o.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(o.folder_id,o.document_id),o.parent_folder_id,o.display_name,
    CASE WHEN o.folder_id IS NOT NULL THEN f.description ELSE d.description END,
    o.revision,o.staged_removed,o.depth,o.sibling_position,
    COALESCE(o.sibling_position>1,false),
    COALESCE(o.sibling_position<o.sibling_count,false),
    COALESCE(c.changes,ARRAY[]::text[]),
    o.folder_id IS NOT NULL OR (d.working_version_id IS NOT NULL
      AND version_has_publication_evidence(d.working_version_id,d.id)),
    EXISTS(SELECT 1 FROM published_structure_entry p
      WHERE p.room_id=p_room_id AND p.entry_id=o.id)
  FROM ordered o
  LEFT JOIN folder f ON f.id=o.folder_id
  LEFT JOIN document d ON d.id=o.document_id
  LEFT JOIN publication_change_set(p_room_id) c ON c.entry_id=o.id
  ORDER BY o.depth,o.parent_folder_id NULLS FIRST,o.sibling_position,o.id
$$;

-- C. Room trash.
--
-- purge_after is returned as an absolute server timestamp only. No days_remaining
-- is precomputed and the client must not count down from its own clock: a wrong
-- "1 day left" on an irreversible purge is a serious failure. Retention is fixed
-- at 30 days and stated as such. Former sibling names are NOT reserved, so this
-- reader deliberately carries no name-reservation signal.
CREATE FUNCTION read_member_trash(p_actor_id text,p_room_id text)
RETURNS TABLE(trash_id text,resource_kind text,display_name text,root_entry_id text,
  entry_revision integer,trashed_at timestamptz,purge_after timestamptz,
  was_published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT t.id,t.resource_kind,e.display_name,t.root_entry_id,e.revision,
    t.trashed_at,t.purge_after,
    EXISTS(SELECT 1 FROM published_structure_entry p
      WHERE p.room_id=t.room_id AND p.entry_id=t.root_entry_id)
  FROM room_trash t JOIN working_structure_entry e ON e.id=t.root_entry_id
  WHERE t.room_id=p_room_id AND member_can_mutate_room(p_actor_id,p_room_id,false)
  ORDER BY t.purge_after,t.id
$$;

REVOKE ALL ON FUNCTION publication_change_set(text),read_member_rooms(text),
 read_member_working_structure(text,text),read_member_trash(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_rooms(text),
 read_member_working_structure(text,text),read_member_trash(text,text) TO duefold_runtime;
ALTER FUNCTION publication_change_set(text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_rooms(text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_working_structure(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_member_trash(text,text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_bulk_publish(text,text) OWNER TO duefold_migration;
