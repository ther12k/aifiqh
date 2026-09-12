/**
 * Browser E2E (#103): the ops + studio dashboards, wired into the app
 * shell, must render live API data in a real browser.
 *
 * The seed runs as a bun subprocess (all TS/DI plumbing stays in bun
 * land); the spec only drives chromium. A session cookie is installed
 * directly — its value is HMAC-signed by the same config the API uses.
 */
import { execFileSync } from 'node:child_process'
import { type BrowserContext, type Page, expect, test } from '@playwright/test'

interface SeedOutput {
	cookieName: string
	cookieValue: string
	csrfValue: string
	failureMarker: string
}

let seed: SeedOutput

test.beforeAll(() => {
	const out = execFileSync('bun', ['apps/api/e2e/seed.ts'], {
		encoding: 'utf8',
		env: process.env,
		timeout: 120_000,
	})
	seed = JSON.parse(out.trim().split('\n').pop() as string)
})

async function newSessionedPage(context: BrowserContext): Promise<Page> {
	await context.addCookies([
		{
			name: seed.cookieName,
			value: seed.cookieValue,
			domain: '127.0.0.1',
			path: '/',
		},
		{
			name: 'aifiqh_csrf',
			value: seed.csrfValue,
			domain: '127.0.0.1',
			path: '/',
		},
	])
	return context.newPage()
}

test('ops dashboard renders live status and the seeded failure', async ({
	browser,
}) => {
	const context = await browser.newContext()
	const page = await newSessionedPage(context)
	await page.goto('/#/ops')
	await expect(page.locator('.ops-container')).toHaveAttribute(
		'data-state',
		'data',
		{ timeout: 15_000 },
	)
	const banner = page.getByTestId('ops-banner')
	await expect(banner).toBeVisible()
	await expect(banner).not.toHaveText('')
	await expect(page.getByTestId('ops-components')).toBeVisible()
	await expect(page.locator('.ops-component')).not.toHaveCount(0)
	// the seeded tenant-scoped failure is visible with its runbook link
	const ledger = page.getByTestId('ops-failures')
	await expect(ledger).toBeVisible()
	await expect(ledger).toContainText(seed.failureMarker)
	await expect(ledger.locator('a[href*="/runbooks/"]').first()).toBeVisible()
	await context.close()
})

test('studio dashboard renders card states and drilldown context', async ({
	browser,
}) => {
	const context = await browser.newContext()
	const page = await newSessionedPage(context)
	await page.goto('/#/studio-dashboard')
	await expect(page.locator('.studio-container')).toHaveAttribute(
		'data-state',
		'data',
		{ timeout: 15_000 },
	)
	await expect(page.getByTestId('studio-cards')).toBeVisible()
	// seeded data makes these cards 'data', not 'zero'
	await expect(page.locator('[data-card="source_health"]')).toHaveAttribute(
		'data-state',
		'data',
	)
	await expect(page.locator('[data-card="open_work"]')).toHaveAttribute(
		'data-state',
		'data',
	)
	// drill-down links preserve the dashboard context
	const link = page
		.locator('[data-card="source_health"] .studio-card-links a')
		.first()
	await expect(link).toHaveAttribute('href', /from=studio&card=source_health/)
	await context.close()
})

test('unauthenticated visitor is pointed to sign in', async ({ page }) => {
	await page.goto('/#/ops')
	await expect(page.getByRole('main')).toContainText('Masuk')
	await page.goto('/#/studio-dashboard')
	await expect(page.getByRole('main')).toContainText('Masuk')
	await page.goto('/#/chat')
	await expect(page.getByRole('main')).toContainText('Masuk')
})

test('chat interface submits query and reports honestly when no model is available', async ({
	browser,
}) => {
	// e2e runs with AIFIQH_CHAT_MODEL=off — the ANS-DUMP-001 contract says
	// the turn must fail honestly, never dress retrieved passages up as an
	// AI-concluded answer
	const context = await browser.newContext()
	const page = await newSessionedPage(context)
	await page.goto('/#/chat')
	await expect(page.locator('.chat-shell')).toBeVisible({ timeout: 15_000 })
	await page
		.locator('#chat-draft')
		.fill('Bagaimana hadits tentang amalan dan niat?')
	await page.locator('button[type="submit"]').click()
	const assistantMsg = page.locator(
		'.chat-messages li[data-role="assistant"]:not([data-streaming])',
	)
	await expect(assistantMsg).toBeVisible({ timeout: 30_000 })
	await expect(assistantMsg.last()).toHaveAttribute('data-status', 'failed')
	await expect(assistantMsg.last()).toContainText(
		'Jawaban belum berhasil disusun',
	)
	await context.close()
})
