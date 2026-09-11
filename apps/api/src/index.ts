import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildApp } from './app'
import { createOidcClient } from './auth/oidc'
import { revokeDevSessions } from './auth/sessionStore'
import { config } from './config'
import { closeDb, db } from './db/client'
import { createLogger } from './logger'

const cfg = config()
const log = createLogger(cfg.logLevel, { service: 'api' })

// Disabling the dev shortcut must also invalidate what it issued: every
// session created through the email-only route is revoked server-side at
// startup when the flag is off (HARD-007).
if (!cfg.devLoginEnabled) {
	try {
		const revoked = await revokeDevSessions(db())
		if (revoked > 0) log.warn('revoked dev-issued sessions', { revoked })
	} catch (err) {
		// a cold database (first boot before migrations) has no table yet;
		// entrypoint migrates first, so this only guards odd startup orders
		log.warn('dev-session revocation skipped', {
			error: err instanceof Error ? err.message : 'unknown',
		})
	}
}

const app = buildApp({ cfg, log, sql: db(), oidc: createOidcClient(cfg) })

const webDistPath =
	process.env.WEB_DIST_PATH || join(import.meta.dir, '../../web/dist')

const API_PREFIX_REGEX =
	/^\/(auth|health|healthz|readyz|sources|studio|ops|eval|conversations|messages|answers|feedback|reviewer|imports|config|audit|ocr|retrieval|knowledge)(\/|$)/

function serveStaticAsset(pathname: string): Response | null {
	if (!existsSync(webDistPath)) return null
	const rel = pathname.replace(/^\/+/, '')
	if (rel) {
		const filePath = join(webDistPath, rel)
		if (existsSync(filePath) && statSync(filePath).isFile()) {
			// content-hashed bundles are safe to cache forever
			return new Response(Bun.file(filePath), {
				headers: { 'cache-control': 'public, max-age=31536000, immutable' },
			})
		}
	}
	const indexPath = join(webDistPath, 'index.html')
	if (existsSync(indexPath)) {
		// index.html must revalidate or a cached copy keeps serving old bundles
		return new Response(Bun.file(indexPath), {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
			},
		})
	}
	return null
}

const server = Bun.serve({
	port: cfg.port,
	// SSE needs room to breathe: the default 10s idle timeout resets
	// streaming connections (e.g. UX-AI-001 progress) that go quiet between
	// events. The progress endpoint heartbeats every 5s — 60s leaves margin.
	idleTimeout: 60,
	async fetch(req) {
		const url = new URL(req.url)
		if (
			!API_PREFIX_REGEX.test(url.pathname) &&
			(req.method === 'GET' || req.method === 'HEAD')
		) {
			const staticRes = serveStaticAsset(url.pathname)
			if (staticRes) return staticRes
		}
		return app.handle(req)
	},
})

log.info('api started', { port: server.port, env: cfg.env })

process.on('SIGINT', async () => {
	server.stop(true)
	await closeDb()
	process.exit(0)
})
process.on('SIGTERM', async () => {
	server.stop(true)
	await closeDb()
	process.exit(0)
})
