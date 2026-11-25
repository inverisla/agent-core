CREATE TABLE "job_outputs" (
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"fields" jsonb,
	"has_report" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_outputs_tenant_id_job_id_pk" PRIMARY KEY("tenant_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","job_id") ON DELETE no action ON UPDATE no action;