import { useEffect, useState } from 'react'
import { ChatContainer } from './chat/ChatContainer'
import { ConceptEditor } from './knowledge/ConceptEditor'
import { OpsStatusContainer } from './ops/OpsStatusContainer'
import { SourceRegistry } from './sources/SourceRegistry'
import { StudioDashboardContainer } from './studio/StudioDashboardContainer'

interface Health {
	status: string
	components: { component: string; status: string }[]
}

interface Me {
	userId: string
	tenantId?: string
	permissions: string[]
}

const NULL_UUID = '00000000-0000-0000-0000-000000000000'

function useHashRoute(): string {
	const [route, setRoute] = useState(
		() => window.location.hash.replace(/^#/, '') || '/',
	)
	useEffect(() => {
		const onChange = () =>
			setRoute(window.location.hash.replace(/^#/, '') || '/')
		window.addEventListener('hashchange', onChange)
		return () => window.removeEventListener('hashchange', onChange)
	}, [])
	return route
}

/* --- inline icons (no external icon deps) ------------------------------- */

function BrandMark() {
	// eight-point geometric star (rubʿ al-hizb motif) in gold
	return (
		<svg
			className="brand-mark"
			width="40"
			height="40"
			viewBox="0 0 40 40"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M20 2 L24 12 L34 8 L30 18 L40 20 L30 22 L34 32 L24 28 L20 38 L16 28 L6 32 L10 22 L0 20 L10 18 L6 8 L16 12 Z"
				fill="none"
				stroke="#d9b36a"
				strokeWidth="1.6"
				strokeLinejoin="round"
			/>
			<circle
				cx="20"
				cy="20"
				r="6.5"
				fill="none"
				stroke="#d9b36a"
				strokeWidth="1.6"
			/>
			<circle cx="20" cy="20" r="2" fill="#d9b36a" />
		</svg>
	)
}

const ICON_PATHS: Record<string, string> = {
	chat: 'M4 5h16v11H8l-4 4V5z',
	book: 'M5 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H5V4zm18 0h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6V4z',
	edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14 7l3 3',
	grid: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
	activity: 'M3 12h4l3-8 4 16 3-8h4',
	pulse: 'M3 12h4l2-5 4 10 2-5h6',
	logout: 'M9 4H5v16h4M14 8l4 4-4 4M8 12h10',
	home: 'M4 11l8-7 8 7v9h-5v-6h-6v6H4v-9z',
	moon: 'M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z',
	star: 'M12 3l2.5 5.5L20 9.3l-4 4 .9 5.7L12 16.8 7.1 19l.9-5.7-4-4 5.5-.8L12 3z',
}

function NavIcon({ d }: { d: string }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	)
}

function SearchIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="M20 20l-3.5-3.5" />
		</svg>
	)
}

const NAV_ITEMS = [
	{ href: '#/chat', label: 'Chatbot', icon: ICON_PATHS.chat },
	{ href: '#/sources', label: 'Sources', icon: ICON_PATHS.book },
	{ href: '#/studio', label: 'Knowledge Studio', icon: ICON_PATHS.edit },
	{ href: '#/studio-dashboard', label: 'Dashboard', icon: ICON_PATHS.grid },
	{ href: '#/ops', label: 'Operations', icon: ICON_PATHS.activity },
	{ href: '#/', label: 'Health', icon: ICON_PATHS.pulse },
]

/** quick-jump keywords for the topbar search (real routes only) */
const SEARCH_ROUTES: Array<{ match: RegExp; hash: string }> = [
	{ match: /chat|tanya|fiqih|jawab/i, hash: '#/chat' },
	{ match: /sumber|source|kitab|hadis|qur/i, hash: '#/sources' },
	{ match: /studio|konsep|editor|draft/i, hash: '#/studio' },
	{ match: /dasbor|dashboard|kartu/i, hash: '#/studio-dashboard' },
	{ match: /ops|operasional|status|health|sehat/i, hash: '#/ops' },
]

export default function App() {
	const route = useHashRoute()
	const [health, setHealth] = useState<Health | null>(null)
	const [me, setMe] = useState<Me | null>(null)

	useEffect(() => {
		fetch('/health/components')
			.then((r) => r.json())
			.then(setHealth)
			.catch(() => setHealth(null))
	}, [])

	useEffect(() => {
		fetch('/auth/me')
			.then((r) => (r.ok ? r.json() : null))
			.then(setMe)
			.catch(() => setMe(null))
	}, [])

	const permissions = me?.permissions ?? []

	async function logout() {
		const csrfMatch = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
		const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : ''
		await fetch('/auth/logout', {
			method: 'POST',
			headers: { 'x-csrf-token': csrf },
		})
		window.location.reload()
	}

	function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key !== 'Enter') return
		const q = (e.target as HTMLInputElement).value
		const hit = SEARCH_ROUTES.find((r) => r.match.test(q))
		if (hit) {
			window.location.hash = hit.hash
			;(e.target as HTMLInputElement).value = ''
		}
	}

	return (
		<div className="app-layout">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<BrandMark />
					<div>
						<div className="brand-name">RZ-Fiqh</div>
						<div className="brand-sub">Fiqh Assistant</div>
					</div>
				</div>

				<nav className="sidebar-nav" aria-label="main">
					{NAV_ITEMS.map((item) => (
						<a
							key={item.href}
							href={item.href}
							className={route === item.href.slice(1) ? 'active-nav' : ''}
						>
							<NavIcon d={item.icon} />
							{item.label}
						</a>
					))}
				</nav>

				<div className="sidebar-card">
					<svg
						className="moon"
						width="34"
						height="34"
						viewBox="0 0 24 24"
						fill="none"
						stroke="#d9b36a"
						strokeWidth="1.6"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d={ICON_PATHS.moon} />
					</svg>
					<div className="sidebar-card-title">Kesehatan Sistem</div>
					<p className="sidebar-card-text">
						Pantau status komponen dan catatan kegagalan operasional secara
						langsung.
					</p>
					<a href="#/ops">Buka Status Operasional →</a>
				</div>

				<div className="sidebar-foot">
					{me ? (
						<div className="session-chip">
							<span className="avatar">
								{me.userId.slice(0, 2).toUpperCase()}
							</span>
							<span className="who">
								<b>{me.userId.slice(0, 8)}</b>
								<span>
									{me.tenantId
										? `tenant ${me.tenantId.slice(0, 8)}`
										: 'no tenant'}
								</span>
							</span>
							<button type="button" onClick={logout}>
								Keluar
							</button>
						</div>
					) : (
						<div className="login-links">
							<a href="/auth/dev-login?email=admin@example.com">
								<NavIcon d={ICON_PATHS.star} />
								Masuk Cepat (Dev Admin)
							</a>
							<a href="/auth/login">
								<NavIcon d={ICON_PATHS.logout} />
								Masuk (OIDC)
							</a>
						</div>
					)}
				</div>
			</aside>

			<div className="app-main">
				<header className="topbar">
					<div className="topbar-search">
						<SearchIcon />
						<input
							type="text"
							placeholder="Cari halaman: chat, sumber, dasbor, operasional…"
							onKeyDown={onSearchKeyDown}
							aria-label="Cari halaman"
						/>
						<kbd>⏎</kbd>
					</div>
					<div className="topbar-spacer" />
					<div className="tenant-chip">
						<small>Workspace</small>
						<b>
							{me?.tenantId
								? `Tenant ${me.tenantId.slice(0, 8)}`
								: 'Belum masuk'}
						</b>
					</div>
				</header>

				<main className="app-content">
					{route === '/chat' && (
						<div className="page-head">
							<h2>Chatbot</h2>
							<p>
								Tanya jawab fiqih dengan jawaban berbasis kutipan dalil — setiap
								klaim terhubung ke sumbernya.
							</p>
						</div>
					)}
					{route === '/sources' && (
						<div className="page-head">
							<h2>Sumber Pengetahuan</h2>
							<p>
								Kelola referensi kitab dan dokumen yang menjadi basis jawaban.
							</p>
						</div>
					)}
					{route === '/studio-dashboard' && (
						<div className="page-head">
							<h2>Dashboard Studio</h2>
							<p>Ringkasan kesehatan sumber, pekerjaan terbuka, dan rilis.</p>
						</div>
					)}
					{route === '/ops' && (
						<div className="page-head">
							<h2>Status Operasional</h2>
							<p>Kesehatan komponen layanan dan catatan kegagalan terbaru.</p>
						</div>
					)}

					{route === '/chat' &&
						(permissions.includes('knowledge:read') ? (
							<ChatContainer />
						) : (
							<p className="gate-note">
								<a href="/auth/login">Masuk</a> untuk memulai percakapan fiqih.
							</p>
						))}

					{route === '/sources' && <SourceRegistry permissions={permissions} />}

					{route === '/studio' &&
						(me?.tenantId ? (
							<ConceptEditor
								conceptId="new"
								accessScopeId={NULL_UUID}
								baseRevisionNumber={undefined}
							/>
						) : (
							<p className="gate-note">
								<a href="/auth/login">Masuk</a> untuk menyusun konsep.
							</p>
						))}

					{route === '/studio-dashboard' &&
						(permissions.includes('knowledge:read') ? (
							<StudioDashboardContainer />
						) : (
							<p className="gate-note">
								<a href="/auth/login">Masuk</a> untuk melihat dasbor studio.
							</p>
						))}

					{route === '/ops' &&
						(permissions.includes('ops:read') ? (
							<OpsStatusContainer />
						) : (
							<p className="gate-note">
								<a href="/auth/login">Masuk</a> sebagai operator untuk melihat
								status operasional.
							</p>
						))}

					{route === '/' && (
						<section>
							<div className="page-head">
								<h2>Service health</h2>
								<p>Kesehatan komponen platform saat ini.</p>
							</div>
							{health ? (
								<ul className="health-list">
									{health.components.map((c) => (
										<li key={c.component}>
											<span>{c.component}</span>
											<span
												className={`badge ${c.status === 'healthy' ? 'badge-ok' : 'badge-danger'}`}
											>
												{c.status}
											</span>
										</li>
									))}
								</ul>
							) : (
								<p className="gate-note">API unreachable</p>
							)}
						</section>
					)}

					<footer className="app-footer">
						<span>
							RZ-Fiqh — citation-first Islamic jurisprudence assistant
						</span>
						{me ? (
							<span>
								Masuk sebagai {me.userId.slice(0, 8)} · Tenant{' '}
								{me.tenantId?.slice(0, 8) ?? '—'}
							</span>
						) : (
							<span>
								<a href="/auth/dev-login?email=admin@example.com">
									Masuk Cepat (Dev Admin)
								</a>
								{' · '}
								<a href="/auth/login">Masuk (OIDC)</a>
							</span>
						)}
					</footer>
				</main>
			</div>
		</div>
	)
}
