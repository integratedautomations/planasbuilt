import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(here, '..', '..', 'data'))
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me'
if (process.env.NODE_ENV === 'production') {
  const weak = ['dev-secret-change-me', 'change-me', 'changeme']
  if (!process.env.JWT_SECRET || weak.includes(jwtSecret) || jwtSecret.length < 32)
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production (openssl rand -hex 32)')
}

const db = await openDb(process.env.DATABASE_URL || undefined, dataDir)
await migrate(db)
const app = await buildApp({
  db,
  jwtSecret,
  filesDir: path.join(dataDir, 'files'),
  webDir: process.env.WEB_DIR ?? path.resolve(here, '..', '..', 'web', 'dist'),
})
const port = Number(process.env.PORT ?? 3001)
await app.listen({ port, host: '0.0.0.0' })
console.log(`PlanAsBuilt server on http://localhost:${port}`)
