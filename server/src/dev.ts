// Dev entry point (npm run dev): marks the process as development so index.ts may fall back to the dev JWT secret.
process.env.NODE_ENV ??= 'development'
await import('./index.js')
