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
	// split-panel login (Taffaqquh AI brand): emerald brand panel + form card.
	// The mark mirrors apps/web/src/components/icons.tsx (mihrab arch framing
	// a speech bubble above an open book) so both surfaces read as one product.
	const brandMark = `
      <svg width="56" height="56" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M24 3.2C15.2 9.8 9.8 15.4 9.8 24.8V39h28.4V24.8c0-9.4-5.4-15-14.2-21.6z" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" fill="rgba(255,255,255,.06)"/>
        <path d="M24 11.6c5.1 0 9.2 3.2 9.2 7.4s-4.1 7.4-9.2 7.4c-.9 0-1.75-.1-2.55-.28l-4.05 2.08 1.05-3.5c-2.2-1.32-3.65-3.4-3.65-5.7 0-4.2 4.1-7.4 9.2-7.4z" fill="#fff"/>
        <circle cx="20.4" cy="19" r="1.25" fill="#0f7a5c"/>
        <circle cx="24" cy="19" r="1.25" fill="#0f7a5c"/>
        <circle cx="27.6" cy="19" r="1.25" fill="#0f7a5c"/>
        <path d="M24 30.4c-2.4-1.9-5.3-2.7-8.6-2.7-1.2 0-2.35.12-3.4.34v9c1.05-.22 2.2-.34 3.4-.34 3.3 0 6.2.82 8.6 2.7 2.4-1.88 5.3-2.7 8.6-2.7 1.2 0 2.35.12 3.4.34v-9c-1.05-.22-2.2-.34-3.4-.34-3.3 0-6.2.8-8.6 2.7z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>
        <path d="M24 30.6v8.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <path d="M13 42.4h22" stroke="#e5c88a" stroke-width="2.4" stroke-linecap="round"/>
      </svg>`
	const featIcon = (d) => `
      <span class="feat-dot" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg></span>`
	const brandPanel = `
  <div class="brand-side">
    <div class="arch-decor" aria-hidden="true"></div>
    <div class="brand-lockup">
      ${brandMark}
      <div>
        <div class="brand-name">Taffaqquh AI</div>
        <div class="brand-tag">Asisten Fiqih Berbasis Dalil</div>
      </div>
    </div>
    <h2>Pahami Fiqih melalui<br/><em>Dalil, Konteks, dan Sumber</em></h2>
    <blockquote>“Barang siapa menempuh jalan untuk mencari ilmu, Allah akan mudahkan baginya jalan menuju surga.”<span>— HR. Muslim</span></blockquote>
    <ul class="brand-feats">
      <li>${featIcon('M5 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H5V4zm18 0h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6V4z')}Bersumber pada Dalil</li>
      <li>${featIcon('M4 12l5 5L20 6')}Akurat &amp; Terverifikasi</li>
      <li>${featIcon('M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z')}Mendukung Pembelajaran</li>
      <li>${featIcon('M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.7C13.5 5 15 4 17 4c3.5 0 6 3.5 4.5 7-2 4.5-9 9-9 9z')}Untuk Umat yang Lebih Baik</li>
    </ul>
    <div class="brand-foot">Tanya &middot; Telusuri &middot; Pahami</div>
  </div>`
	return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,600;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f6f9f7; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 20px; }
  .shell { display: grid; grid-template-columns: 1.06fr 1fr; width: min(920px, 100%); border-radius: 24px; overflow: hidden; box-shadow: 0 24px 64px -20px rgba(15, 55, 42, .28); background: #fff; }
  .brand-side { position: relative; overflow: hidden; background: linear-gradient(168deg, #0f7a5c 0%, #0a523c 62%, #08402f 100%); color: #fff; padding: 44px 40px; display: flex; flex-direction: column; gap: 24px; }
  .arch-decor { position: absolute; inset: 0; pointer-events: none; background:
    radial-gradient(120% 60% at 100% 0%, rgba(229,200,138,.14), transparent 55%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160' fill='none'%3E%3Cpath d='M80 18c-26 20-40 38-40 66v58h80V84c0-28-14-46-40-66z' stroke='rgba(255,255,255,.07)' stroke-width='5'/%3E%3C/svg%3E") right -34px bottom -34px / 240px auto no-repeat; }
  .brand-lockup { position: relative; display: flex; align-items: center; gap: 15px; }
  .brand-name { font-size: 1.72rem; font-weight: 800; letter-spacing: -0.01em; }
  .brand-tag { font-size: .68rem; letter-spacing: .18em; text-transform: uppercase; color: #bcd9cb; font-weight: 700; margin-top: 3px; }
  .brand-side h2 { position: relative; font-family: 'Lora', Georgia, serif; font-size: 1.62rem; line-height: 1.35; margin: 6px 0 0; font-weight: 600; }
  .brand-side h2 em { font-style: italic; color: #ecd9ae; }
  .brand-side blockquote { position: relative; margin: 0; font-style: italic; color: #d9ece2; font-size: .92rem; line-height: 1.65; border-left: 3px solid rgba(229,200,138,.6); padding-left: 14px; }
  .brand-side blockquote span { display: block; margin-top: 8px; font-style: normal; font-size: .78rem; color: #a9cdbb; }
  .brand-feats { position: relative; list-style: none; margin: auto 0 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; font-size: .82rem; font-weight: 600; color: #e6f2ec; }
  .brand-feats li { display: flex; align-items: center; gap: 10px; }
  .feat-dot { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.14); color: #ecd9ae; flex: none; }
  .brand-foot { position: relative; font-size: .68rem; letter-spacing: .24em; text-transform: uppercase; color: #9dc7b3; border-top: 1px solid rgba(255,255,255,.14); padding-top: 14px; }
  main { display: grid; place-items: center; padding: 44px 40px; }
  form, .card { width: min(340px, 100%); }
  h1 { font-size: 1.4rem; margin: 0 0 6px; color: #12251e; text-align: center; letter-spacing: -0.01em; }
  .sub { text-align: center; color: #6b7f76; font-size: .85rem; line-height: 1.55; margin: 0 0 22px; }
  label { display: block; font-size: .78rem; font-weight: 700; margin: .9rem 0 .32rem; color: #37473f; letter-spacing: .02em; }
  input { width: 100%; padding: .72rem .85rem; border: 1px solid #d8e2dc; border-radius: 11px; font-size: .95rem; font-family: inherit; background: #fbfdfc; transition: border-color .15s ease, box-shadow .15s ease; }
  input:focus { outline: none; border-color: #0d6b4f; box-shadow: 0 0 0 3px rgba(13,107,79,.14); }
  button { margin-top: 1.45rem; width: 100%; padding: .82rem; border: 0; border-radius: 12px; background: linear-gradient(160deg, #0f8468, #0b5f4e); color: #fff; font-family: inherit; font-size: .98rem; font-weight: 700; letter-spacing: .01em; cursor: pointer; box-shadow: 0 6px 16px -6px rgba(13,107,79,.5); transition: filter .15s ease, transform .12s ease; }
  button:hover { filter: brightness(1.07); }
  button:active { transform: scale(.99); }
  button:focus-visible { outline: 3px solid rgba(13,107,79,.35); outline-offset: 2px; }
  .error { background: #fdecec; color: #8a1f1f; border: 1px solid #f5c2c2; border-radius: 10px; padding: .6rem .75rem; font-size: .85rem; margin-bottom: .5rem; }
  .note { margin-top: 20px; background: #eef7f2; border: 1px solid #d5e8de; border-radius: 12px; padding: .8rem .9rem; font-size: .78rem; color: #33544a; line-height: 1.55; display: flex; gap: 10px; }
  .note svg { flex: none; margin-top: 2px; color: #0d6b4f; }
  .note b { display: block; margin-bottom: 2px; color: #0a523c; }
  @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } .brand-side { display: none; } }
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
  <p class="sub">Masuk untuk melanjutkan perjalanan belajar Anda di ${'Taffaqquh AI'}.</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email.replace(/"/g, '&quot;')}" />
  <label for="password">Kata Sandi</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Masuk ke Taffaqquh AI</button>
  <div class="note"><span aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></span><span><b>Jawaban Berdasarkan Sumber Terpercaya</b>Setiap jawaban didasarkan pada dalil dari Al-Qur'an, Hadits, dan sumber terpercaya, dan dapat Anda verifikasi.</span></div>
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
				loginForm(uid, 'Masuk · Taffaqquh AI', null),
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
				loginForm(
					uid,
					'Masuk · Taffaqquh AI',
					'Email atau kata sandi salah.',
					email,
				),
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
