import type { HealthStatus } from '@aifiqh/shared'

function required(env: NodeJS.ProcessEnv, name: string): string {
	const v = env[name]
	if (!v) throw new Error(`Missing required env var: ${name}`)
	return v
}

function optional(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: string,
): string {
	return env[name] ?? fallback
}

export interface Config {
	env: 'development' | 'test' | 'production'
	port: number
	databaseUrl: string
	storageEndpoint: string
	storageBucket: string
	storageAccessKey: string
	storageSecretKey: string
	oidcIssuer: string
	oidcClientId: string
	oidcClientSecret: string
	sessionSecret: string
	sessionTtlSeconds: number
	publicBaseUrl: string
	logLevel: 'debug' | 'info' | 'warn' | 'error'
}

let cached: Config | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const envName = (optional(env, 'APP_ENV', 'development') ||
		'development') as Config['env']
	return {
		env: envName,
		port: Number(optional(env, 'PORT', '3000')),
		databaseUrl: optional(
			env,
			'DATABASE_URL',
			// dedicated non-superuser app role (migration 0020): RLS actually
			// applies to it, unlike the bootstrap superuser
			'postgres://aifiqh_app:aifiqh_app@localhost:5434/aifiqh',
		),
		storageEndpoint: optional(env, 'STORAGE_ENDPOINT', 'http://localhost:9000'),
		storageBucket: optional(env, 'STORAGE_BUCKET', 'aifiqh-originals'),
		storageAccessKey: optional(env, 'STORAGE_ACCESS_KEY', 'minioadmin'),
		storageSecretKey: optional(env, 'STORAGE_SECRET_KEY', 'minioadmin'),
		oidcIssuer: optional(env, 'OIDC_ISSUER', 'http://localhost:4011'),
		oidcClientId: optional(env, 'OIDC_CLIENT_ID', 'aifiqh-api'),
		oidcClientSecret: optional(env, 'OIDC_CLIENT_SECRET', 'dev-client-secret'),
		sessionSecret: optional(
			env,
			'SESSION_SECRET',
			'dev-session-secret-change-me',
		),
		sessionTtlSeconds: Number(optional(env, 'SESSION_TTL_SECONDS', '3600')),
		publicBaseUrl: optional(env, 'PUBLIC_BASE_URL', 'http://localhost:3000'),
		logLevel: optional(env, 'LOG_LEVEL', 'info') as Config['logLevel'],
	}
}

export function config(): Config {
	cached ??= loadConfig()
	return cached
}

export function healthFromConfig(
	checks: { component: string; ok: boolean; detail?: string }[],
): {
	status: HealthStatus
	components: { component: string; status: HealthStatus; detail?: string }[]
} {
	const components = checks.map((c) => ({
		component: c.component,
		status: (c.ok ? 'healthy' : 'unavailable') as HealthStatus,
		detail: c.detail,
	}))
	const status: HealthStatus = components.every((c) => c.status === 'healthy')
		? 'healthy'
		: components.some((c) => c.status === 'healthy')
			? 'degraded'
			: 'unavailable'
	return { status, components }
}

export { required }
