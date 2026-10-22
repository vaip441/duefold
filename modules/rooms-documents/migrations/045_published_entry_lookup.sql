-- Authorization and delivery find a published entry by its resource: the document a
-- viewer opens, each ancestor folder its grant may name, the watermark cache and the
-- text layer. The table was keyed by (room_id,entry_id) and (room_id,parent_folder_id),
-- so every such step read the whole room's published structure, several times per page.
--
-- Publication copies the working tree, which holds one entry per folder and per document
-- (one_working_folder_entry, one_working_document_entry), so a resource appears at most
-- once in a room's published structure.
CREATE UNIQUE INDEX published_structure_resource
  ON published_structure_entry (room_id,resource_kind,resource_id);
