ALTER TABLE roles
  ADD COLUMN debug_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT roles_debug_enabled_boolean CHECK (debug_enabled IN (0,1));
