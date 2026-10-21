import { defineConfig } from 'vitest/config'

// Tests set up the first admin with this code (the app requires one: see SETUP_TOKEN).
export default defineConfig({ test: { env: { SETUP_TOKEN: 'test-setup-code' } } })
