CREATE SCHEMA "operator";
--> statement-breakpoint
CREATE TABLE "operator"."agent_test_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_name" text NOT NULL,
	"version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"repeats" integer NOT NULL,
	"cases" integer NOT NULL,
	"result" jsonb NOT NULL,
	"accuracy" double precision,
	"calls" integer NOT NULL,
	"tokens" bigint NOT NULL,
	"cost_usd" numeric(14, 8),
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator"."agent_versions" (
	"agent_name" text NOT NULL,
	"version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_name_version_pk" PRIMARY KEY("agent_name","version")
);
--> statement-breakpoint
ALTER TABLE "operator"."agent_test_runs" ADD CONSTRAINT "agent_test_runs_version_fkey" FOREIGN KEY ("agent_name","version") REFERENCES "operator"."agent_versions"("agent_name","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_test_runs_agent_idx" ON "operator"."agent_test_runs" USING btree ("agent_name","finished_at");--> statement-breakpoint
CREATE INDEX "jobs_tenant_id_updated_at_idx" ON "jobs" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "jobs_tenant_id_created_at_idx" ON "jobs" USING btree ("tenant_id","created_at");