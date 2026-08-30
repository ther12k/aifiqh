/**
 * Structured JSON logger with redaction. Sensitive keys never reach output;
 * free-text bodies are not logged by default (OBS-001 redaction policy).
 */

const REDACT_KEYS = new Set([
	'password',
	'secret',
	'token',
	'authorization',
	'cookie',
	'setcookie',
	'sessionsecret',
	'clientsecret',
	'idtoken',
	'accesstoken',
	'refreshtoken',
])

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type LogLevel = keyof typeof LEVELS

export function redact(value: unknown, depth = 0): unknown {
	if (depth > 6 || value === null || value === undefined) return value
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
	if (value instanceof Error) {
		return { name: value.name, message: value.message }
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = REDACT_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''))
				? '[REDACTED]'
				: redact(v, depth + 1)
		}
		return out
	}
	return value
}

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void
	info(msg: string, fields?: Record<string, unknown>): void
	warn(msg: string, fields?: Record<string, unknown>): void
	error(msg: string, fields?: Record<string, unknown>): void
	child(fields: Record<string, unknown>): Logger
}

export function createLogger(
	level: LogLevel,
	base: Record<string, unknown> = {},
	sink: (line: string) => void = (l) => console.log(l),
): Logger {
	function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
		if (LEVELS[lvl] < LEVELS[level]) return
		sink(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: lvl,
				msg,
				...(redact({ ...base, ...fields }) as Record<string, unknown>),
			}),
		)
	}
	return {
		debug: (m, f) => emit('debug', m, f),
		info: (m, f) => emit('info', m, f),
		warn: (m, f) => emit('warn', m, f),
		error: (m, f) => emit('error', m, f),
		child: (fields) => createLogger(level, { ...base, ...fields }, sink),
	}
}
