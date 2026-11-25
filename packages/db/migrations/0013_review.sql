-- Task 11: review. The run column comes before the primary key that uses it.
-- The new job_status values are added inside the migrator's transaction, so no migration
-- applied in the same run may use them; later migrations that need them go on their own.
CREATE TYPE "public"."review_event_kind" AS ENUM('edit', 'approve', 'send_back');--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'awaiting_review';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'approved';--> statement-breakpoint
CREATE TABLE "review_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"run" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "review_event_kind" NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_tenant_id_job_id_attempt_pk";--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_tenant_id_job_id_run_attempt_pk" PRIMARY KEY("tenant_id","job_id","run","attempt");--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN "reviewed_fields" jsonb;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN "run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_events_tenant_id_job_id_idx" ON "review_events" USING btree ("tenant_id","job_id","created_at");