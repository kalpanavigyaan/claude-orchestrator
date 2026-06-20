import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Allow web-ide to import the shared theme from the electron renderer folder
      // without crossing package boundaries (Vite restricts serving files outside root).
      '../../fleet-console-electron/renderer/fleet-theme.css':
        path.resolve(__dirname, '../fleet-console-electron/renderer/fleet-theme.css'),
    },
  },
  // Serve files from the monorepo root so @import paths work in dev mode
  server: {
    fs: {
      allow: [
        path.resolve(__dirname, '..'),
      ],
    },
  },
})
