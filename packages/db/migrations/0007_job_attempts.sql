CREATE TYPE "public"."attempt_outcome" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" "attempt_outcome" DEFAULT 'running' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_attempts_tenant_id_job_id_attempt_pk" PRIMARY KEY("tenant_id","job_id","attempt"),
	CONSTRAINT "job_attempts_attempt_positive" CHECK ("job_attempts"."attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","job_id") ON DELETE no action ON UPDATE no action;