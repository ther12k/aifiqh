import { describe, expect, test } from 'bun:test'
import { createLogger, redact } from '../src/logger'

describe('log redaction (OBS-001)', () => {
	test('redacts sensitive keys at any depth', () => {
		const out = redact({
			user: { password: 'hunter2', name: 'ali' },
			authorization: 'Bearer xyz',
			nested: { accessToken: 't', cookie: 'a=b' },
		}) as unknown as {
			user: Record<string, string>
			authorization: string
			nested: Record<string, string>
		}
		expect(out.user.password).toBe('[REDACTED]')
		expect(out.user.name).toBe('ali')
		expect(out.authorization).toBe('[REDACTED]')
		expect(out.nested.accessToken).toBe('[REDACTED]')
		expect(out.nested.cookie).toBe('[REDACTED]')
	})

	test('treats keys with separators and case variants as sensitive', () => {
		const out = redact({
			client_secret: 's',
			set_cookie: 'x',
			ID_TOKEN: 't',
		}) as Record<string, string>
		expect(out.client_secret).toBe('[REDACTED]')
		expect(out.set_cookie).toBe('[REDACTED]')
		expect(out.ID_TOKEN).toBe('[REDACTED]')
	})

	test('errors are reduced to name+message (no stack noise)', () => {
		const out = redact(new Error('boom')) as { name: string; message: string }
		expect(out).toEqual({ name: 'Error', message: 'boom' })
	})
})

describe('structured logger', () => {
	test('emits one JSON line with ts/level/msg and fields', () => {
		const lines: string[] = []
		const log = createLogger('info', { service: 'test' }, (l) => lines.push(l))
		log.info('hello', { userId: 'u1' })
		const parsed = JSON.parse(lines[0])
		expect(parsed.level).toBe('info')
		expect(parsed.msg).toBe('hello')
		expect(parsed.service).toBe('test')
		expect(parsed.userId).toBe('u1')
		expect(parsed.ts).toBeDefined()
	})

	test('child loggers merge base fields', () => {
		const lines: string[] = []
		const log = createLogger('info', {}, (l) => lines.push(l)).child({
			tenantId: 't9',
		})
		log.warn('w')
		expect(JSON.parse(lines[0]).tenantId).toBe('t9')
	})

	test('respects level threshold', () => {
		const lines: string[] = []
		const log = createLogger('warn', {}, (l) => lines.push(l))
		log.debug('nope')
		log.warn('yes')
		expect(lines.length).toBe(1)
		expect(JSON.parse(lines[0]).level).toBe('warn')
	})
})
