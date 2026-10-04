CREATE TYPE "public"."delegation_path" AS ENUM('immediate', 'proposal');--> statement-breakpoint
CREATE TABLE "delegation_changes" (
	"signature" text NOT NULL,
	"change_index" smallint NOT NULL,
	"issuer_id" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" bigint,
	"previous_key" text,
	"previous_mask" smallint NOT NULL,
	"operational_key" text NOT NULL,
	"mask" smallint NOT NULL,
	"path" "delegation_path" NOT NULL,
	"proposal" text,
	"signers" text[] NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegation_changes_signature_change_index_pk" PRIMARY KEY("signature","change_index"),
	CONSTRAINT "delegation_changes_signature_is_base58" CHECK (char_length("delegation_changes"."signature") between 64 and 88),
	CONSTRAINT "delegation_changes_masks_known" CHECK ("delegation_changes"."mask" between 0 and 7 and "delegation_changes"."previous_mask" between 0 and 7),
	CONSTRAINT "delegation_changes_proposal_matches_path" CHECK (("delegation_changes"."path" = 'proposal') = ("delegation_changes"."proposal" is not null)),
	CONSTRAINT "delegation_changes_named" CHECK (cardinality("delegation_changes"."signers") >= 1)
);
--> statement-breakpoint
ALTER TABLE "delegation_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delegation_changes" ADD CONSTRAINT "delegation_changes_issuer_id_issuers_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuers"("issuer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delegation_changes_issuer_slot_idx" ON "delegation_changes" USING btree ("issuer_id","slot");