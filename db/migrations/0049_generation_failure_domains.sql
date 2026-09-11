-- CAL-010/#145: generation failure domains + quota circuit breaker.
--
-- A failure domain is the ACCOUNT/PROXY/QUOTA POOL behind a provider — two
-- models behind the same proxy account are NOT independent fallbacks (the
-- 2026-09-11 429 incident exhausted the whole chain at once). provider_configs
-- carries an explicit failure_domain (NULL = the provider key itself).
--
-- generation_quota_domains is the circuit breaker state: 'open' means quota
-- exhausted — candidates in that domain are SKIPPED (no wasted failure
-- latency) until reset_at. Availability only truly improves with a second
-- INDEPENDENT domain (CAL-012); the breaker alone removes noise/latency.

alter table provider_configs
  add column failure_domain text;

create table generation_quota_domains (
  key text primary key,
  state text not null default 'closed' check (state in ('open', 'closed')),
  opened_at timestamptz,
  reset_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index idx_quota_domains_open on generation_quota_domains(state, reset_at);

grant select, insert, update, delete on generation_quota_domains to aifiqh_app;
