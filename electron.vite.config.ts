import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // Adapters and the chord model are pure — no `fs`, no Electron — so the
        // renderer can import them directly to validate a chord as it is typed
        // rather than round-tripping to main for every keystroke.
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
