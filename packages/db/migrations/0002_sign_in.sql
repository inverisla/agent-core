CREATE TABLE "tenant_entra_orgs" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"entra_tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"tenant_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_tenant_id_token_hash_pk" PRIMARY KEY("tenant_id","token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entra_object_id" text;--> statement-breakpoint
ALTER TABLE "tenant_entra_orgs" ADD CONSTRAINT "tenant_entra_orgs_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_entra_object_id_key" UNIQUE("tenant_id","entra_object_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and "tenants"."slug" !~ '--');