import { useEffect, useState } from 'react'

interface Health {
	status: string
	components: { component: string; status: string }[]
}

export default function App() {
	const [health, setHealth] = useState<Health | null>(null)

	useEffect(() => {
		fetch('/health/components')
			.then((r) => r.json())
			.then(setHealth)
			.catch(() => setHealth(null))
	}, [])

	return (
		<main
			style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '3rem auto' }}
		>
			<h1>RZ-Fiqh</h1>
			<p>Citation-first Islamic jurisprudence assistant — MVP shell.</p>
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
			<p>
				<a href="/auth/login">Sign in</a>
			</p>
		</main>
	)
}
