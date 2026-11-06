-- AlterTable
ALTER TABLE "files_ai_verdicts" ADD COLUMN     "relevance" TEXT,
ADD COLUMN     "sensitivity" TEXT,
ADD COLUMN     "subject_involved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "large_file" BOOLEAN NOT NULL DEFAULT false;
