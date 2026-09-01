ALTER TABLE email_login_challenges
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'sent'
  CHECK (delivery_state IN ('pending', 'sent', 'failed'));
