CREATE TYPE "public"."sso_provider" AS ENUM('microsoft', 'google');--> statement-breakpoint
CREATE TABLE "tenant_sso" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"provider" "sso_provider" NOT NULL,
	"entra_tenant_id" uuid,
	"google_domain" text,
	"allow_email_links" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_sso_one_provider" CHECK (("tenant_sso"."provider" = 'microsoft' and "tenant_sso"."entra_tenant_id" is not null and "tenant_sso"."google_domain" is null)
        or ("tenant_sso"."provider" = 'google' and "tenant_sso"."google_domain" is not null and "tenant_sso"."entra_tenant_id" is null)),
	CONSTRAINT "tenant_sso_google_domain_format" CHECK ("tenant_sso"."google_domain" ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_subject" text;--> statement-breakpoint
ALTER TABLE "tenant_sso" ADD CONSTRAINT "tenant_sso_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_google_subject_key" UNIQUE("tenant_id","google_subject");