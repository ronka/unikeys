import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // The same target as `@renderer`. shadcn's CLI and every component it
        // generates assume `@/`, so carrying both is cheaper than rewriting
        // generated code after every `shadcn add`. Vite dedupes on the resolved
        // path, so a module imported under either alias is still one module.
        '@': resolve('src/renderer/src'),
        // Adapters and the chord model are pure — no `fs`, no Electron — so the
        // renderer can import them directly to validate a chord as it is typed
        // rather than round-tripping to main for every keystroke.
        '@shared': resolve('src/shared')
      }
    },
    // Tailwind belongs to the renderer only: main and preload are Node bundles
    // with no stylesheet to scan.
    plugins: [react(), tailwindcss()]
  }
})
