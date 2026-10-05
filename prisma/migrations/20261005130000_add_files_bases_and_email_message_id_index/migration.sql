ALTER TABLE "case_requests" ADD COLUMN "files_doc_base" INTEGER, ADD COLUMN "files_msg_base" INTEGER;
CREATE INDEX "emails_message_id_idx" ON "emails"("message_id");
