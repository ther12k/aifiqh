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
	// split-panel login (Tafaqquh brand): emerald brand panel + form card
	const brandPanel = `
  <div class="brand-side">
    <div class="brand-lockup">
      <svg width="54" height="54" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M24 6c.4 3.1 1.8 5 4 6.6 3.1 2.2 5 4.6 5 8.4v3H15v-3c0-3.8 1.9-6.2 5-8.4 2.2-1.6 3.6-3.5 4-6.6z" fill="#fff"/>
        <path d="M24 3.2a2.8 2.8 0 1 0 2.4 4.3 2.3 2.3 0 1 1-1.1-4.2c-.4-.07-.86-.1-1.3-.1z" fill="#e5c88a"/>
        <path d="M10.5 24v-6.5M8.5 24h4M37.5 24v-6.5M35.5 24h4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
        <rect x="13" y="25.5" width="22" height="2.4" rx="1.2" fill="#e5c88a"/>
        <path d="M24 32.5c-2.6-2.1-5.8-3-9.5-3-1.4 0-2.7.14-3.9.4v11.6c1.2-.26 2.5-.4 3.9-.4 3.7 0 6.9.9 9.5 3 2.6-2.1 5.8-3 9.5-3 1.4 0 2.7.14 3.9.4V29.9c-1.2-.26-2.5-.4-3.9-.4-3.7 0-6.9.9-9.5 3z" stroke="#fff" stroke-width="2" fill="none" stroke-linejoin="round"/>
        <path d="M24 32.5V44" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div>
        <div class="brand-name">Tafaqquh</div>
        <div class="brand-tag">ILMU FIQIH, LEBIH MUDAH</div>
      </div>
    </div>
    <h2>Pahami Fiqih melalui<br/>Dalil, Konteks, dan Sumber</h2>
    <blockquote>“Bertanya tentang agama adalah jalan menuju kebaikan.”<span>— HR. Ibnu Majah</span></blockquote>
    <ul class="brand-feats">
      <li><span class="feat-dot">&#128214;</span>Bersumber pada Dalil</li>
      <li><span class="feat-dot">&#9989;</span>Akurat &amp; Terpercaya</li>
      <li><span class="feat-dot">&#128737;&#65039;</span>Mendukung Pembelajaran</li>
      <li><span class="feat-dot">&#10084;&#65039;</span>Untuk Umat yang Lebih Baik</li>
    </ul>
    <div class="brand-foot">Islamic knowledge for a brighter tomorrow</div>
  </div>`
	return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f6f9f7; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 20px; }
  .shell { display: grid; grid-template-columns: 1fr 1fr; width: min(880px, 100%); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 60px -18px rgba(15, 55, 42, .25); background: #fff; }
  .brand-side { background: linear-gradient(170deg, #0f7a5c, #0a4c3a 70%, #093f31); color: #fff; padding: 40px 36px; display: flex; flex-direction: column; gap: 22px; }
  .brand-lockup { display: flex; align-items: center; gap: 14px; }
  .brand-name { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.01em; }
  .brand-tag { font-size: .66rem; letter-spacing: .22em; color: #bcd9cb; font-weight: 700; margin-top: 2px; }
  .brand-side h2 { font-size: 1.5rem; line-height: 1.3; margin: 4px 0 0; font-weight: 700; }
  .brand-side blockquote { margin: 0; font-style: italic; color: #d9ece2; font-size: .95rem; line-height: 1.6; border-left: 3px solid #2e8f6f; padding-left: 14px; }
  .brand-side blockquote span { display: block; margin-top: 8px; font-style: normal; font-size: .78rem; color: #a9cdbb; }
  .brand-feats { list-style: none; margin: auto 0 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; font-size: .82rem; color: #d9ece2; }
  .brand-feats li { display: flex; align-items: center; gap: 8px; }
  .feat-dot { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,.12); font-size: .85rem; flex: none; }
  .brand-foot { font-size: .68rem; letter-spacing: .18em; text-transform: uppercase; color: #8fbfa8; border-top: 1px solid rgba(255,255,255,.14); padding-top: 14px; }
  main { display: grid; place-items: center; padding: 40px 36px; }
  form, .card { width: min(340px, 100%); }
  h1 { font-size: 1.35rem; margin: 0 0 6px; color: #12251e; text-align: center; }
  .sub { text-align: center; color: #6b7f76; font-size: .85rem; line-height: 1.5; margin: 0 0 22px; }
  label { display: block; font-size: .8rem; font-weight: 700; margin: .9rem 0 .3rem; color: #37473f; }
  input { width: 100%; padding: .68rem .8rem; border: 1px solid #d8e2dc; border-radius: 10px; font-size: .95rem; background: #fbfdfc; }
  input:focus { outline: none; border-color: #0d6b4f; box-shadow: 0 0 0 3px rgba(13,107,79,.14); }
  button { margin-top: 1.4rem; width: 100%; padding: .8rem; border: 0; border-radius: 10px; background: linear-gradient(160deg, #0f7a5c, #0a523c); color: #fff; font-size: 1rem; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(1.07); }
  .error { background: #fdecec; color: #8a1f1f; border: 1px solid #f5c2c2; border-radius: 8px; padding: .6rem .75rem; font-size: .85rem; margin-bottom: .5rem; }
  .note { margin-top: 20px; background: #eef7f2; border: 1px solid #d5e8de; border-radius: 10px; padding: .8rem .9rem; font-size: .78rem; color: #33544a; line-height: 1.55; display: flex; gap: 10px; }
  .note b { display: block; margin-bottom: 2px; color: #0a523c; }
  @media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .brand-side { display: none; } }
</style>
</head>
<body>
<div class="shell">
  ${brandPanel}
  <main>${body}</main>
</div>
</body>
</html>`
}

function loginForm(uid, title, error, email = '') {
	return page(
		title,
		`<form method="post" action="${ISSUER_PREFIX}/interaction/${uid}/login" class="card">
  <h1>Selamat Datang Kembali</h1>
  <p class="sub">Masuk ke akun Tafaqquh Anda untuk melanjutkan pembelajaran dan mendapatkan jawaban fiqih berbasis dalil.</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email.replace(/"/g, '&quot;')}" />
  <label for="password">Kata Sandi</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Masuk ke Tafaqquh</button>
  <div class="note"><span aria-hidden="true">&#128737;&#65039;</span><span><b>Jawaban Berdasarkan Sumber Terpercaya</b>Setiap jawaban didasarkan pada dalil dari Al-Qur'an, Hadits, dan sumber terpercaya, dan dapat Anda verifikasi.</span></div>
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
				loginForm(uid, 'Masuk Tafaqquh', null),
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
				loginForm(uid, 'Masuk Tafaqquh', 'Email atau kata sandi salah.', email),
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
