CREATE TYPE "public"."holder_state" AS ENUM('pending', 'thawed', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."status_source" AS ENUM('issuer', 'provider');--> statement-breakpoint
CREATE TYPE "public"."token_state" AS ENUM('pending', 'live', 'paused');--> statement-breakpoint
CREATE TABLE "holders" (
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"issuer_id" text NOT NULL,
	"state" "holder_state" DEFAULT 'pending' NOT NULL,
	"tier" smallint,
	"jurisdiction" text,
	"status_source" "status_source",
	"denied" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"thawed_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_slot" bigint,
	"synced_at" timestamp with time zone,
	CONSTRAINT "holders_mint_wallet_pk" PRIMARY KEY("mint","wallet"),
	CONSTRAINT "holders_wallet_is_base58" CHECK (char_length("holders"."wallet") between 32 and 44),
	CONSTRAINT "holders_tier_in_range" CHECK ("holders"."tier" is null or "holders"."tier" between 0 and 255),
	CONSTRAINT "holders_jurisdiction_is_alpha2" CHECK ("holders"."jurisdiction" is null or "holders"."jurisdiction" ~ '^[A-Z]{2}$'),
	CONSTRAINT "holders_thawed_at_matches_state" CHECK (("holders"."state" = 'pending') = ("holders"."thawed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "holders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "issuers" (
	"issuer_id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"founder_wallet" text NOT NULL,
	"quorum_n" smallint NOT NULL,
	"operational_key" text,
	"delegation_mask" smallint DEFAULT 0 NOT NULL,
	"source_slot" bigint,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issuers_issuer_id_is_base58" CHECK (char_length("issuers"."issuer_id") between 32 and 44),
	CONSTRAINT "issuers_founder_is_base58" CHECK (char_length("issuers"."founder_wallet") between 32 and 44),
	CONSTRAINT "issuers_jurisdiction_is_alpha2" CHECK ("issuers"."jurisdiction" ~ '^[A-Z]{2}$'),
	CONSTRAINT "issuers_quorum_at_least_two" CHECK ("issuers"."quorum_n" >= 2),
	CONSTRAINT "issuers_delegation_mask_known" CHECK ("issuers"."delegation_mask" between 0 and 7)
);
--> statement-breakpoint
ALTER TABLE "issuers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"issuer_id" text NOT NULL,
	"member_index" smallint NOT NULL,
	"wallet" text NOT NULL,
	"roles" smallint NOT NULL,
	"source_slot" bigint NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "role_assignments_issuer_id_member_index_pk" PRIMARY KEY("issuer_id","member_index"),
	CONSTRAINT "role_assignments_wallet_is_base58" CHECK (char_length("role_assignments"."wallet") between 32 and 44),
	CONSTRAINT "role_assignments_member_index_in_range" CHECK ("role_assignments"."member_index" between 0 and 7),
	CONSTRAINT "role_assignments_roles_not_empty" CHECK ("role_assignments"."roles" between 1 and 15)
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tokens" (
	"mint" text PRIMARY KEY NOT NULL,
	"issuer_id" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" smallint NOT NULL,
	"policy_version" integer DEFAULT 0 NOT NULL,
	"state" "token_state" DEFAULT 'pending' NOT NULL,
	"source_slot" bigint,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_mint_issuer_key" UNIQUE("mint","issuer_id"),
	CONSTRAINT "tokens_mint_is_base58" CHECK (char_length("tokens"."mint") between 32 and 44),
	CONSTRAINT "tokens_decimals_in_range" CHECK ("tokens"."decimals" between 0 and 9),
	CONSTRAINT "tokens_policy_version_non_negative" CHECK ("tokens"."policy_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holders" ADD CONSTRAINT "holders_token_fk" FOREIGN KEY ("mint","issuer_id") REFERENCES "public"."tokens"("mint","issuer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_issuer_id_issuers_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("issuer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_issuer_id_issuers_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("issuer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holders_queue_idx" ON "holders" USING btree ("issuer_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_issuer_wallet_key" ON "role_assignments" USING btree ("issuer_id","wallet");--> statement-breakpoint
CREATE INDEX "role_assignments_wallet_idx" ON "role_assignments" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "tokens_issuer_idx" ON "tokens" USING btree ("issuer_id");