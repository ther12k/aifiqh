// Minimal local OIDC provider for development (PLAT-002).
// Dev interactions are enabled: open http://localhost:4011/auth, enter any
// email as the login hint. The account is accepted verbatim for dev use.
import Provider from 'oidc-provider'

const ISSUER = process.env.ISSUER ?? 'http://localhost:4011'
const PORT = Number(process.env.PORT ?? 4011)

// Allow extra redirect URIs via env var (space-separated) for production domains
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
		return this.find(uid)
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
	clients: [
		{
			client_id: 'aifiqh-api',
			client_secret: 'dev-client-secret',
			redirect_uris: REDIRECT_URIS,
			post_logout_redirect_uris: POST_LOGOUT_URIS,
			grant_types: ['authorization_code'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_basic',
			scope: 'openid email profile',
		},
	],
	claims: {
		profile: ['name', 'preferred_username'],
		email: ['email', 'email_verified'],
	},
	features: {
		devInteractions: { enabled: true },
		registration: { enabled: false },
	},
	findAccount: async (_ctx, id) => ({
		accountId: id,
		claims: async () => ({
			sub: id,
			email: id.includes('@') ? id : `${id}@example.com`,
			email_verified: true,
			name: id,
			preferred_username: id,
		}),
	}),
})

provider.listen(PORT, () => console.log(`oidc-provider listening on ${ISSUER}`))
