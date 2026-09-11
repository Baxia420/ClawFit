CREATE UNIQUE INDEX IF NOT EXISTS "external_identities_user_google_uq" ON "external_identities" USING btree ("user_id") WHERE "provider" = 'google';
