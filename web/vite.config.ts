import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from phones/tablets on the LAN
    proxy: { '/api': 'http://localhost:3001' },
  },
})
