-- PKCE (HARD-008): the authorization-code verifier is persisted server-side
-- next to the single-use login state, so only the S256 challenge ever
-- travels through the browser.
alter table auth_login_states
	add column if not exists code_verifier text;

-- the dev-login shortcut (HARD-007) must never exist on a real deployment;
-- any session it issued is revoked by application startup (revokeDevSessions)
create index if not exists auth_sessions_issuer_idx on auth_sessions (issuer);
