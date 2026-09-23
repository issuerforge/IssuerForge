DROP INDEX "events_mint_slot_idx";--> statement-breakpoint
CREATE INDEX "events_mint_slot_idx" ON "events" USING btree ("mint","slot","signature","event_index");