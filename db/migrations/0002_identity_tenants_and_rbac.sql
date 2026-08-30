-- DB-002: identity, tenants and RBAC
-- tenants, users, user_identities, tenant_memberships, roles, permissions,
-- role_permissions, membership_roles. Unique issuer+subject; unique
-- tenant/user membership; constrained role grants.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  primary_email text not null unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now()
);

create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  issuer text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  unique (issuer, subject)
);

create table tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- Role catalog: global templates (tenant_id null) and per-tenant instances.
create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  key text not null,
  name text not null,
  unique (tenant_id, key)
);

create table permissions (
  key text primary key,
  description text not null default ''
);

create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key)
);

create table membership_roles (
  membership_id uuid not null references tenant_memberships(id) on delete cascade,
  role_id uuid not null references roles(id),
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  primary key (membership_id, role_id)
);

create index idx_memberships_user on tenant_memberships(user_id);
create index idx_memberships_tenant on tenant_memberships(tenant_id);
create index idx_identities_user on user_identities(user_id);
