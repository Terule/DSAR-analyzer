-- The form API takes the user type by display name, not by key.
ALTER TABLE "onetrust_forms" ALTER COLUMN "subject_type" SET DEFAULT 'Customer';
UPDATE "onetrust_forms" SET "subject_type" = 'Customer' WHERE "subject_type" = 'SubjectType3';
