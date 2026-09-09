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
