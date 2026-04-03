-- Add Stytch user ID to accounts for session-based auth
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stytch_user_id TEXT UNIQUE;
