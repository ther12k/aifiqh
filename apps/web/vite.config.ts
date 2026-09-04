import react from '@vitejs/plugin-react'
import { type ProxyOptions, defineConfig } from 'vite'

// E2E runs the API on a dedicated port so it never collides with (or
// silently reuses) another project's dev server on the shared machine
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000'
const port = Number(process.env.VITE_PORT ?? '5173')
const proxy: Record<string, ProxyOptions> = {
	'/auth': apiTarget,
	'/healthz': apiTarget,
	'/health': apiTarget,
	'/readyz': apiTarget,
	'/sources': apiTarget,
	'/studio': apiTarget,
	'/ops': apiTarget,
	'/eval': apiTarget,
	'/conversations': apiTarget,
	'/answers': apiTarget,
}

export default defineConfig({
	plugins: [react()],
	server: {
		port,
		proxy,
	},
	preview: {
		port,
		proxy,
	},
})
