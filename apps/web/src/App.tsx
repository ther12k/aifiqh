import { useCallback, useEffect, useState } from 'react'
import { ChatContainer } from './chat/ChatContainer'
import { ReviewerWorkspace } from './chat/ReviewerWorkspace'
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

function BrandMark({ small }: { small?: boolean }) {
	const size = small ? 26 : 40
	// mosque dome with crescent above an open book — Tafaqquh motif
	return (
		<svg
			className="brand-mark"
			width={size}
			height={size}
			viewBox="0 0 48 48"
			fill="none"
			aria-hidden="true"
		>
			{/* dome */}
			<path
				d="M24 4c.4 3.1 1.8 5 4 6.6 3.1 2.2 5 4.6 5 8.4v3H15v-3c0-3.8 1.9-6.2 5-8.4 2.2-1.6 3.6-3.5 4-6.6z"
				fill="#0d6b4f"
			/>
			{/* crescent finial */}
			<path
				d="M24 1.2a2.8 2.8 0 1 0 2.4 4.3 2.3 2.3 0 1 1-1.1-4.2c-.4-.07-.86-.1-1.3-.1z"
				fill="#c99a4b"
			/>
			{/* minarets */}
			<path
				d="M10.5 22v-6.5M8.5 22h4M11 15.5h-1M37.5 22v-6.5M35.5 22h4M37 15.5h-1"
				stroke="#0d6b4f"
				strokeWidth="1.6"
				strokeLinecap="round"
			/>
			{/* dome base band */}
			<rect x="13" y="23.5" width="22" height="2.4" rx="1.2" fill="#c99a4b" />
			{/* open book */}
			<path
				d="M24 30.5c-2.6-2.1-5.8-3-9.5-3-1.4 0-2.7.14-3.9.4v11.6c1.2-.26 2.5-.4 3.9-.4 3.7 0 6.9.9 9.5 3 2.6-2.1 5.8-3 9.5-3 1.4 0 2.7.14 3.9.4V27.9c-1.2-.26-2.5-.4-3.9-.4-3.7 0-6.9.9-9.5 3z"
				stroke="#0d6b4f"
				strokeWidth="2.2"
				strokeLinejoin="round"
				fill="#fff"
			/>
			<path
				d="M24 30.5V42"
				stroke="#0d6b4f"
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
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
	plus: 'M12 5v14M5 12h14',
	check: 'M4 12l5 5L20 6',
	shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z',
	heart:
		'M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.7C13.5 5 15 4 17 4c3.5 0 6 3.5 4.5 7-2 4.5-9 9-9 9z',
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

const NAV_SECTIONS: Array<{
	label: string
	items: Array<{ href: string; label: string; icon: string }>
}> = [
	{
		label: 'Menu Utama',
		items: [
			{ href: '#/chat', label: 'Chat', icon: ICON_PATHS.chat },
			{ href: '#/sources', label: 'Sumber', icon: ICON_PATHS.book },
			{
				href: '#/studio',
				label: 'Knowledge Studio',
				icon: ICON_PATHS.edit,
			},
			{
				href: '#/reviewer',
				label: 'Tinjauan Klaim',
				icon: ICON_PATHS.shield,
			},
			{
				href: '#/studio-dashboard',
				label: 'Dashboard',
				icon: ICON_PATHS.grid,
			},
		],
	},
	{
		label: 'Sistem',
		items: [
			{ href: '#/ops', label: 'Operations', icon: ICON_PATHS.activity },
			{ href: '#/health', label: 'Health', icon: ICON_PATHS.pulse },
		],
	},
]

/** hadith quote shown beside each page heading (real sources, per mockups) */
const PAGE_QUOTES: Record<string, { text: string; source: string }> = {
	'/sources': {
		text: 'Menuntut ilmu adalah jalan menuju ketakwaan.',
		source: 'HR. Ibnu Majah',
	},
	'/studio-dashboard': {
		text: 'Bertanya tentang agama adalah jalan menuju kebaikan.',
		source: 'HR. Ibnu Majah',
	},
	'/reviewer': {
		text: 'Kebenaran ilmu lahir dari ketelitian dalam menelusuri sumbernya.',
		source: 'Imam Al-Ghazali',
	},
	'/studio': {
		text: 'Sebaik-baik manusia adalah yang paling bermanfaat bagi manusia lainnya.',
		source: 'HR. Ahmad',
	},
	'/ops': {
		text: 'Sebaik-baik usaha adalah yang mendatangkan manfaat bagi manusia.',
		source: 'HR. Ahmad',
	},
	'/health': {
		text: 'Sesungguhnya Allah menyukai apabila seseorang bekerja, ia melakukannya dengan itqan (profesional dan sempurna).',
		source: 'HR. Al-Baihaqi',
	},
}

/** decorative mosque skyline for page headers (pure SVG, no assets) */
function SkylineDecor() {
	return (
		<svg
			className="page-decor"
			viewBox="0 0 220 90"
			fill="none"
			aria-hidden="true"
		>
			{/* arch frame */}
			<path
				d="M110 88V46c0-20 14-32 32-32s32 12 32 32v42"
				stroke="#cfe4da"
				strokeWidth="10"
				strokeLinecap="round"
			/>
			{/* central dome */}
			<path d="M78 88V64c0-9 7-15 16-15s16 6 16 15v24" fill="#dcece4" />
			<path
				d="M94 44v-6"
				stroke="#cfe4da"
				strokeWidth="3"
				strokeLinecap="round"
			/>
			{/* side minarets */}
			<path
				d="M52 88V58m-4 0h8M146 88V58m-4 0h8"
				stroke="#cfe4da"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			{/* palms */}
			<path
				d="M22 88V70m0 0c-5-2-9-1-12 2m12-2c5-2 9-1 12 2m-12-2c-1-4 0-7 2-9m-2 9c1-4 0-7-2-9"
				stroke="#cfe4da"
				strokeWidth="3"
				strokeLinecap="round"
			/>
			<path
				d="M196 88V72m0 0c-4-2-8-1-10 2m10-2c4-2 8-1 10 2"
				stroke="#cfe4da"
				strokeWidth="3"
				strokeLinecap="round"
			/>
			{/* ground line */}
			<path
				d="M8 88h204"
				stroke="#cfe4da"
				strokeWidth="3"
				strokeLinecap="round"
			/>
		</svg>
	)
}

/** serif hadith quote block for page headers */
function PageQuote({ quote }: { quote: { text: string; source: string } }) {
	return (
		<blockquote className="page-quote">
			<p>“{quote.text}”</p>
			<footer>— {quote.source}</footer>
		</blockquote>
	)
}

/** small icon features under the hero copy (reference landing) */
const LANDING_MINI_FEATURES = [
	{ icon: ICON_PATHS.shield, title: 'Berbasis Dalil Terverifikasi' },
	{ icon: ICON_PATHS.book, title: 'Dari Sumber Terpercaya' },
	{ icon: ICON_PATHS.heart, title: 'Mendukung Pembelajaran' },
	{ icon: ICON_PATHS.star, title: 'Untuk Umat yang Lebih Baik' },
]

/** five product cards under the hero — every link is a real route */
const LANDING_CARDS = [
	{
		icon: ICON_PATHS.chat,
		title: 'Chat Berbasis Dalil',
		desc: 'Tanyakan pertanyaan fiqih apa saja dan dapatkan jawaban yang jelas dengan rujukan dari Al-Qur’an, Hadits, dan kitab ulama.',
		href: '#/chat',
	},
	{
		icon: ICON_PATHS.book,
		title: 'Sumber Terpercaya',
		desc: 'Akses langsung ke rujukan klasik dan kontemporer dari ulama yang diakui, dengan informasi yang terstruktur dan mudah ditelusuri.',
		href: '#/sources',
	},
	{
		icon: ICON_PATHS.edit,
		title: 'Knowledge Studio',
		desc: 'Susun, kelola, dan kembangkan pengetahuan fiqih untuk pembelajaran yang lebih mendalam dan sistematis.',
		href: '#/studio',
	},
	{
		icon: ICON_PATHS.shield,
		title: 'Tinjauan Klaim',
		desc: 'Tinjau ulang jawaban AI, verifikasi sumber, dan pastikan akurasi dengan analisis mendalam terhadap dalil dan pendapat ulama.',
		href: '#/reviewer',
	},
	{
		icon: ICON_PATHS.pulse,
		title: 'Monitoring Sistem',
		desc: 'Pantau status komponen, performa sistem, dan kualitas jawaban secara real-time demi layanan yang selalu andal dan aman.',
		href: '#/health',
	},
]

/** how an answer earns trust — mirrors the API verification contract */
const LANDING_TRUST = [
	{
		icon: ICON_PATHS.book,
		title: 'Berbasis Sumber Asli',
		desc: 'Jawaban diambil dari Al-Qur’an, Hadits, dan kitab-kitab ulama yang kredibel.',
	},
	{
		icon: ICON_PATHS.check,
		title: 'Transparan dan Dapat Diverifikasi',
		desc: 'Setiap jawaban dilengkapi rujukan yang dapat ditelusuri ke sumber aslinya.',
	},
	{
		icon: ICON_PATHS.heart,
		title: 'Mendukung Pembelajaran',
		desc: 'Tidak hanya memberi jawaban, tetapi juga membantu memahami proses berdalil.',
	},
	{
		icon: ICON_PATHS.star,
		title: 'Untuk Umat yang Lebih Baik',
		desc: 'Kami percaya ilmu yang benar akan melahirkan keputusan yang baik.',
	},
]

/** decorative arch + quote card beside the trust section */
function TrustVisual() {
	return (
		<div className="trust-visual" aria-hidden="true">
			<svg
				className="trust-arch"
				viewBox="0 0 220 200"
				fill="none"
				role="presentation"
			>
				<path
					d="M30 192V96c0-44 36-76 80-76s80 32 80 76v96"
					stroke="#dcece4"
					strokeWidth="18"
				/>
				<path
					d="M110 66c-2 12-9 19-16 24-8 6-13 13-13 22v9h58v-9c0-9-5-16-13-22-7-5-14-12-16-24z"
					fill="#0d6b4f"
				/>
				<rect x="70" y="126" width="80" height="6" rx="3" fill="#c99a4b" />
				<path
					d="M78 132v40m64-40v40"
					stroke="#0d6b4f"
					strokeWidth="5"
					strokeLinecap="round"
				/>
			</svg>
			<p className="trust-quote-text">
				Cahaya Ilmu untuk Langkah yang Lebih Baik
			</p>
		</div>
	)
}

/** miniature app preview shown in the hero (pure markup, no screenshot) */
function HeroAppPreview() {
	const navItems: Array<[string, boolean]> = [
		['Chat', true],
		['Sumber', false],
		['Knowledge Studio', false],
		['Tinjauan Klaim', false],
		['Dashboard', false],
	]
	const chips = [
		'Apa hukum jual beli dengan riba?',
		'Bagaimana niat wudhu?',
		'Zakat profesi itu wajib?',
		'Hukum musik dalam Islam?',
	]
	return (
		<div
			className="hero-app"
			role="img"
			aria-label="Pratinjau aplikasi Tafaqquh"
		>
			<div className="hero-app-badge">
				<span className="hero-app-dot" aria-hidden="true" />
				Dalil Utamakan
			</div>
			<aside className="hero-app-side">
				<div className="hero-app-brand">
					<BrandMark small />
					<span>Tafaqquh</span>
				</div>
				<ul>
					{navItems.map(([label, active]) => (
						<li key={label} className={active ? 'is-active' : ''}>
							{label}
						</li>
					))}
				</ul>
				<div className="hero-app-side-sep" aria-hidden="true" />
				<span className="hero-app-side-dim">Operations</span>
				<span className="hero-app-side-dim">Health</span>
			</aside>
			<div className="hero-app-main">
				<span className="hero-app-lamp" aria-hidden="true">
					<svg
						width="30"
						height="30"
						viewBox="0 0 48 48"
						fill="none"
						role="presentation"
					>
						<path
							d="M24 6c.4 3.1 1.8 5 4 6.6 3.1 2.2 5 4.6 5 8.4v3H15v-3c0-3.8 1.9-6.2 5-8.4 2.2-1.6 3.6-3.5 4-6.6z"
							fill="#0d6b4f"
						/>
						<rect
							x="13"
							y="25.5"
							width="22"
							height="2.4"
							rx="1.2"
							fill="#c99a4b"
						/>
						<path
							d="M24 30.5c-2.6-2.1-5.8-3-9.5-3-1.4 0-2.7.14-3.9.4v11.6c1.2-.26 2.5-.4 3.9-.4 3.7 0 6.9.9 9.5 3 2.6-2.1 5.8-3 9.5-3 1.4 0 2.7.14 3.9.4V27.9c-1.2-.26-2.5-.4-3.9-.4-3.7 0-6.9.9-9.5 3z"
							stroke="#0d6b4f"
							strokeWidth="2.2"
							fill="#fff"
						/>
					</svg>
				</span>
				<b>Assalamu’alaikum</b>
				<span className="hero-app-sub">
					Tanyakan pertanyaan fiqih Anda dengan bebas.
				</span>
				<div className="hero-app-chips">
					{chips.map((c) => (
						<span key={c}>{c}</span>
					))}
				</div>
				<div className="hero-app-composer">
					Tanyakan pertanyaan fiqih di sini…
					<span className="hero-app-send" aria-hidden="true" />
				</div>
				<span className="hero-app-note">
					Jawaban disertai dalil dari Al-Qur’an, Hadits, dan sumber terpercaya.
				</span>
			</div>
		</div>
	)
}

/** in-page section scroll that keeps the hash router on the landing route */
function scrollToSection(id: string) {
	return () =>
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

function Landing({
	devLoginEnabled,
	authenticated,
}: {
	devLoginEnabled: boolean
	authenticated?: boolean
}) {
	return (
		<section className="landing" aria-label="Pengantar Tafaqquh">
			<div className="hero" id="beranda">
				<div className="hero-copy">
					<span className="landing-eyebrow">
						Ilmu Fiqih, Lebih Mudah, Lebih Terpercaya
					</span>
					<h1>
						Tanyakan Pertanyaan Fiqih Anda, Dapatkan Jawaban dengan{' '}
						<em>Dalil yang Jelas</em>
					</h1>
					<p>
						Tafaqquh adalah asisten AI untuk menjawab pertanyaan fiqih
						berdasarkan dalil dari sumber-sumber terpercaya, membantu Anda
						memahami hukum Islam dengan lebih mudah, akurat, dan mendalam.
					</p>
					<div className="landing-cta">
						{authenticated ? (
							<a className="btn-primary" href="#/chat">
								Buka Aplikasi
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M5 12h14M13 6l6 6-6 6" />
								</svg>
							</a>
						) : (
							<a className="btn-primary" href="/auth/login">
								Coba Sekarang Gratis
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M5 12h14M13 6l6 6-6 6" />
								</svg>
							</a>
						)}
						<button
							type="button"
							className="btn-play"
							onClick={scrollToSection('cara-kerja')}
						>
							<span className="btn-play-icon" aria-hidden="true">
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="currentColor"
									aria-hidden="true"
								>
									<path d="M8 5v14l11-7z" />
								</svg>
							</span>
							<span>
								<b>Lihat Cara Kerja</b>
								<small>Tiga lapis verifikasi jawaban</small>
							</span>
						</button>
					</div>
					<blockquote className="hero-quote">
						<p>
							“Barang siapa menempuh jalan untuk mencari ilmu, Allah akan
							mudahkan baginya jalan menuju surga.”
						</p>
						<footer>— HR. Muslim</footer>
					</blockquote>
					<ul className="hero-mini-features">
						{LANDING_MINI_FEATURES.map((f) => (
							<li key={f.title}>
								<span className="feature-icon">
									<NavIcon d={f.icon} />
								</span>
								<span>{f.title}</span>
							</li>
						))}
					</ul>
				</div>
				<HeroAppPreview />
			</div>

			<section className="feature-cards" id="fitur" aria-label="Fitur utama">
				{LANDING_CARDS.map((c) => (
					<article key={c.title} className="feature-card">
						<span className="feature-icon feature-icon-lg">
							<NavIcon d={c.icon} />
						</span>
						<h3>{c.title}</h3>
						<p>{c.desc}</p>
						<a href={c.href}>
							Pelajari lebih lanjut
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14M13 6l6 6-6 6" />
							</svg>
						</a>
					</article>
				))}
			</section>

			<section
				className="trust-band"
				id="cara-kerja"
				aria-label="Cara kerja verifikasi"
			>
				<div className="trust-intro">
					<h2>
						Jawaban yang Dapat Dipercaya, untuk Pemahaman Fiqih yang Lebih Baik
					</h2>
					<p>
						Tafaqquh dirancang untuk mengedepankan ketelitian, transparansi, dan
						pembelajaran. Setiap jawaban dilengkapi sumber yang jelas sehingga
						Anda dapat menelusuri dalil, memahami konteks, dan belajar lebih
						dalam.
					</p>
					{authenticated ? (
						<a className="btn-primary" href="#/chat">
							Buka Aplikasi
						</a>
					) : (
						<a className="btn-primary" href="/auth/login">
							Mulai Sekarang
						</a>
					)}
				</div>
				<ul className="trust-rows">
					{LANDING_TRUST.map((t) => (
						<li key={t.title}>
							<span className="feature-icon">
								<NavIcon d={t.icon} />
							</span>
							<div>
								<b>{t.title}</b>
								<p>{t.desc}</p>
							</div>
						</li>
					))}
				</ul>
				<TrustVisual />
			</section>

			{!authenticated && devLoginEnabled && (
				<p className="dev-login-note">
					<a href="/auth/dev-login?email=admin@example.com">
						Masuk Cepat (Dev Admin)
					</a>
				</p>
			)}
		</section>
	)
}

function PublicLanding({
	devLoginEnabled,
	authenticated,
}: {
	devLoginEnabled: boolean
	authenticated: boolean
}) {
	return (
		<div className="public-site">
			<header className="public-header">
				<a className="public-brand" href="#/" aria-label="Tafaqquh beranda">
					<BrandMark small />
					<span>
						<strong>Tafaqquh</strong>
						<small>Ilmu Fiqih, Lebih Mudah</small>
					</span>
				</a>
				<nav className="public-nav" aria-label="Navigasi publik">
					<a href="#/">Beranda</a>
					<button type="button" onClick={scrollToSection('fitur')}>
						Fitur
					</button>
					<button type="button" onClick={scrollToSection('cara-kerja')}>
						Tentang
					</button>
					<a href="#/health">Status</a>
				</nav>
				<div className="public-actions">
					{authenticated ? (
						<a className="public-nav-cta" href="#/chat">
							Buka Aplikasi
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14M13 6l6 6-6 6" />
							</svg>
						</a>
					) : (
						<>
							<a className="public-login" href="/auth/login">
								Masuk
							</a>
							<a className="public-nav-cta" href="/auth/login">
								Mulai Gratis
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<path d="M5 12h14M13 6l6 6-6 6" />
								</svg>
							</a>
						</>
					)}
				</div>
			</header>
			<main>
				<Landing
					devLoginEnabled={devLoginEnabled}
					authenticated={authenticated}
				/>
			</main>
			<footer className="public-footer">
				<span className="footer-brand-mini">
					<BrandMark small />
					<span>
						<b>Tafaqquh</b>
						<small>Ilmu Fiqih, Lebih Mudah</small>
					</span>
				</span>
				<nav className="public-footer-links" aria-label="Tautan footer">
					<a href="#/">Beranda</a>
					<button type="button" onClick={scrollToSection('fitur')}>
						Fitur
					</button>
					<a href="#/health">Status</a>
					{authenticated ? (
						<a href="#/chat">Aplikasi</a>
					) : (
						<a href="/auth/login">Masuk</a>
					)}
				</nav>
				<span>
					© {new Date().getFullYear()} Tafaqquh. Semua hak dilindungi.
				</span>
			</footer>
		</div>
	)
}

/** quick-jump keywords for the topbar search (real routes only) */
const SEARCH_ROUTES: Array<{ match: RegExp; hash: string }> = [
	{ match: /chat|tanya|fiqih|jawab/i, hash: '#/chat' },
	{ match: /sumber|source|kitab|hadis|qur/i, hash: '#/sources' },
	{ match: /studio|konsep|editor|draft/i, hash: '#/studio' },
	{ match: /dasbor|dashboard|kartu/i, hash: '#/studio-dashboard' },
	{ match: /ops|operasional|status|health|sehat/i, hash: '#/ops' },
]

/** Normalize a hash route before comparing it with a navigation destination. */
export function routePath(route: string): string {
	const path = route.split(/[?#]/, 1)[0].replace(/\/+$/, '')
	return path || '/'
}

export function isNavItemActive(route: string, href: string): boolean {
	const current = routePath(route)
	const target = routePath(href.replace(/^#/, ''))
	return target === '/'
		? current === '/'
		: current === target || current.startsWith(`${target}/`)
}

/** the strongest role the permission set implies — for the identity chip */
function roleLabel(permissions: string[]): string {
	if (permissions.includes('config:manage')) return 'Admin'
	if (permissions.includes('review:approve')) return 'Peninjau'
	if (permissions.includes('knowledge:draft')) return 'Editor'
	if (permissions.includes('knowledge:read')) return 'Pembaca'
	return 'Pengguna'
}

function roleAccent(permissions: string[]): string {
	if (permissions.includes('config:manage')) return 'accent-admin'
	if (permissions.includes('review:approve')) return 'accent-reviewer'
	if (permissions.includes('knowledge:draft')) return 'accent-editor'
	return 'accent-reader'
}

/** small health pill for the topbar; shows the worst component status */
function HealthPill({ health }: { health: Health | null }) {
	if (!health) {
		return (
			<span className="health-pill hp-down" title="Status tidak diketahui">
				<span className="hp-dot" aria-hidden="true" />
				API?
			</span>
		)
	}
	const allOk = health.components.every((c) => c.status === 'healthy')
	return (
		<a
			className={`health-pill ${allOk ? 'hp-ok' : 'hp-down'}`}
			href="#/ops"
			title={
				allOk
					? 'Semua komponen sehat'
					: 'Ada komponen bermasalah — buka status operasional'
			}
		>
			<span className="hp-dot" aria-hidden="true" />
			{allOk ? 'Sehat' : 'Terdegradasi'}
		</a>
	)
}

/** mockup-style system health page: banner, stat cards, component table */
function HealthPage({
	health,
	updatedAt,
	onRefresh,
}: {
	health: Health | null
	updatedAt: Date | null
	onRefresh: () => void
}) {
	const comps = health?.components ?? []
	const okCount = comps.filter((c) => c.status === 'healthy').length
	const badCount = comps.length - okCount
	const allOk = comps.length > 0 && badCount === 0

	if (!health) {
		return (
			<section aria-label="Kesehatan sistem" className="health-page">
				<p className="gate-note">
					Status sistem tidak dapat dimuat —{' '}
					<button type="button" className="link-btn" onClick={onRefresh}>
						coba perbarui
					</button>
					.
				</p>
			</section>
		)
	}

	return (
		<section aria-label="Kesehatan sistem" className="health-page">
			<div className={`health-banner ${allOk ? 'is-ok' : 'is-warn'}`}>
				<span className="health-banner-icon" aria-hidden="true">
					<NavIcon d={allOk ? ICON_PATHS.check : ICON_PATHS.activity} />
				</span>
				<div className="health-banner-text">
					<h3>
						{allOk
							? 'Semua sistem berjalan normal'
							: 'Ada komponen yang perlu perhatian'}
					</h3>
					<p>
						{allOk
							? 'Alhamdulillah, seluruh layanan platform berfungsi dengan baik.'
							: `${badCount} komponen tidak sehat — periksa daftar komponen di bawah.`}
					</p>
				</div>
				<div className="health-banner-side">
					<span className="health-updated">
						<span className="hp-dot" aria-hidden="true" />
						{updatedAt
							? `Diperbarui ${updatedAt.toLocaleTimeString('id-ID')}`
							: 'Memuat…'}
					</span>
					<button type="button" className="btn-refresh" onClick={onRefresh}>
						<NavIcon d={ICON_PATHS.pulse} />
						Perbarui Sekarang
					</button>
				</div>
			</div>

			<div className="health-stats">
				<div className="stat-card">
					<span className="stat-icon is-ok" aria-hidden="true">
						<NavIcon d={ICON_PATHS.shield} />
					</span>
					<div>
						<span className="stat-label">Komponen Sehat</span>
						<b className="stat-value">{okCount}</b>
					</div>
				</div>
				<div className="stat-card">
					<span className="stat-icon is-warn" aria-hidden="true">
						<NavIcon d={ICON_PATHS.activity} />
					</span>
					<div>
						<span className="stat-label">Perlu Perhatian</span>
						<b className="stat-value">{badCount}</b>
					</div>
				</div>
				<div className="stat-card">
					<span className="stat-icon" aria-hidden="true">
						<NavIcon d={ICON_PATHS.grid} />
					</span>
					<div>
						<span className="stat-label">Total Komponen</span>
						<b className="stat-value">{comps.length}</b>
					</div>
				</div>
			</div>

			<div className="health-grid">
				<div className="health-table-card">
					<h4>Daftar Komponen</h4>
					<p>Status setiap komponen platform saat ini.</p>
					<ul className="health-table">
						{comps.map((c) => (
							<li key={c.component}>
								<span className="health-comp-name">{c.component}</span>
								<span
									className={`badge ${c.status === 'healthy' ? 'badge-ok' : 'badge-danger'}`}
								>
									{c.status}
								</span>
							</li>
						))}
					</ul>
				</div>
				<aside className="health-quote-card">
					<p>
						“Sesungguhnya Allah menyukai apabila seseorang melakukan suatu
						pekerjaan, ia melakukannya dengan itqan (profesional dan sempurna).”
					</p>
					<footer>— HR. Al-Baihaqi</footer>
				</aside>
			</div>
		</section>
	)
}

export default function App() {
	const route = useHashRoute()
	const [health, setHealth] = useState<Health | null>(null)
	const [healthUpdated, setHealthUpdated] = useState<Date | null>(null)
	const [me, setMe] = useState<Me | null>(null)
	const [meLoading, setMeLoading] = useState(true)
	const [devLoginEnabled, setDevLoginEnabled] = useState(false)
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

	const loadHealth = useCallback(() => {
		fetch('/health/components')
			.then((r) => r.json())
			.then((h) => {
				setHealth(h)
				setHealthUpdated(new Date())
			})
			.catch(() => setHealth(null))
	}, [])

	useEffect(() => {
		loadHealth()
	}, [loadHealth])

	useEffect(() => {
		fetch('/auth/me')
			.then((r) => (r.ok ? r.json() : null))
			.then(setMe)
			.catch(() => setMe(null))
			.finally(() => setMeLoading(false))
	}, [])

	// the server decides whether the email-only dev shortcut exists at all;
	// real deployments answer false and the UI never renders its links
	useEffect(() => {
		fetch('/auth/bootstrap')
			.then((r) => (r.ok ? r.json() : null))
			.then((b: { devLoginEnabled?: boolean } | null) =>
				setDevLoginEnabled(b?.devLoginEnabled === true),
			)
			.catch(() => setDevLoginEnabled(false))
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

	if (route === '/') {
		return (
			<PublicLanding
				devLoginEnabled={devLoginEnabled}
				authenticated={Boolean(me)}
			/>
		)
	}

	return (
		<div className="app-layout">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<BrandMark />
					<div>
						<div className="brand-name">Tafaqquh</div>
						<div className="brand-sub">AI Fiqih Assistant</div>
					</div>
				</div>

				<a className="sidebar-cta" href="#/chat">
					<NavIcon d={ICON_PATHS.plus} />
					Chat Baru
				</a>

				<nav className="sidebar-nav" aria-label="main">
					{NAV_SECTIONS.map((section) => (
						<div className="nav-section" key={section.label}>
							<div className="nav-section-label">{section.label}</div>
							{section.items.map((item) => (
								<a
									key={item.href}
									href={item.href}
									className={
										isNavItemActive(route, item.href) ? 'active-nav' : ''
									}
								>
									<NavIcon d={item.icon} />
									{item.label}
								</a>
							))}
						</div>
					))}
				</nav>

				<div className="sidebar-quote" aria-hidden="true">
					<svg
						className="moon"
						width="22"
						height="22"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						role="presentation"
					>
						<path d={ICON_PATHS.moon} />
					</svg>
					<p className="sidebar-quote-text">
						Cahaya Ilmu untuk Langkah yang Lebih Baik
					</p>
				</div>

				<div className="sidebar-card">
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
							<span
								className={`avatar ${roleAccent(me.permissions)}`}
								aria-hidden="true"
							>
								{me.userId.slice(0, 2).toUpperCase()}
							</span>
							<span className="who">
								<b>{roleLabel(me.permissions)}</b>
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
							{devLoginEnabled && (
								<a href="/auth/dev-login?email=admin@example.com">
									<NavIcon d={ICON_PATHS.star} />
									Masuk Cepat (Dev Admin)
								</a>
							)}
							<a href="/auth/login">
								<NavIcon d={ICON_PATHS.logout} />
								Masuk (OIDC)
							</a>
						</div>
					)}
				</div>
			</aside>

			<div className="app-main">
				{/* compact navigation shown only on small screens (sidebar hidden) */}
				<nav className="mobile-nav" aria-label="Navigasi utama (mobile)">
					<a className="mobile-brand" href="#/">
						<BrandMark small />
						<span>Tafaqquh</span>
					</a>
					<button
						type="button"
						className="mobile-menu-toggle"
						aria-expanded={mobileMenuOpen}
						aria-controls="mobile-route-menu"
						onClick={() => setMobileMenuOpen((open) => !open)}
					>
						<span aria-hidden="true">☰</span>
						<span>Menu</span>
					</button>
					{me ? (
						<button type="button" className="mobile-logout" onClick={logout}>
							Keluar
						</button>
					) : (
						<a className="mobile-logout" href="/auth/login">
							Masuk
						</a>
					)}
					<div
						id="mobile-route-menu"
						className={`mobile-links ${mobileMenuOpen ? 'is-open' : ''}`}
					>
						{NAV_SECTIONS.map((section) => (
							<div className="mobile-link-group" key={section.label}>
								<span className="mobile-link-group-label">{section.label}</span>
								{section.items.map((item) => (
									<a
										key={item.href}
										href={item.href}
										className={
											isNavItemActive(route, item.href) ? 'active-mnav' : ''
										}
										onClick={() => setMobileMenuOpen(false)}
									>
										<NavIcon d={item.icon} />
										<span>{item.label}</span>
									</a>
								))}
							</div>
						))}
					</div>
				</nav>
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
					<HealthPill health={health} />
					{me ? (
						<div className="user-chip">
							<span
								className={`avatar ${roleAccent(me.permissions)}`}
								aria-hidden="true"
							>
								{me.userId.slice(0, 2).toUpperCase()}
							</span>
							<span className="who">
								<b>{roleLabel(me.permissions)}</b>
								<small>
									{me.tenantId
										? `Tenant ${me.tenantId.slice(0, 8)}`
										: 'Tanpa tenant'}
								</small>
							</span>
						</div>
					) : (
						<div className="tenant-chip">
							<small>Workspace</small>
							<b>Belum masuk</b>
						</div>
					)}
				</header>

				<main
					className={`app-content ${route === '/chat' ? 'app-content-chat' : ''}`}
				>
					{route === '/sources' && (
						<div className="page-head">
							<div className="page-head-main">
								<h2>Sumber Pengetahuan</h2>
								<p>
									Kelola referensi kitab dan dokumen yang menjadi basis jawaban.
								</p>
							</div>
							<PageQuote quote={PAGE_QUOTES['/sources']} />
							<SkylineDecor />
						</div>
					)}
					{route === '/studio-dashboard' && (
						<div className="page-head">
							<div className="page-head-main">
								<h2>
									Assalamu’alaikum, {me ? roleLabel(permissions) : 'Pengguna'}
								</h2>
								<p>
									Berikut ringkasan kesehatan sumber, pekerjaan terbuka, dan
									rilis pengetahuan hari ini.
								</p>
							</div>
							<PageQuote quote={PAGE_QUOTES['/studio-dashboard']} />
							<SkylineDecor />
						</div>
					)}
					{route === '/reviewer' && (
						<div className="page-head">
							<div className="page-head-main">
								<h2>Tinjauan Klaim</h2>
								<p>
									Tinjau dan verifikasi jawaban AI untuk memastikan akurasi,
									keandalan, dan kesesuaian dengan dalil.
								</p>
							</div>
							<PageQuote quote={PAGE_QUOTES['/reviewer']} />
							<SkylineDecor />
						</div>
					)}
					{route === '/ops' && (
						<div className="page-head">
							<div className="page-head-main">
								<h2>Operations</h2>
								<p>
									Pantau status sistem, layanan, dan kesehatan infrastruktur
									secara real-time.
								</p>
							</div>
							<PageQuote quote={PAGE_QUOTES['/ops']} />
							<SkylineDecor />
						</div>
					)}
					{route === '/studio' && (
						<div className="page-head">
							<div className="page-head-main">
								<h2>Knowledge Studio</h2>
								<p>
									Susun, kelola, dan kembangkan pengetahuan fiqih menjadi konten
									yang akurat dan terpercaya.
								</p>
							</div>
							<PageQuote quote={PAGE_QUOTES['/studio']} />
							<SkylineDecor />
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

					{route === '/reviewer' && (
						<ReviewerWorkspace permissions={permissions} />
					)}

					{route === '/ops' &&
						(permissions.includes('ops:read') ? (
							<OpsStatusContainer />
						) : (
							<p className="gate-note">
								<a href="/auth/login">Masuk</a> sebagai operator untuk melihat
								status operasional.
							</p>
						))}

					{route === '/health' && (
						<>
							<div className="page-head">
								<div className="page-head-main">
									<h2>Health</h2>
									<p>
										Pantau status sistem, layanan, dan kesehatan infrastruktur
										secara real-time.
									</p>
								</div>
								<PageQuote quote={PAGE_QUOTES['/health']} />
								<SkylineDecor />
							</div>
							<HealthPage
								health={health}
								updatedAt={healthUpdated}
								onRefresh={loadHealth}
							/>
						</>
					)}

					<footer className="app-footer">
						<span className="footer-brand">
							<BrandMark small />
							<span>
								<b>Tafaqquh</b>
								<small>Pahami Fiqih melalui Dalil, Konteks, dan Sumber</small>
							</span>
						</span>
						<nav className="footer-links" aria-label="Tautan footer">
							<a href="#/sources">Sumber</a>
							<a href="#/chat">Chat</a>
							<a href="#/ops">Status</a>
							{me ? null : <a href="/auth/login">Masuk</a>}
						</nav>
						<span className="footer-copy">
							{me ? (
								<>
									Masuk sebagai {me.userId.slice(0, 8)} · Tenant{' '}
									{me.tenantId?.slice(0, 8) ?? '—'}
								</>
							) : (
								<>
									{devLoginEnabled && (
										<>
											<a href="/auth/dev-login?email=admin@example.com">
												Masuk Cepat (Dev Admin)
											</a>
											{' · '}
										</>
									)}
									© {new Date().getFullYear()} Tafaqquh AI
								</>
							)}
						</span>
					</footer>
				</main>
			</div>
		</div>
	)
}
