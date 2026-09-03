import { defineConfig } from '@playwright/test'

const dbUrl =
	process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@localhost:5434/aifiqh'
const storageEndpoint = process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000'

// Watcher-free on purpose: the API runs without --watch and the web app
// is served by `vite preview` from a fresh build — dev servers hit the
// host inotify limit (ENOSPC) on the shared machine, and preview is
// closer to what ships.
const API_PORT = '3100'

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	timeout: 60_000,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	use: {
		baseURL: 'http://127.0.0.1:5173',
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			command: 'bun run start',
			cwd: './apps/api',
			url: `http://127.0.0.1:${API_PORT}/healthz`,
			reuseExistingServer: false,
			timeout: 90_000,
			env: {
				...process.env,
				PORT: API_PORT,
				DATABASE_URL: dbUrl,
				STORAGE_ENDPOINT: storageEndpoint,
			},
		},
		{
			command:
				'sh -c "bun run build && bunx vite preview --port 5173 --strictPort"',
			cwd: './apps/web',
			url: 'http://127.0.0.1:5173',
			reuseExistingServer: false,
			timeout: 120_000,
			env: {
				...process.env,
				VITE_API_TARGET: `http://127.0.0.1:${API_PORT}`,
			},
		},
	],
	reporter: 'list',
})
