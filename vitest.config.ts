import { defineConfig } from 'vitest/config'

/**
 * Tests cover the pure modules only — adapters and the table reducer — and run
 * in plain Node with no Electron and no browser. Filesystem access, IPC wiring,
 * app detection and React rendering are deliberately untested for the MVP.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false
  }
})
