// Human-readable file layout. Pure functions: names in, a relative path out (always "/" separated, valid on Windows/SMB and Linux).
//
//   <Company>/_company/logo.png
//   <Company>/Projects/<Project>/_project/report-logo.png
//   <Company>/Projects/<Project>/Plans/<Plan>/Rev 01 - 2026-10-21 - <original name>.pdf
//   <Company>/Projects/<Project>/Photos/<Plan>/<TAG> - <device type>/2026-10-21 1432 - <caption>.jpg
//   <Company>/Projects/<Project>/Photos/<Plan>/Untagged/...
//   <Company>/Exports/<name>.<ext>
//   _users/<email>/avatar.png
//   _trash/<stamp>/<same path as above>     (written by storage.ts)
//
// The database keeps tracking files by key, so a path built here is only ever a place to put a file, never an identity.

export type FileKind = 'plan' | 'photo' | 'annotated' | 'company-logo' | 'project-logo' | 'avatar' | 'export'

export interface FileCtx {
  kind: FileKind
  /** File extension without the dot. */
  ext: string
  company?: string
  project?: string
  plan?: string
  /** Revision number (plans). */
  rev?: number
  /** Revision date (plans) or capture time (photos). */
  at?: Date | string | number | null
  /** Original file name (plans) or revision label; shown after the date. */
  original?: string
  tag?: string
  deviceType?: string
  caption?: string
  email?: string
  /** Free file name (exports). */
  name?: string
}

/** Folders that live next to the company folders at the top of the tree. */
export const TOP_RESERVED = ['_users', '_trash']
export const TRASH_DIR = '_trash'

const SEGMENT_MAX = 80
/** Most characters allowed in one whole path (Windows Explorer starts to fail around 260). */
const PATH_MAX = 230

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i
// Control characters, zero-width / bidi marks and the characters Windows and SMB forbid in names.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿<>:"/\\|?*]/g

const clip = (s: string, max: number) => (Array.from(s).length > max ? Array.from(s).slice(0, max).join('') : s)

/** One folder or file-name segment: no forbidden characters, no leading/trailing dots or spaces, not a reserved device name. */
export function sanitizeSegment(input: unknown, fallback = 'Unnamed', max = SEGMENT_MAX): string {
  let s = String(input ?? '').normalize('NFC').replace(FORBIDDEN, '').replace(/\s+/g, ' ')
  s = s.replace(/^[. ]+/, '')
  s = clip(s, max).replace(/[. ]+$/, '')
  if (!s) s = fallback
  // "CON", "con.txt" and "CON .x" all name the console device on Windows.
  if (WIN_RESERVED.test(s.split('.')[0].trim())) s = `${s}_`
  return s
}

export const sanitizeExt = (ext: unknown) => String(ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'

/** A file name: sanitized stem (capped) + extension. */
export function sanitizeFileName(stem: unknown, ext: unknown, fallback = 'file', max = SEGMENT_MAX): string {
  const e = sanitizeExt(ext)
  return `${sanitizeSegment(stem, fallback, Math.max(1, max - e.length - 1))}.${e}`
}

const two = (n: number) => String(n).padStart(2, '0')
const toDate = (v: ConstructorParameters<typeof Date>[0] | null | undefined) => {
  const d = v == null ? new Date() : new Date(v as any)
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}
/** 2026-10-21 (UTC). */
export const fmtDate = (v?: Parameters<typeof toDate>[0]) => { const d = toDate(v); return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}` }
/** 2026-10-21 1432 (UTC). */
export const fmtStamp = (v?: Parameters<typeof toDate>[0]) => { const d = toDate(v); return `${fmtDate(d)} ${two(d.getUTCHours())}${two(d.getUTCMinutes())}` }

const stripExt = (name: string, ext: string) => name.replace(new RegExp(`\\.${ext}$`, 'i'), '')

/** The company folder: `_users` and `_trash` are taken by the tree itself. */
export function companyFolder(name: unknown): string {
  const s = sanitizeSegment(String(name ?? '').replace(/^_+/, ''), 'Company')
  return s
}

/** The photo folder of a device: "TAG - Device type", the tag alone, or Untagged. */
export function deviceFolder(tag?: string, deviceType?: string): string {
  const t = String(tag ?? '').trim()
  if (!t) return 'Untagged'
  const d = String(deviceType ?? '').trim()
  return sanitizeSegment(d ? `${t} - ${d}` : t, 'Untagged')
}

/** Shortens the longest segments until the whole path fits (the extension of the file name is kept). */
function fit(segs: string[]): string[] {
  const out = [...segs]
  const total = () => out.join('/').length
  let guard = 400
  while (total() > PATH_MAX && guard-- > 0) {
    let at = 0
    for (let i = 1; i < out.length; i++) if (out[i].length > out[at].length) at = i
    const isFile = at === out.length - 1
    const dot = isFile ? out[at].lastIndexOf('.') : -1
    const stem = dot > 0 ? out[at].slice(0, dot) : out[at], ext = dot > 0 ? out[at].slice(dot) : ''
    if (Array.from(stem).length <= 8) break
    out[at] = sanitizeSegment(clip(stem, Array.from(stem).length - 6), 'x') + ext
  }
  return out
}

/** The path a file should have, from the names around it. Never touches storage, never makes a name unique. */
export function buildPath(ctx: FileCtx): string {
  const ext = sanitizeExt(ctx.ext)
  const C = companyFolder(ctx.company)
  const P = sanitizeSegment(ctx.project, 'Project')
  const Plan = sanitizeSegment(ctx.plan, 'Plan')
  switch (ctx.kind) {
    case 'plan': {
      const rev = `Rev ${String(Math.max(0, Math.floor(ctx.rev ?? 1))).padStart(2, '0')}`
      const label = stripExt(String(ctx.original ?? '').trim(), ext) || String(ctx.plan ?? '').trim()
      return fit([C, 'Projects', P, 'Plans', Plan, sanitizeFileName(`${rev} - ${fmtDate(ctx.at)} - ${sanitizeSegment(label, 'plan', 50)}`, ext)]).join('/')
    }
    case 'photo':
    case 'annotated': {
      const cap = sanitizeSegment(String(ctx.caption ?? '').trim() || 'photo', 'photo', 50)
      const stem = `${fmtStamp(ctx.at)} - ${cap}${ctx.kind === 'annotated' ? ' (marked up)' : ''}`
      return fit([C, 'Projects', P, 'Photos', Plan, deviceFolder(ctx.tag, ctx.deviceType), sanitizeFileName(stem, ext)]).join('/')
    }
    case 'company-logo':
      return [C, '_company', `logo.${ext}`].join('/')
    case 'project-logo':
      return fit([C, 'Projects', P, '_project', `report-logo.${ext}`]).join('/')
    case 'avatar':
      return ['_users', sanitizeSegment(ctx.email, 'user'), `avatar.${ext}`].join('/')
    case 'export':
      return fit([C, 'Exports', sanitizeFileName(stripExt(String(ctx.name ?? 'export'), ext), ext, 'export')]).join('/')
  }
}

/** `a/b/name.pdf` -> `a/b/name (2).pdf`. n <= 1 returns the path unchanged. */
export function withSuffix(p: string, n: number): string {
  if (n <= 1) return p
  const slash = p.lastIndexOf('/')
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '', file = p.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : ''
  return `${dir}${stem} (${n})${ext}`
}

/** True when `actual` is `wanted` or `wanted` with a collision suffix " (n)" (so a file that already has its place is left alone). */
export function samePlace(actual: string, wanted: string): boolean {
  if (actual === wanted) return true
  const slash = wanted.lastIndexOf('/')
  const dir = wanted.slice(0, slash + 1), file = wanted.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : ''
  if (!actual.startsWith(dir)) return false
  const rest = actual.slice(dir.length)
  if (rest.includes('/') || !rest.startsWith(stem) || !rest.endsWith(ext)) return false
  return /^ \(\d{1,4}\)$/.test(rest.slice(stem.length, rest.length - ext.length))
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i
/** An old flat `<uuid>.<ext>` name (the file has never been given a readable place). */
export const isLegacyName = (relPath: string) => UUID_NAME.test(relPath.slice(relPath.lastIndexOf('/') + 1))

/** Safe to join under the files directory: relative, no "." / ".." segments, no backslash, drive letter or NUL. */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  return p.split('/').every(s => s !== '..' && s !== '.')
}
