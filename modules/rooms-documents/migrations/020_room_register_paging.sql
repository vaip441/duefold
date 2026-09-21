-- The room register, paged in the database instead of in the web process.
--
-- The reader returned every room the actor can reach and the register sliced the result
-- in TypeScript, so opening the register called `member_can_mutate_room` once per room in
-- the installation however few rooms were shown. The cursor and the limit belong to the
-- reader (§23): a bound the caller applies afterwards is not a bound.

-- WITHOUT THIS INDEX THE PAGING IS DECORATIVE. `room` carried only its primary key and two
-- search GIN indexes, so ordering by (title, id) meant a sequential scan plus a top-N sort
-- and `member_can_mutate_room` ran for EVERY room before all but one page was discarded.
-- Measured on 5,047 rooms, one 20-row page: 66 ms and 15,330 buffers with 5,047 function
-- calls, against 0.3 ms and 66 buffers with 21 calls once the scan can stop early.
--
-- The column order matches the reader's ORDER BY and keyset predicate, which is what lets
-- the scan resume at the cursor instead of re-sorting. `id` is not only a determinism
-- tiebreaker: titles are not unique, so without it a page boundary inside a run of equal
-- titles would skip or repeat rooms.
CREATE INDEX room_title_id ON room (title, id);

DROP FUNCTION read_member_rooms(text);
CREATE FUNCTION read_member_rooms(
  p_actor_id text,
  p_after_title text,
  p_after_room_id text,
  p_limit integer
)
RETURNS TABLE(
  room_id text,
  title text,
  description text,
  state text,
  revision integer,
  working_revision integer,
  published_revision integer,
  room_role text,
  access_source text,
  can_publish boolean,
  continues boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid room page size' USING ERRCODE = '22023';
  END IF;
  IF (p_after_title IS NULL) <> (p_after_room_id IS NULL) THEN
    RAISE EXCEPTION 'incomplete room cursor' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH candidates AS (
      SELECT
        r.id AS room_id, r.title, r.description, r.state, r.revision,
        r.working_revision, r.published_revision, a.room_role,
        row_number() OVER (ORDER BY r.title, r.id) AS ordinal
      FROM room r
      LEFT JOIN room_assignment a
        ON a.room_id = r.id AND a.member_id = p_actor_id AND a.state = 'active'
      WHERE (p_after_title IS NULL OR (r.title, r.id) > (p_after_title, p_after_room_id))
        AND member_can_mutate_room(p_actor_id, r.id, false)
      ORDER BY r.title, r.id
      LIMIT p_limit + 1
    )
    SELECT
      c.room_id, c.title, c.description, c.state, c.revision,
      c.working_revision, c.published_revision, c.room_role,
      CASE WHEN c.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END,
      member_can_mutate_room(p_actor_id, c.room_id, true),
      (SELECT count(*) FROM candidates) > p_limit
    FROM candidates c
    WHERE c.ordinal <= p_limit
    ORDER BY c.ordinal;
END $$;

REVOKE ALL ON FUNCTION read_member_rooms(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_rooms(text, text, text, integer) TO duefold_runtime;
ALTER FUNCTION read_member_rooms(text, text, text, integer) OWNER TO duefold_migration;
