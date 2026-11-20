-- Step 7 of docs/pipeline-refactor.md. `items` becomes the record of email
-- decisions, so every decided email that has no item yet (cases run before the
-- audit trail existed) gets one, built from the decision on its `emails` row
-- with the same mapping as `emailDecision` in src/lib/items.ts. Additive only:
-- nothing is changed or removed, and it can run again (it skips emails that
-- already have an item). Subjects were not stored then, so these items have no
-- label; duplicates have no item of their own, as before.
INSERT INTO "items" (
    "id", "case_request_id", "file_id", "parent_id", "kind", "origin",
    "state", "decision_rule", "reason", "decided_by", "created_at", "updated_at"
)
SELECT
    e."email_hash",
    p."case_request_id",
    e."file_id",
    e."parent_email_hash",
    'email',
    CASE WHEN e."is_attachment" <> 0 THEN 'attachment' ELSE 'pst' END,
    CASE e."ai_decision"
        WHEN 'keep' THEN 'kept'
        WHEN 'discard' THEN 'discarded'
        ELSE 'review'
    END,
    CASE
        WHEN e."ai_reason" LIKE 'Pre-filter: Subject or body contains%' THEN 'keyword'
        WHEN e."ai_reason" LIKE 'Pre-filter: Data subject not mentioned%' THEN 'subject_absent'
        WHEN e."ai_reason" LIKE 'System Discard: Draft%' THEN 'draft'
        WHEN e."ai_reason" LIKE 'Client case: deduplication only%' THEN 'client_case'
        WHEN e."ai_reason" LIKE 'Self-forward%' THEN 'self_forward'
        WHEN e."ai_decision" = 'review' THEN 'mail_screen'
        WHEN e."ai_decision" = 'warning' THEN 'self_forward'
        ELSE 'ai_email'
    END,
    NULLIF(e."ai_reason", ''),
    CASE
        WHEN e."ai_reason" LIKE 'Pre-filter: Subject or body contains%'
          OR e."ai_reason" LIKE 'Pre-filter: Data subject not mentioned%'
          OR e."ai_reason" LIKE 'System Discard: Draft%'
          OR e."ai_reason" LIKE 'Client case: deduplication only%'
          OR e."ai_reason" LIKE 'Self-forward%'
          OR e."ai_decision" = 'warning' THEN 'rule'
        WHEN e."ai_decision" = 'review' THEN 'bedrock'
        ELSE NULL
    END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "emails" e
LEFT JOIN "processed_files" p ON p."id" = e."file_id"
WHERE e."is_duplicate" = 0
  AND e."ai_decision" IN ('keep', 'discard', 'warning', 'review')
  AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = e."email_hash");

-- One history event for each email item that has none, so the item panel's
-- timeline is not empty.
INSERT INTO "item_events" (
    "id", "item_id", "state", "decision_rule", "reason", "decided_by", "created_at"
)
SELECT
    gen_random_uuid()::text,
    i."id",
    i."state",
    i."decision_rule",
    i."reason",
    i."decided_by",
    CURRENT_TIMESTAMP
FROM "items" i
WHERE i."kind" = 'email'
  AND NOT EXISTS (SELECT 1 FROM "item_events" v WHERE v."item_id" = i."id");
