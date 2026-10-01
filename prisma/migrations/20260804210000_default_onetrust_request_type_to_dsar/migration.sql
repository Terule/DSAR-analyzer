-- Replace the original placeholder with the Client web-form's default,
-- without changing tenants that already selected a valid request type.
UPDATE "pipeline_settings"
SET "onetrust_request_type" = 'DSAR'
WHERE "onetrust_request_type" IS NULL
   OR BTRIM("onetrust_request_type") = ''
   OR "onetrust_request_type" = 'Info Request';
