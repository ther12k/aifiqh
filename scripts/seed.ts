/**
 * Dev seed: tenants, users + OIDC identities, memberships, role catalog
 * with permission grants, access scopes, and scope grants (PLAT-002).
 *
 * Accounts (login with the email as the dev OIDC login hint):
 *   admin@example.com  -> tenant_admin in tenant alpha
 *   editor@example.com -> editor in tenant alpha
 *   reviewer@example.com -> reviewer in tenant alpha
 *   reader@example.com -> reader in tenant alpha
 *   other-admin@example.com -> tenant_admin in tenant beta (isolation tests)
 */
import postgres from 'postgres'
import { config } from '../apps/api/src/config'
import {
	PERMISSIONS,
	ROLE_PERMISSIONS,
	type RoleKey,
} from '../packages/shared/src/index'

const sql = postgres(config().databaseUrl, { max: 1 })

const ROLES: RoleKey[] = [
	'tenant_admin',
	'editor',
	'reviewer',
	'reader',
	'operator',
	'service',
]

const USERS = [
	{
		email: 'admin@example.com',
		name: 'Admin Alpha',
		tenant: 'alpha',
		role: 'tenant_admin' as RoleKey,
	},
	{
		email: 'editor@example.com',
		name: 'Editor Alpha',
		tenant: 'alpha',
		role: 'editor' as RoleKey,
	},
	{
		email: 'reviewer@example.com',
		name: 'Reviewer Alpha',
		tenant: 'alpha',
		role: 'reviewer' as RoleKey,
	},
	{
		email: 'reader@example.com',
		name: 'Reader Alpha',
		tenant: 'alpha',
		role: 'reader' as RoleKey,
	},
	{
		email: 'other-admin@example.com',
		name: 'Admin Beta',
		tenant: 'beta',
		role: 'tenant_admin' as RoleKey,
	},
]

async function main() {
	const cfg = config()
	const issuer = cfg.oidcIssuer

	// role catalog + tenants + scopes are structural; the example.com test
	// identities are not (HARD-007): a production deployment must not grow
	// known privileged accounts just by booting. Override deliberately with
	// AIFIQH_SEED_DEMO_USERS=true if a staging clone wants them.
	const seedDemoUsers =
		cfg.env !== 'production' || process.env.AIFIQH_SEED_DEMO_USERS === 'true'

	for (const key of PERMISSIONS) {
		await sql`
      insert into permissions (key, description) values (${key}, ${key})
      on conflict (key) do nothing
    `
	}

	for (const role of ROLES) {
		await sql`
      insert into roles (tenant_id, key, name)
      values (null, ${role}, ${role})
      on conflict do nothing
    `
		const globalRole = await sql<{ id: string }[]>`
      select id from roles where tenant_id is null and key = ${role}
    `
		for (const perm of ROLE_PERMISSIONS[role]) {
			await sql`
        insert into role_permissions (role_id, permission_key)
        values (${globalRole[0].id}, ${perm})
        on conflict (role_id, permission_key) do nothing
      `
		}
	}

	for (const tenant of [
		{ slug: 'alpha', name: 'Tenant Alpha' },
		{ slug: 'beta', name: 'Tenant Beta' },
	]) {
		await sql`
      insert into tenants (slug, name) values (${tenant.slug}, ${tenant.name})
      on conflict (slug) do nothing
    `
	}

	const tenants = await sql<
		{ id: string; slug: string }[]
	>`select id, slug from tenants`

	for (const t of tenants) {
		await sql.begin(async (tx) => {
			await tx`select set_config('app.tenant_id', ${t.id}, true)`
			const [rootScope] = await tx<{ id: string }[]>`
	        insert into access_scopes (tenant_id, key, name)
	        values (${t.id}, 'root', 'Full corpus')
	        on conflict (tenant_id, key) do update set name = excluded.name
	        returning id
	      `
			const [restricted] = await tx<{ id: string }[]>`
	        insert into access_scopes (tenant_id, key, name, parent_scope_id)
	        values (${t.id}, 'restricted', 'Restricted works', ${rootScope.id})
	        on conflict (tenant_id, key) do update set name = excluded.name
	        returning id
	      `
			void restricted
		})
	}

	if (seedDemoUsers) {
		for (const u of USERS) {
			const tenant = tenants.find((t) => t.slug === u.tenant)
			if (!tenant) throw new Error(`unknown tenant ${u.tenant}`)

			await sql.begin(async (tx) => {
				await tx`select set_config('app.tenant_id', ${tenant.id}, true)`
				const [user] = await tx<{ id: string }[]>`
		        insert into users (primary_email, display_name)
		        values (${u.email}, ${u.name})
		        on conflict (primary_email) do update set display_name = excluded.display_name
		        returning id
		      `
				await tx`
		        insert into user_identities (user_id, issuer, subject)
		        values (${user.id}, ${issuer}, ${u.email})
		        on conflict (issuer, subject) do nothing
		      `
				const [membership] = await tx<{ id: string }[]>`
		        insert into tenant_memberships (tenant_id, user_id)
		        values (${tenant.id}, ${user.id})
		        on conflict (tenant_id, user_id) do update set status = 'active'
		        returning id
		      `
				const [role] = await tx<{ id: string }[]>`
		        select id from roles where tenant_id is null and key = ${u.role}
		      `
				await tx`
		        insert into membership_roles (membership_id, role_id)
		        values (${membership.id}, ${role.id})
		        on conflict (membership_id, role_id) do nothing
		      `
				const [rootScope] = await tx<{ id: string }[]>`
		        select id from access_scopes where tenant_id = ${tenant.id} and key = 'root'
		      `
				await tx`
		        insert into scope_grants (scope_id, principal_type, principal_id)
		        values (${rootScope.id}, 'membership', ${membership.id})
		        on conflict (scope_id, principal_type, principal_id) do nothing
		      `
			})
		}
	}

	console.log(
		`seed complete: 2 tenants, ${seedDemoUsers ? '5 users' : 'role catalog only'}, scope grants`,
	)
}

main()
	.then(() => sql.end({ timeout: 1 }))
	.catch(async (err) => {
		console.error(err)
		await sql.end({ timeout: 1 })
		process.exit(1)
	})
