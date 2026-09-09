/**
 * Hash-route helpers shared by every shell (public, chat, admin).
 */

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

/**
 * Routes that only make sense for a signed-in principal. An anonymous
 * visitor landing on one is redirected to the OIDC login instead of
 * seeing the app shell with a "Masuk" gate note.
 */
export const AUTH_REQUIRED_ROUTES = ['/chat'] as const

/**
 * Guard decision for the current route: 'allow' renders normally,
 * 'loading' waits for /auth/me, 'redirect' sends the visitor to login.
 */
export type AuthGuardDecision = 'allow' | 'loading' | 'redirect'

export function authGuardDecision(
	route: string,
	meKnown: boolean,
	authenticated: boolean,
): AuthGuardDecision {
	if (
		!AUTH_REQUIRED_ROUTES.includes(
			routePath(route) as (typeof AUTH_REQUIRED_ROUTES)[number],
		)
	) {
		return 'allow'
	}
	if (!meKnown) return 'loading'
	return authenticated ? 'allow' : 'redirect'
}

/** quick-jump keywords for the topbar search (real routes only) */
const SEARCH_ROUTES: Array<{ match: RegExp; hash: string }> = [
	{ match: /chat|tanya|fiqih|jawab/i, hash: '#/chat' },
	{ match: /sumber|source|kitab|hadis|qur/i, hash: '#/sources' },
	{ match: /studio|konsep|editor|draft/i, hash: '#/studio' },
	{ match: /dasbor|dashboard|kartu/i, hash: '#/studio-dashboard' },
	{ match: /ops|operasional|status|health|sehat/i, hash: '#/ops' },
]

/** resolve a free-text topbar query to the route it most likely means */
export function searchRouteFor(query: string): string | null {
	const hit = SEARCH_ROUTES.find((r) => r.match.test(query))
	return hit ? hit.hash : null
}
