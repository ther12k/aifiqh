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
