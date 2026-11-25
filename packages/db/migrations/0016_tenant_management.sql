CREATE TABLE "tenant_agents" (
	"tenant_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_agents_tenant_id_agent_name_pk" PRIMARY KEY("tenant_id","agent_name")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_agents" ADD CONSTRAINT "tenant_agents_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;