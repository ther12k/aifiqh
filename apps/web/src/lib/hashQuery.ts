/**
 * Hash-query helpers (M6-011): keep catalog filter state in the route
 * hash (`#/sources?q=...&open=...`) so reload, back/forward and shared
 * links restore exactly what the user saw. Pure — unit-testable.
 */

export interface HashLocation {
	path: string
	params: URLSearchParams
}

export function parseHashQuery(hash: string): HashLocation {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	const qIndex = raw.indexOf('?')
	if (qIndex === -1) return { path: raw, params: new URLSearchParams() }
	return {
		path: raw.slice(0, qIndex),
		params: new URLSearchParams(raw.slice(qIndex + 1)),
	}
}

export function serializeHashQuery(
	path: string,
	params: URLSearchParams,
): string {
	const qs = params.toString()
	return `#${path}${qs ? `?${qs}` : ''}`
}

/**
 * Update one param, dropping empty values so `#/sources?q=` never lingers.
 * Unknown params are preserved (forward-compatible with `open=`).
 */
export function withHashParam(
	hash: string,
	key: string,
	value: string,
): string {
	const { path, params } = parseHashQuery(hash)
	if (value) params.set(key, value)
	else params.delete(key)
	return serializeHashQuery(path, params)
}
