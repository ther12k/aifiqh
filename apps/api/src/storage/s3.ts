/**
 * Minimal S3-compatible object storage client (SRC-002).
 *
 * Hand-rolled AWS SigV4 (PUT/GET/HEAD/DELETE/LIST, path-style) against the configured
 * S3-compatible endpoint (MinIO in dev) — no SDK dependency to pin, and the
 * surface is exactly what the upload pipeline needs. Objects are
 * content-addressed: key = originals/<sha256>, so identical bytes always
 * land on the same key and can never be silently overwritten with different
 * content.
 */
import { createHash, createHmac } from 'node:crypto'
import type { Config } from '../config'

const EMPTY_SHA = createHash('sha256').update('').digest('hex')

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256hex(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex')
}

export function contentKey(sha256: string): string {
	return `originals/${sha256}`
}

interface SigParts {
	method: string
	url: URL
	payloadSha: string
	contentType?: string
	additionalHeaders?: Record<string, string>
}

function signedHeaders(cfg: Config, parts: SigParts): Record<string, string> {
	const amzDate = new Date()
	// 2026-08-31T02:34:56.123Z -> 20260831T023456Z
	const stamp = amzDate
		.toISOString()
		.replaceAll(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z')
	const dateOnly = stamp.slice(0, 8)
	const region = cfg.storageRegion

	const headers: Record<string, string> = {
		host: parts.url.host,
		'x-amz-content-sha256': parts.payloadSha,
		'x-amz-date': stamp,
		...(parts.contentType ? { 'content-type': parts.contentType } : {}),
		...(parts.additionalHeaders ?? {}),
	}
	const signed = Object.keys(headers).sort()
	const canonicalHeaders = signed
		.map((k) => `${k}:${headers[k].trim()}\n`)
		.join('')
	const canonicalRequest = [
		parts.method,
		parts.url.pathname,
		parts.url.search.replace(/^\?/, ''),
		canonicalHeaders,
		signed.join(';'),
		parts.payloadSha,
	].join('\n')

	const scope = `${dateOnly}/${region}/s3/aws4_request`
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		stamp,
		scope,
		sha256hex(canonicalRequest),
	].join('\n')

	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${cfg.storageSecretKey}`, dateOnly), region), 's3'),
		'aws4_request',
	)
	const signature = createHmac('sha256', signingKey)
		.update(stringToSign, 'utf8')
		.digest('hex')

	return {
		...headers,
		authorization:
			`AWS4-HMAC-SHA256 Credential=${cfg.storageAccessKey}/${scope}, ` +
			`SignedHeaders=${signed.join(';')}, Signature=${signature}`,
	}
}

/** Store an immutable, content-addressed object. */
export async function putObject(
	cfg: Config,
	key: string,
	body: Buffer,
	contentType = 'application/octet-stream',
): Promise<void> {
	const url = new URL(`${cfg.storageEndpoint}/${cfg.storageBucket}/${key}`)
	const headers = signedHeaders(cfg, {
		method: 'PUT',
		url,
		payloadSha: sha256hex(body),
		contentType,
	})
	const res = await fetch(url, {
		method: 'PUT',
		headers,
		body: new Uint8Array(body),
		signal: AbortSignal.timeout(30_000),
	})
	if (!res.ok)
		throw new Error(
			`object PUT failed: ${res.status} ${await res.text().catch(() => '')}`,
		)
}

export interface ObjectStat {
	exists: boolean
	size?: number
	contentType?: string
}

export async function headObject(
	cfg: Config,
	key: string,
): Promise<ObjectStat> {
	const url = new URL(`${cfg.storageEndpoint}/${cfg.storageBucket}/${key}`)
	const headers = signedHeaders(cfg, {
		method: 'HEAD',
		url,
		payloadSha: EMPTY_SHA,
	})
	const res = await fetch(url, {
		method: 'HEAD',
		headers,
		signal: AbortSignal.timeout(10_000),
	})
	if (res.status === 404) return { exists: false }
	if (!res.ok) throw new Error(`object HEAD failed: ${res.status}`)
	return {
		exists: true,
		size: res.headers.get('content-length')
			? Number(res.headers.get('content-length'))
			: undefined,
		contentType: res.headers.get('content-type') ?? undefined,
	}
}

/** Fetch object bytes as a stream (the response body is passed through). */
export async function getObject(cfg: Config, key: string): Promise<Response> {
	const url = new URL(`${cfg.storageEndpoint}/${cfg.storageBucket}/${key}`)
	const headers = signedHeaders(cfg, {
		method: 'GET',
		url,
		payloadSha: EMPTY_SHA,
	})
	return fetch(url, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(30_000),
	})
}

/** Delete an object; S3 DELETE is a no-op (204) when the key is absent. */
export async function deleteObject(cfg: Config, key: string): Promise<void> {
	const url = new URL(`${cfg.storageEndpoint}/${cfg.storageBucket}/${key}`)
	const headers = signedHeaders(cfg, {
		method: 'DELETE',
		url,
		payloadSha: EMPTY_SHA,
	})
	const res = await fetch(url, {
		method: 'DELETE',
		headers,
		signal: AbortSignal.timeout(30_000),
	})
	if (!res.ok && res.status !== 404)
		throw new Error(`object DELETE failed: ${res.status}`)
}

function xmlDecode(s: string): string {
	return s
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&amp;', '&')
}

/**
 * Enumerate object keys under a prefix (list-objects-v2, following
 * continuation tokens — a long-lived dev bucket holds thousands of
 * content-addressed originals).
 */
export async function listObjects(
	cfg: Config,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = []
	let continuationToken: string | null = null
	for (;;) {
		const url = new URL(`${cfg.storageEndpoint}/${cfg.storageBucket}`)
		url.searchParams.set('list-type', '2')
		url.searchParams.set('prefix', prefix)
		if (continuationToken)
			url.searchParams.set('continuation-token', continuationToken)
		// SigV4 requires the canonical query string sorted by parameter name
		url.searchParams.sort()
		const headers = signedHeaders(cfg, {
			method: 'GET',
			url,
			payloadSha: EMPTY_SHA,
		})
		const res = await fetch(url, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(30_000),
		})
		if (!res.ok)
			throw new Error(
				`object LIST failed: ${res.status} ${await res.text().catch(() => '')}`,
			)
		const xml = await res.text()
		for (const m of xml.matchAll(/<Key>(.*?)<\/Key>/g))
			keys.push(xmlDecode(m[1]))
		if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return keys
		continuationToken =
			xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] ??
			null
		if (!continuationToken) return keys
		continuationToken = xmlDecode(continuationToken)
	}
}
