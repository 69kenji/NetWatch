import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // Built renderer is loaded directly from dist/ by Electron in normal local runs.
  base: './',
  server: {
    watch: {
      usePolling: true,
      interval: 250,

      // Windows Vite is reading the repo through WSL.
      // Never traverse Docker runtime state or large native resources.
      ignored: /(^|[\\/])(docker|backend|resources|dist|node_modules|\.git)([\\/]|$)/,
    },
  },

  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.code === 'MODULE_LEVEL_DIRECTIVE'
          && warning.message.includes('"use client"')
          && /[\\/]node_modules[\\/](iconoir-react|framer-motion)[\\/]/u.test(warning.id || '')
        ) return
        warn(warning)
      },
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        player: fileURLToPath(new URL('./player.html', import.meta.url)),
      },
    },
  },
})
