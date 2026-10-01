-- OneTrust's Create Request API expects the web-form option keys rather than
-- their display labels. This template uses RequestType3 (DSAR) and
-- SubjectType3 (Customer).
UPDATE "pipeline_settings"
SET "onetrust_request_type" = 'RequestType3'
WHERE "onetrust_request_type" IN ('Info Request', 'DSAR');

UPDATE "pipeline_settings"
SET "onetrust_subject_type" = 'SubjectType3'
WHERE "onetrust_subject_type" = 'Customer';

UPDATE "pipeline_settings"
SET "onetrust_language" = 'en-gb'
WHERE "onetrust_language" IS NULL
   OR BTRIM("onetrust_language") = ''
   OR "onetrust_language" = 'en-us';
