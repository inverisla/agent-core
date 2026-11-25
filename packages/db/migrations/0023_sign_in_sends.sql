CREATE TABLE "email_link_sends" (
	"tenant_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_link_sends" ADD CONSTRAINT "email_link_sends_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_link_sends_tenant_id_sent_at_idx" ON "email_link_sends" USING btree ("tenant_id","sent_at");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_id_seq_idx" ON "audit_events" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "documents_tenant_id_created_at_idx" ON "documents" USING btree ("tenant_id","created_at");