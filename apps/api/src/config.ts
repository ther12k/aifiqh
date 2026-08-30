import type { HealthStatus } from '@aifiqh/shared'

function required(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`Missing required env var: ${name}`)
	return v
}

function optional(name: string, fallback: string): string {
	return process.env[name] ?? fallback
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
	const envName = (optional('APP_ENV', 'development') ||
		'development') as Config['env']
	return {
		env: envName,
		port: Number(optional('PORT', '3000')),
		databaseUrl: optional(
			'DATABASE_URL',
			'postgres://aifiqh:aifiqh@localhost:5434/aifiqh',
		),
		storageEndpoint: optional('STORAGE_ENDPOINT', 'http://localhost:9000'),
		storageBucket: optional('STORAGE_BUCKET', 'aifiqh-originals'),
		storageAccessKey: optional('STORAGE_ACCESS_KEY', 'minioadmin'),
		storageSecretKey: optional('STORAGE_SECRET_KEY', 'minioadmin'),
		oidcIssuer: optional('OIDC_ISSUER', 'http://localhost:4011'),
		oidcClientId: optional('OIDC_CLIENT_ID', 'aifiqh-api'),
		oidcClientSecret: optional('OIDC_CLIENT_SECRET', 'dev-client-secret'),
		sessionSecret: optional('SESSION_SECRET', 'dev-session-secret-change-me'),
		sessionTtlSeconds: Number(optional('SESSION_TTL_SECONDS', '3600')),
		publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000'),
		logLevel: optional('LOG_LEVEL', 'info') as Config['logLevel'],
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
