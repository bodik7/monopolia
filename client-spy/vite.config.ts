import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
      '/api':       { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  base: '/spy/',
  build: {
    outDir: '../public/spy',
    emptyOutDir: true,
  },
})
