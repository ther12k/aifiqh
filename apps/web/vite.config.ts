import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			'/auth': 'http://localhost:3000',
			'/healthz': 'http://localhost:3000',
			'/readyz': 'http://localhost:3000',
			'/sources': 'http://localhost:3000',
		},
	},
})
