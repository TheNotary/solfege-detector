/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/solfege-detector/',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    // Keep Playwright specs (e2e/**) out of vitest's globs.
    exclude: ['node_modules', 'dist', 'e2e/**', 'playwright-report/**', 'test-results/**'],
  },
})
