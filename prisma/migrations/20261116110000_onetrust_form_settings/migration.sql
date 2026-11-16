-- AlterTable
ALTER TABLE "onetrust_forms"
  ADD COLUMN "date_raised_field_key" TEXT NOT NULL DEFAULT 'formField81',
  ADD COLUMN "system_label" TEXT NOT NULL DEFAULT 'AIDA',
  ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en-gb',
  ADD COLUMN "subject_type" TEXT NOT NULL DEFAULT 'SubjectType3';
