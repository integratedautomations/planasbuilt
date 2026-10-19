import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, migrate } from './db.js'
import { buildApp } from './app.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(here, '..', '..', 'data'))
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me'
if (process.env.NODE_ENV === 'production' && jwtSecret === 'dev-secret-change-me')
  throw new Error('Set JWT_SECRET in production')

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
console.log(`planmark server on http://localhost:${port}`)
