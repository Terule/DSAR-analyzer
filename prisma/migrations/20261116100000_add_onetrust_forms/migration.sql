-- AlterTable
ALTER TABLE "managed_cases" ADD COLUMN "onetrust_form_id" TEXT;

-- CreateTable
CREATE TABLE "onetrust_forms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "api_token_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onetrust_forms_pkey" PRIMARY KEY ("id")
);
