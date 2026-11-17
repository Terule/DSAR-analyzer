ALTER TABLE "pipeline_settings" ADD COLUMN "rereview_min_p_keep" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN "rereview_sample_percent" DOUBLE PRECISION NOT NULL DEFAULT 2;
