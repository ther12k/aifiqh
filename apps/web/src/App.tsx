import { useEffect, useState } from 'react'
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

	return (
		<main
			style={{ fontFamily: 'system-ui', maxWidth: 760, margin: '3rem auto' }}
		>
			<h1>RZ-Fiqh</h1>
			<p>Citation-first Islamic jurisprudence assistant.</p>

			<nav aria-label="main">
				<a href="#/sources">Source Registry</a>
				{' | '}
				<a href="#/studio">Knowledge Studio</a>
				{' | '}
				<a href="#/studio-dashboard">Dasbor Studio</a>
				{' | '}
				<a href="#/ops">Status Operasional</a>
				{' | '}
				<a href="#/">Health</a>
			</nav>

			{route === '/sources' && <SourceRegistry permissions={permissions} />}

			{route === '/studio' &&
				(me?.tenantId ? (
					<ConceptEditor
						conceptId="new"
						accessScopeId={NULL_UUID}
						baseRevisionNumber={undefined}
					/>
				) : (
					<p>
						<a href="/auth/login">Masuk</a> untuk menyusun konsep.
					</p>
				))}

			{route === '/studio-dashboard' &&
				(permissions.includes('knowledge:read') ? (
					<StudioDashboardContainer />
				) : (
					<p>
						<a href="/auth/login">Masuk</a> untuk melihat dasbor studio.
					</p>
				))}

			{route === '/ops' &&
				(permissions.includes('ops:read') ? (
					<OpsStatusContainer />
				) : (
					<p>
						<a href="/auth/login">Masuk</a> sebagai operator untuk melihat
						status operasional.
					</p>
				))}

			{route === '/' && (
				<section>
					<h2>Service health</h2>
					{health ? (
						<ul>
							{health.components.map((c) => (
								<li key={c.component}>
									{c.component}: <strong>{c.status}</strong>
								</li>
							))}
						</ul>
					) : (
						<p>API unreachable</p>
					)}
				</section>
			)}

			<p>
				<a href="/auth/login">Sign in</a>
			</p>
		</main>
	)
}
