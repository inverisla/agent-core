CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'operator', 'setup', 'system');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"tenant_id" uuid NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "sign_in_refusals" (
	"tenant_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"reason" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sign_in_refusals_tenant_id_hour_method_reason_pk" PRIMARY KEY("tenant_id","hour","method","reason")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_refusals" ADD CONSTRAINT "sign_in_refusals_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");