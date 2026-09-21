CREATE TYPE "public"."event_kind" AS ENUM('transfer', 'refusal', 'compliance', 'attestation', 'thaw', 'holder_status');--> statement-breakpoint
CREATE TABLE "events" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"kind" "event_kind" NOT NULL,
	"issuer_id" text NOT NULL,
	"mint" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" bigint,
	"payload" jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_signature_event_index_pk" PRIMARY KEY("signature","event_index"),
	CONSTRAINT "events_signature_is_base58" CHECK (char_length("events"."signature") between 64 and 88),
	CONSTRAINT "events_mint_is_base58" CHECK (char_length("events"."mint") between 32 and 44),
	CONSTRAINT "events_slot_non_negative" CHECK ("events"."slot" >= 0)
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"program_id" text PRIMARY KEY NOT NULL,
	"last_signature" text NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "indexer_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issuers" DROP CONSTRAINT "issuers_jurisdiction_is_alpha2";--> statement-breakpoint
ALTER TABLE "issuers" ALTER COLUMN "legal_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issuers" ALTER COLUMN "jurisdiction" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "events_mint_slot_idx" ON "events" USING btree ("mint","slot","event_index");--> statement-breakpoint
CREATE INDEX "events_issuer_slot_idx" ON "events" USING btree ("issuer_id","slot");--> statement-breakpoint
ALTER TABLE "issuers" ADD CONSTRAINT "issuers_jurisdiction_is_alpha2" CHECK ("issuers"."jurisdiction" is null or "issuers"."jurisdiction" ~ '^[A-Z]{2}$');