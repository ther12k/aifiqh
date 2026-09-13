import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
	parseHashQuery,
	serializeHashQuery,
	withHashParam,
} from '../src/lib/hashQuery'
import {
	SOURCE_TYPES,
	SUPPORTED_IMPORT_METHOD,
	validateRegistration,
} from '../src/lib/sourceRegister'

/**
 * M6-011 (FR-08): catalog search honesty — the placeholder matches the
 * fields actually filtered (title+author), the query survives a reload
 * through the route hash, and full-corpus search is NOT advertised.
 * M6-012 (FR-09): the registration form only offers real capabilities.
 */

describe('hashQuery — catalog state in the route hash', () => {
	test('round-trips q and open params; path stays clean', () => {
		const loc = parseHashQuery('#/sources?q=zakat&open=abc')
		expect(loc.path).toBe('/sources')
		expect(loc.params.get('q')).toBe('zabat' === 'zabat' ? 'zakat' : '')
		expect(loc.params.get('open')).toBe('abc')
		expect(serializeHashQuery(loc.path, loc.params)).toBe(
			'#/sources?q=zakat&open=abc',
		)
	})

	test('no query string → empty params, plain path', () => {
		const loc = parseHashQuery('#/sources')
		expect(loc.path).toBe('/sources')
		expect(loc.params.get('q')).toBeNull()
	})

	test('setting a value writes it; empty value removes the key entirely', () => {
		expect(withHashParam('#/sources', 'q', 'air')).toBe('#/sources?q=air')
		expect(withHashParam('#/sources?q=air&open=x', 'q', '')).toBe(
			'#/sources?open=x',
		)
		// unknown params survive (forward compatibility)
		expect(withHashParam('#/sources?open=x', 'q', 'kitab')).toBe(
			'#/sources?open=x&q=kitab',
		)
	})
})

describe('catalog honesty (verified against the actual filter)', () => {
	// The registry filter (SourceRegistry) matches `${title} ${author}`
	// ONLY — the old placeholder promised "kata kunci" the code never
	// searched. These assertions pin the honest copy in place.
	test('placeholder no longer promises keyword/content search', async () => {
		const fs = await import('fs')
		const path = new URL('../src/sources/SourceRegistry.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		expect(src).toContain('Cari judul atau penulis sumber')
		expect(src).not.toContain('kata kunci')
		// corpus search is NOT advertised from the catalog
		expect(src).not.toContain('Cari isi')
	})

	test('Tambah Sumber leads to the registration journey, not the concept editor', async () => {
		const fs = await import('fs')
		const path = new URL('../src/sources/SourceRegistry.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		expect(src).toContain('href="#/sources/register"')
		// Studio remains reachable, as its own separate task link
		expect(src).toContain('href="#/studio"')
	})
})

describe('registration form contract (M6-012)', () => {
	test('validation mirrors the server: required fields + enum membership', () => {
		const valid = {
			title: 'Kitab Zakat',
			author: 'Imam Syafii',
			sourceType: 'book',
			language: 'id',
			rightsStatus: 'public_domain',
			accessScopeId: '123e4567-e89b-42d3-a456-426614174000',
		}
		expect(validateRegistration(valid)).toEqual({ ok: true, invalid: [] })
		expect(validateRegistration({ ...valid, title: '   ' }).invalid).toContain(
			'title',
		)
		expect(
			validateRegistration({ ...valid, accessScopeId: 'not-a-uuid' }).invalid,
		).toContain('accessScopeId')
		expect(
			validateRegistration({ ...valid, sourceType: 'vhs_tape' }).invalid,
		).toContain('sourceType')
		expect(
			validateRegistration({ ...valid, rightsStatus: 'public domain' }).invalid,
		).toContain('rightsStatus')
	})

	test('only the actually-supported import method is offered (no fake capability ads)', () => {
		// exactly one channel exists today: file upload landing as a
		// pending_review revision
		expect(SUPPORTED_IMPORT_METHOD.id).toBe('file_upload')
		const copy = SUPPORTED_IMPORT_METHOD.label + SUPPORTED_IMPORT_METHOD.detail
		expect(copy).toContain('MENUNGGU TINJAUAN')
		// methods the product does not have must never appear in the form copy
		for (const absent of ['URL', 'OCR', 'crawl otomatis', 'bulk import']) {
			expect(copy).not.toContain(absent)
		}
		// the DB-accepted source types are the only options rendered
		expect(SOURCE_TYPES).toContain('book')
		expect(SOURCE_TYPES).not.toContain('vhs_tape')
	})
})

describe('registration view rendering (SSR)', () => {
	test('denied principals get an honest no-permission card, not a dead form', async () => {
		const { SourceRegisterView } = await import(
			'../src/sources/SourceRegisterView'
		)
		const html = renderToString(
			createElement(SourceRegisterView, { permissions: ['source:read'] }),
		)
		expect(html).toContain('tidak memiliki izin membuat sumber')
		expect(html).not.toContain('source-register-form')
	})

	test('permitted principals get the form with the honest method copy', async () => {
		const { SourceRegisterView } = await import(
			'../src/sources/SourceRegisterView'
		)
		const html = renderToString(
			createElement(SourceRegisterView, {
				permissions: ['source:read', 'source:create'],
			}),
		)
		expect(html).toContain('source-register-form')
		expect(html).toContain('Daftarkan sumber')
		// the Studio link is present but framed as the DIFFERENT task
		expect(html).toContain('#/studio')
		expect(html).toContain('tugas berbeda')
	})
})
