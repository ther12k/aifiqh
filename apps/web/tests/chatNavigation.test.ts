import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import {
	filterConversations,
	partitionConversations,
} from '../src/lib/conversationOrganization'

/**
 * M6-015 (#163 / FR-12): Task-oriented chat shell, history, and navigation.
 *
 * Requirements:
 *  1. History search is honest: matches TITLES only, over the loaded page
 *     (never masquerades as full-corpus topic search).
 *  2. Three distinct history states:
 *     - loading (data-testid="history-loading")
 *     - error with retry action (data-testid="history-error")
 *     - empty: no history (data-testid="history-empty") vs
 *              no search matches (data-testid="history-empty-search").
 *  3. Sidebar layout structure:
 *     - Top: Brand / workspace identity, new chat button, history search.
 *     - Middle: Independently scrollable history (.history-scroll) with
 *       CSS text-overflow ellipsis for long titles.
 *     - Bottom: Other destinations (.ws-nav-bottom) pinned under history,
 *       remaining reachable regardless of scroll position.
 *  4. Mobile drawer & keyboard interaction:
 *     - Escape on open drawer closes it and restores focus to the toggle button.
 *     - Backdrop click closes drawer and restores focus.
 *     - Selecting an item closes drawer and restores focus.
 *     - Opening/closing drawer never resets draft or active conversation.
 *  5. Topbar search honesty: navigation shortcut, not false topic search.
 */

describe('M6-015: honest history search', () => {
	const sample = [
		{
			id: 'conv-1',
			title: 'Hukum Wudhu dengan Air Laut',
			updatedAt: '2026-09-12T10:00:00Z',
		},
		{
			id: 'conv-2',
			title: 'Perbedaan Zakat dan Sedekah',
			updatedAt: '2026-09-12T09:00:00Z',
		},
		{
			id: 'conv-3',
			title: 'Niat Shalat Jamak Qashar',
			updatedAt: '2026-09-11T12:00:00Z',
		},
	]

	test('matches title only, ignoring ID and non-title content', () => {
		expect(filterConversations(sample, 'zakat').map((c) => c.id)).toEqual([
			'conv-2',
		])
		expect(filterConversations(sample, 'WUDHU').map((c) => c.id)).toEqual([
			'conv-1',
		])
		// ID matching does not masquerade as title match
		expect(filterConversations(sample, 'conv-1')).toHaveLength(0)
		// Empty query returns all items unchanged
		expect(filterConversations(sample, '')).toHaveLength(3)
		expect(filterConversations(sample, '   ')).toHaveLength(3)
	})

	test('search input placeholder and tooltip are truthful in source', () => {
		const path = new URL('../src/chat/ChatContainer.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		expect(src).toContain('placeholder="Cari judul percakapan…"')
		expect(src).toContain(
			'title="Pencarian riwayat: mencocokkan judul percakapan yang dimuat"',
		)
		expect(src).toContain('history-search-clear')
	})

	test('topbar search copy identifies as navigation shortcut, not topic search', () => {
		const path = new URL('../src/chat/ChatContainer.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		expect(src).toContain(
			'placeholder="Pintas navigasi (chat, sumber, dasbor, ops)…"',
		)
		expect(src).not.toContain(
			'placeholder="Cari topik, dalil, atau pertanyaan…"',
		)
	})
})

describe('M6-015: distinct history list states', () => {
	test('source template defines loading, error with retry, empty, and no-results states', () => {
		const path = new URL('../src/chat/ChatContainer.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		// loading
		expect(src).toContain('data-testid="history-loading"')
		expect(src).toContain('Memuat riwayat…')
		// error with retry action
		expect(src).toContain('data-testid="history-error"')
		expect(src).toContain('Gagal memuat riwayat percakapan.')
		expect(src).toContain('data-testid="history-retry"')
		expect(src).toContain('onClick={() => void loadHistory()}')
		// empty (no history at all)
		expect(src).toContain('data-testid="history-empty"')
		expect(src).toContain('Belum ada riwayat percakapan.')
		// filtered search with no matches
		expect(src).toContain('data-testid="history-empty-search"')
		expect(src).toContain('Tidak ada percakapan dengan judul')
	})
})

describe('M6-015: sidebar layout & independent scroll structure', () => {
	test('CSS preserves ellipsis on long titles so layout width is not pushed', () => {
		const path = new URL('../src/index.css', import.meta.url).pathname
		const css = fs.readFileSync(path, 'utf8')
		expect(css).toContain('.history-item-title {')
		expect(css).toContain('text-overflow: ellipsis;')
		expect(css).toContain('white-space: nowrap;')
		expect(css).toContain('overflow: hidden;')
	})

	test('sidebar orders brand/new-chat/search on top, scroll in middle, other nav pinned at bottom', () => {
		const path = new URL('../src/chat/ChatContainer.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		const brandIdx = src.indexOf('sidebar-brand')
		const newChatIdx = src.indexOf('chat-new-btn')
		const searchIdx = src.indexOf('history-search')
		const scrollIdx = src.indexOf('history-scroll')
		const bottomNavIdx = src.indexOf('ws-nav-bottom')
		const footIdx = src.indexOf('sidebar-foot')

		expect(brandIdx).toBeGreaterThan(0)
		expect(newChatIdx).toBeGreaterThan(brandIdx)
		expect(searchIdx).toBeGreaterThan(newChatIdx)
		expect(scrollIdx).toBeGreaterThan(searchIdx)
		expect(bottomNavIdx).toBeGreaterThan(scrollIdx)
		expect(footIdx).toBeGreaterThan(bottomNavIdx)
	})
})

describe('M6-015: mobile drawer interaction and focus restoration', () => {
	test('drawer closes on Escape, backdrop click, or selection with focus restored to toggle button', () => {
		const path = new URL('../src/chat/ChatContainer.tsx', import.meta.url)
			.pathname
		const src = fs.readFileSync(path, 'utf8')
		// Escape on sidebar
		expect(src).toContain("e.key === 'Escape' && sidebarOpen")
		expect(src).toContain('sidebarToggleRef.current?.focus()')
		// Backdrop click
		expect(src).toContain(
			"className={`ws-backdrop ${sidebarOpen ? 'is-open' : ''}`}",
		)
		// Selection in history
		expect(src).toContain('setSidebarOpen(false)')
		// Toggle button has ref for focus restoration
		expect(src).toContain('ref={sidebarToggleRef}')
		expect(src).toContain('aria-expanded={sidebarOpen}')
	})
})
