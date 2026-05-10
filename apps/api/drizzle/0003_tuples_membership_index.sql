-- Speed up membership lookups for the hot auth path
-- (`listGroupIdsForUser`, `listGroupMembershipsForUser`,
--  `listGroupMembershipsForUsers` — see modules/policy/policy.service.ts).
-- These all filter on
--   subject_namespace='user' AND subject_id=? AND
--   namespace='group' AND relation='member' AND subject_relation IS NULL.
-- The existing `idx_tuples_subject` covers (subject_namespace, subject_id,
-- subject_relation) but leaves (namespace, relation) as residual filtering.
-- A partial index keeps the new index small while covering every column the
-- predicate cares about.
CREATE INDEX IF NOT EXISTS `idx_tuples_user_member`
  ON `relation_tuples` (`subject_namespace`, `subject_id`, `namespace`, `relation`)
  WHERE `subject_relation` IS NULL;
