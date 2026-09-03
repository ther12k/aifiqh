# Runbook — auth subsystem

OIDC login, HMAC-signed session cookies with server-side revocation, RBAC
resolved from the database (`membership_roles ⋈ role_permissions`), CSRF
double-submit on writes. Sessions are short-lived; revocation is checked
against `auth_sessions` on every authenticated request.

## Auth Token Invalid

OIDC token validation failed.

1. Determine scope from the ledger: one principal or everyone.
2. Everyone → the provider rotated keys or changed issuer/audience: verify
   the OIDC discovery document and the configured issuer/client id; JWKS
   caching may need a service restart after rotation.
3. One principal → clock skew or a replayed/stale token; have the user sign
   in again. Repeated entries for one user → check their identity row
   (`user_identities`, unique issuer+subject) for duplication.
4. Never disable issuer/audience validation to "restore" login — fix the
   configuration instead.

## Auth Session Expired

A session was rejected during an authenticated operation.

1. This is expected at session lifetime end; the client should redirect to
   `/auth/login` and re-establish.
2. Bursts of expiry entries → check whether the session TTL config changed,
   or whether `auth_sessions` cleanup (the pruning delete on issuance) is
   keeping up.
3. `SESSION_REVOKED` reason codes alongside expiry → the user or an admin
   revoked the session (logout/rotation); no action needed.
4. Remember: an expired session fails closed server-side. The UI's
   permission hints (`/auth/me`) are advisory only — the server re-checks
   everything.
