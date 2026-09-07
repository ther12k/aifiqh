import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
// Minimal OIDC provider used by the AiFiqh stack (PLAT-002).
//
// This is NOT a login simulator: identity requires proof of possession of
// a credential provisioned out-of-band via the OIDC_ACCOUNTS env var.
// Unknown emails fail. devInteractions (accept-any-email) are disabled.
//
// Provisioning accounts (OIDC_ACCOUNTS, JSON array):
//   [
//     {"email": "admin@example.com", "name": "Admin Alpha",
//      "passwordScrypt": "<saltHex>:<hashHex>"}
//   ]
// Generate the hash with:  node index.js --hash 'the-password'
// A {"password": "..."} plaintext field also works but exists only for
// throwaway local environments — prefer passwordScrypt.
//
// PKCE S256 is REQUIRED on the only client; the app signs the authorization
// request with a challenge and proves possession at the token endpoint.
import { createServer } from 'node:http'
import Provider from 'oidc-provider'

const ISSUER = process.env.ISSUER ?? 'http://localhost:4011'
const PORT = Number(process.env.PORT ?? 4011)
const ISSUER_PREFIX = new URL(ISSUER).pathname.replace(/\/$/, '')

function parseAccounts() {
	// file-based provisioning preferred on servers: keeps credential
	// material out of the process environment (docker inspect visibility)
	const filePath = process.env.OIDC_ACCOUNTS_FILE
	const raw = filePath
		? readFileSync(filePath, 'utf8')
		: (process.env.OIDC_ACCOUNTS ?? '')
	if (!raw.trim()) {
		throw new Error(
			'OIDC_ACCOUNTS (or OIDC_ACCOUNTS_FILE) is required (JSON array of {email, name?, passwordScrypt|password}). ' +
				'Generate passwordScrypt with: node index.js --hash <password>',
		)
	}
	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error('OIDC_ACCOUNTS is not valid JSON')
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('OIDC_ACCOUNTS must be a non-empty JSON array')
	}
	const accounts = new Map()
	for (const entry of parsed) {
		if (!entry?.email) throw new Error('OIDC_ACCOUNTS entry missing email')
		if (!entry.passwordScrypt && !entry.password) {
			throw new Error(`OIDC_ACCOUNTS entry ${entry.email} has no credential`)
		}
		accounts.set(entry.email, {
			email: entry.email,
			name: entry.name ?? entry.email,
			passwordScrypt: entry.passwordScrypt ?? null,
			password: entry.password ?? null,
		})
	}
	return accounts
}

const ACCOUNTS = parseAccounts()

function verifyPassword(account, supplied) {
	if (typeof supplied !== 'string' || supplied.length === 0) return false
	if (account.passwordScrypt) {
		const parts = account.passwordScrypt.split(':')
		const [saltHex, hashHex] =
			parts.length === 3 ? [parts[1], parts[2]] : [parts[0], parts[1]]
		if (!saltHex || !hashHex) return false
		try {
			const expected = Buffer.from(hashHex, 'hex')
			const actual = scryptSync(
				supplied,
				Buffer.from(saltHex, 'hex'),
				expected.length,
			)
			return timingSafeEqual(actual, expected)
		} catch {
			return false
		}
	}
	if (account.password != null) {
		const a = Buffer.from(supplied)
		const b = Buffer.from(account.password)
		return a.length === b.length && timingSafeEqual(a, b)
	}
	return false
}

// Allow extra redirect URIs via env var (space-separated) for public domains
const EXTRA_REDIRECT_URIS = (process.env.EXTRA_REDIRECT_URIS ?? '')
	.split(' ')
	.map((u) => u.trim())
	.filter(Boolean)

const REDIRECT_URIS = [
	'http://localhost:3000/auth/callback',
	'http://localhost:5173/auth/callback',
	...EXTRA_REDIRECT_URIS,
]

const POST_LOGOUT_URIS = [
	'http://localhost:5173',
	...(process.env.POST_LOGOUT_URIS ?? '')
		.split(' ')
		.map((u) => u.trim())
		.filter(Boolean),
]

class MemoryAdapter {
	constructor(name) {
		this.name = name
		this.store = new Map()
	}
	key(id) {
		return `${this.name}:${id}`
	}
	async upsert(id, payload, expiresIn) {
		this.store.set(this.key(id), {
			payload,
			expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
		})
	}
	async find(id) {
		const entry = this.store.get(this.key(id))
		if (!entry) return undefined
		if (entry.expiresAt && Date.now() > entry.expiresAt) {
			this.store.delete(this.key(id))
			return undefined
		}
		return entry.payload
	}
	async findByUid(uid) {
		// the _session cookie carries the session UID, which differs from
		// the stored id (jti) — resolve by scanning payloads, not by id
		for (const entry of this.store.values()) {
			if (entry.payload?.uid === uid) {
				if (entry.expiresAt && Date.now() > entry.expiresAt) {
					return undefined
				}
				return entry.payload
			}
		}
		return undefined
	}
	async consume(id) {
		await this.upsert(id, {
			...(await this.find(id)),
			consumed: Math.floor(Date.now() / 1000),
		})
	}
	async destroy(id) {
		this.store.delete(this.key(id))
	}
	async revokeByGrantId() {}
}

const provider = new Provider(ISSUER, {
	adapter: MemoryAdapter,
	// custom login UI (credential check below) replaces devInteractions
	interactions: {
		url: (_ctx, interaction) =>
			`${ISSUER_PREFIX}/interaction/${interaction.uid}`,
	},
	clients: [
		{
			client_id: 'aifiqh-api',
			client_secret: process.env.OIDC_CLIENT_SECRET ?? 'dev-client-secret',
			redirect_uris: REDIRECT_URIS,
			post_logout_redirect_uris: POST_LOGOUT_URIS,
			grant_types: ['authorization_code'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_basic',
			// proof-of-possession for the code: no code interception replay
			pkceRequired: true,
			scope: 'openid email profile',
		},
	],
	claims: {
		profile: ['name', 'preferred_username'],
		email: ['email', 'email_verified'],
	},
	features: {
		devInteractions: { enabled: false },
		registration: { enabled: false },
	},
	findAccount: async (_ctx, id) => {
		const account = ACCOUNTS.get(id)
		if (!account) return undefined
		return {
			accountId: id,
			claims: async () => ({
				sub: id,
				email: account.email,
				// provisioned accounts own their email; linking to the matching
				// app account is the whole point of the credential gate
				email_verified: true,
				name: account.name,
				preferred_username: account.email,
			}),
		}
	},
})

if (process.env.OIDC_TRUST_PROXY === 'true') {
	// behind TLS-terminating proxy: honor X-Forwarded-* for proto/host
	provider.proxy = true
}

function page(title, body) {
	return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f1ea; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form, .card { background: #fff; border: 1px solid #e2ddd2; border-radius: 12px; padding: 2rem; width: min(360px, 90vw); box-shadow: 0 8px 24px rgba(0,0,0,.06); }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  label { display: block; font-size: .85rem; margin: .75rem 0 .25rem; color: #4a453a; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid #d8d2c4; border-radius: 8px; font-size: 1rem; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; border: 0; border-radius: 8px; background: #146c43; color: #fff; font-size: 1rem; cursor: pointer; }
  .error { background: #fdecec; color: #8a1f1f; border: 1px solid #f5c2c2; border-radius: 8px; padding: .6rem .75rem; font-size: .9rem; margin-bottom: .5rem; }
</style>
</head>
<body>${body}</body>
</html>`
}

function loginForm(uid, title, error, email = '') {
	return page(
		title,
		`<form method="post" action="${ISSUER_PREFIX}/interaction/${uid}/login" class="card">
  <h1>Masuk AiFiqh</h1>
  ${error ? `<div class="error">${error}</div>` : ''}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email.replace(/"/g, '&quot;')}" />
  <label for="password">Kata sandi</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Masuk</button>
</form>`,
	)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (c) => {
			size += c.length
			// bound request bodies even though only a login form is expected
			if (size > 16 * 1024) {
				reject(new Error('body too large'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

function send(res, status, contentType, body) {
	res.writeHead(status, { 'content-type': contentType })
	res.end(body)
}

async function handleInteraction(req, res) {
	const match = req.url.match(/\/interaction\/([A-Za-z0-9_-]+)/)
	if (!match) {
		send(res, 404, 'text/plain; charset=utf-8', 'not found')
		return
	}
	const uid = match[1]

	if (req.method === 'GET') {
		try {
			const details = await provider.interactionDetails(req, res)
			send(
				res,
				200,
				'text/html; charset=utf-8',
				loginForm(uid, 'Masuk AiFiqh', null),
			)
			void details
		} catch {
			send(res, 400, 'text/plain; charset=utf-8', 'invalid interaction')
		}
		return
	}

	if (req.method === 'POST' && req.url.endsWith('/login')) {
		const form = new URLSearchParams(await readBody(req))
		const email = (form.get('email') ?? '').trim().toLowerCase()
		const password = form.get('password') ?? ''
		const account = ACCOUNTS.get(email)
		if (!account || !verifyPassword(account, password)) {
			send(
				res,
				401,
				'text/html; charset=utf-8',
				loginForm(uid, 'Masuk AiFiqh', 'Email atau kata sandi salah.', email),
			)
			return
		}
		try {
			const { prompt, params, session } = await provider.interactionDetails(
				req,
				res,
			)
			// first-party app: consent is granted with the login in one step
			let grant
			if (session?.grantId) {
				grant = await provider.Grant.findById(session.grantId)
			} else {
				grant = new provider.Grant({
					accountId: account.email,
					clientId: params.client_id,
				})
			}
			grant.addOIDCScope(params.scope ?? 'openid email profile')
			const grantId = await grant.save()
			await provider.interactionFinished(
				req,
				res,
				{ login: { accountId: account.email }, consent: { grantId } },
				{ mergeWithLastSubmission: true },
			)
		} catch {
			send(res, 400, 'text/plain; charset=utf-8', 'interaction failed')
		}
		return
	}

	send(res, 404, 'text/plain; charset=utf-8', 'not found')
}

if (process.argv[2] === '--hash') {
	const password = process.argv[3]
	if (!password) {
		console.error('usage: node index.js --hash <password>')
		process.exit(1)
	}
	const salt = randomBytes(16)
	const hash = scryptSync(password, salt, 64)
	console.log(`scrypt:${salt.toString('hex')}:${hash.toString('hex')}`)
	process.exit(0)
}

// provider.callback is a factory: it returns the actual request listener
const handleProviderRequest = provider.callback()

createServer((req, res) => {
	if (ISSUER_PREFIX && req.url?.startsWith(ISSUER_PREFIX)) {
		req.originalUrl = req.url
		req.baseUrl = ISSUER_PREFIX
		req.url = req.url.slice(ISSUER_PREFIX.length) || '/'
	}
	if (req.url?.includes('/interaction/')) {
		handleInteraction(req, res).catch(() => {
			send(res, 500, 'text/plain; charset=utf-8', 'internal error')
		})
		return
	}
	handleProviderRequest(req, res)
}).listen(PORT, () => {
	console.log(
		`oidc-provider listening on ${ISSUER} (credential login, PKCE required)`,
	)
})
