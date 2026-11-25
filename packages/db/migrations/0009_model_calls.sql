CREATE TYPE "public"."model_call_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "model_calls" (
	"call_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"step" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"outcome" "model_call_outcome" NOT NULL,
	"error_code" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8),
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_calls_counts_not_negative" CHECK ("model_calls"."input_tokens" >= 0 and "model_calls"."output_tokens" >= 0 and "model_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_tenant_id_job_id_idx" ON "model_calls" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "model_calls_tenant_id_created_at_idx" ON "model_calls" USING btree ("tenant_id","created_at");