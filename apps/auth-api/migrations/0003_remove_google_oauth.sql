ALTER TABLE users RENAME COLUMN google_subject TO identity_key;

DROP TABLE oauth_flows;
DROP TABLE auth_exchange_codes;
