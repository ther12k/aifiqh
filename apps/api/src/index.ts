import { buildApp } from './app'
import { createOidcClient } from './auth/oidc'
import { config } from './config'
import { closeDb, db } from './db/client'
import { createLogger } from './logger'

const cfg = config()
const log = createLogger(cfg.logLevel, { service: 'api' })
const app = buildApp({ cfg, log, sql: db(), oidc: createOidcClient(cfg) })

const server = Bun.serve({
	port: cfg.port,
	fetch: (req) => app.handle(req),
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
