/**
 * SSRF guard for outbound fetchers (#111).
 *
 * Corpus acquisition (#117) will fetch provider URLs from API/server
 * processes that also hold database and secret-manager access. Any URL that
 * arrives from configuration, import manifests, or untrusted content must
 * pass this guard BEFORE a fetch is attempted: only public http(s)
 * endpoints on standard ports, no credentials, no IP literals or hostnames
 * that resolve into private infrastructure.
 *
 * The parser-level checks here are the first layer; the fetcher itself must
 * additionally resolve DNS and re-validate the CONNECTED IP against the
 * same ranges (TOCTOU: a DNS name can reroute between check and connect)
 * and redirect only to re-validated targets.
 */

export class UnsafeUrlError extends Error {
	constructor(
		public code: string,
		detail: string,
	) {
		super(`unsafe url (${code}): ${detail}`)
		this.name = 'UnsafeUrlError'
	}
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])

/** IPv4 ranges that must never be fetched: loopback, private, link-local
 * (incl. cloud metadata 169.254.169.254), CGNAT, multicast, reserved. */
function isPrivateIPv4(host: string): boolean {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!m) return false
	const [a, b] = [Number(m[1]), Number(m[2])]
	if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true // malformed
	if (a === 0 || a === 10 || a === 127) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	if (a >= 224) return true // multicast + reserved
	return false
}

function isPrivateIPv6(rawHost: string): boolean {
	const h = rawHost.toLowerCase().replace(/^\[|\]$/g, '')
	if (h === '::' || h === '::1') return true
	if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd'))
		return true // link-local + unique local
	if (h.startsWith('::ffff:')) return isPrivateIPv4(h.slice(7)) // v4-mapped
	return false
}

/** Hostnames that commonly bypass guards in cloud environments. */
function isSuspiciousHostname(host: string): boolean {
	const h = host.toLowerCase()
	return (
		h === 'localhost' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal') ||
		h === 'metadata.google.internal' ||
		h.endsWith('.localhost.localdomain')
	)
}

/**
 * Validate an outbound URL. Throws UnsafeUrlError on any violation;
 * returns the normalized URL string when safe.
 */
export function assertSafeFetchUrl(
	raw: string,
	options: { allowedHosts?: string[] } = {},
): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new UnsafeUrlError('UNPARSEABLE', raw)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new UnsafeUrlError('SCHEME', url.protocol)
	}
	if (url.username || url.password) {
		throw new UnsafeUrlError('CREDENTIALS', 'userinfo in url')
	}
	const host = url.hostname
	if (options.allowedHosts && options.allowedHosts.length > 0) {
		const h = host.toLowerCase()
		const allowed = options.allowedHosts.some(
			(a) => h === a.toLowerCase() || h.endsWith(`.${a.toLowerCase()}`),
		)
		if (!allowed) throw new UnsafeUrlError('HOST_NOT_ALLOWED', host)
	}
	// host-based verdicts come before port so the more specific violation
	// (private infrastructure) is what gets reported
	if (isSuspiciousHostname(host)) throw new UnsafeUrlError('HOST', host)
	if (isPrivateIPv4(host)) throw new UnsafeUrlError('PRIVATE_IP', host)
	if (isPrivateIPv6(host)) throw new UnsafeUrlError('PRIVATE_IP', host)
	if (!ALLOWED_PORTS.has(url.port)) {
		throw new UnsafeUrlError('PORT', url.port || '(nonstandard)')
	}
	return url.toString()
}
