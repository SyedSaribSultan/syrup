-- Sign-in only: nothing reads Google's access, refresh or id tokens, so none are kept (audit 2026-11-17 F3).
UPDATE "accounts" SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL, "expires_at" = NULL, "session_state" = NULL;
