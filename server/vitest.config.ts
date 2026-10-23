import { defineConfig } from 'vitest/config'

// Tests set up the first admin with this code (the app requires one: see SETUP_TOKEN).
// bcrypt-heavy tests can exceed the 5s default when the whole suite runs in parallel.
export default defineConfig({ test: { env: { SETUP_TOKEN: 'test-setup-code' }, testTimeout: 20_000, hookTimeout: 60_000 } })
