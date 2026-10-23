import { describe, expect, it } from 'vitest'
import { buildPath, companyFolder, deviceFolder, fmtDate, fmtStamp, isLegacyName, isSafeRelPath, samePlace, sanitizeFileName, sanitizeSegment, withSuffix } from './fileLayout.js'

describe('sanitizeSegment', () => {
  it('strips the characters Windows and SMB forbid, and control characters', () => {
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
    expect(sanitizeSegment('tab\there\u0000nul\u007f')).toBe('tabherenul')
    expect(sanitizeSegment('zero\u200bwidth\u202eflip')).toBe('zerowidthflip')
  })
  it('trims trailing dots and spaces, and leading dots, and collapses whitespace', () => {
    expect(sanitizeSegment('Building A. . ')).toBe('Building A')
    expect(sanitizeSegment('..hidden')).toBe('hidden')
    expect(sanitizeSegment('  two   spaces  ')).toBe('two spaces')
    expect(sanitizeSegment('..')).toBe('Unnamed')
    expect(sanitizeSegment('   ')).toBe('Unnamed')
    expect(sanitizeSegment('', 'Plan')).toBe('Plan')
  })
  it('renames Windows reserved device names', () => {
    for (const n of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT3', 'con.txt'])
      expect(sanitizeSegment(n)).toMatch(/_$/)
    expect(sanitizeSegment('CONFERENCE')).toBe('CONFERENCE')
    expect(sanitizeSegment('COM10')).toBe('COM10')
  })
  it('caps a segment at about 80 characters without breaking a character in two', () => {
    expect(sanitizeSegment('x'.repeat(200)).length).toBe(80)
    const emoji = sanitizeSegment('😀'.repeat(200))
    expect(Array.from(emoji).length).toBe(80)
    expect(sanitizeSegment('y'.repeat(79) + ' . . .').endsWith(' ')).toBe(false)
  })
  it('keeps ordinary names, accents and spaces', () => {
    expect(sanitizeSegment('Café Müller – Level 2')).toBe('Café Müller – Level 2')
  })
})

describe('file names and dates', () => {
  it('builds a name from a stem and extension', () => {
    expect(sanitizeFileName('a/b', 'PDF')).toBe('ab.pdf')
    expect(sanitizeFileName('x'.repeat(200), 'jpg').length).toBeLessThanOrEqual(80)
    expect(sanitizeFileName('CON', 'pdf')).toBe('CON_.pdf')
  })
  it('formats UTC dates', () => {
    const d = new Date(Date.UTC(2026, 9, 21, 14, 32, 5))
    expect(fmtDate(d)).toBe('2026-10-21')
    expect(fmtStamp(d)).toBe('2026-10-21 1432')
    expect(fmtDate('not a date')).toBe('1970-01-01')
  })
})

describe('buildPath', () => {
  const at = new Date(Date.UTC(2026, 9, 21, 14, 32))
  it('plan revisions', () => {
    expect(buildPath({ kind: 'plan', ext: 'pdf', company: 'Acme', project: 'HQ Tower', plan: 'Level 1', rev: 1, at, original: 'L1 final.pdf' }))
      .toBe('Acme/Projects/HQ Tower/Plans/Level 1/Rev 01 - 2026-10-21 - L1 final.pdf')
    expect(buildPath({ kind: 'plan', ext: 'pdf', company: 'Acme', project: 'HQ', plan: 'Level 1', rev: 12, at, original: '', }))
      .toBe('Acme/Projects/HQ/Plans/Level 1/Rev 12 - 2026-10-21 - Level 1.pdf')
    expect(buildPath({ kind: 'plan', ext: 'pdf', company: 'Acme', project: 'HQ', plan: 'L1', rev: 2, at, original: 'page edits' }))
      .toBe('Acme/Projects/HQ/Plans/L1/Rev 02 - 2026-10-21 - page edits.pdf')
  })
  it('photos, marked-up photos and untagged devices', () => {
    const base = { ext: 'jpg', company: 'Acme', project: 'HQ', plan: 'L1', at, caption: 'Door side' }
    expect(buildPath({ kind: 'photo', tag: 'CAM-01', deviceType: 'IP Camera', ...base }))
      .toBe('Acme/Projects/HQ/Photos/L1/CAM-01 - IP Camera/2026-10-21 1432 - Door side.jpg')
    expect(buildPath({ kind: 'annotated', tag: 'CAM-01', deviceType: 'IP Camera', ...base }))
      .toBe('Acme/Projects/HQ/Photos/L1/CAM-01 - IP Camera/2026-10-21 1432 - Door side (marked up).jpg')
    expect(buildPath({ kind: 'photo', tag: '', ...base, caption: '' })).toBe('Acme/Projects/HQ/Photos/L1/Untagged/2026-10-21 1432 - photo.jpg')
    expect(deviceFolder('CAM-01', '')).toBe('CAM-01')
    expect(deviceFolder('', 'IP Camera')).toBe('Untagged')
  })
  it('logos, avatars and exports', () => {
    expect(buildPath({ kind: 'company-logo', ext: 'png', company: 'Acme' })).toBe('Acme/_company/logo.png')
    expect(buildPath({ kind: 'project-logo', ext: 'jpg', company: 'Acme', project: 'HQ' })).toBe('Acme/Projects/HQ/_project/report-logo.jpg')
    expect(buildPath({ kind: 'avatar', ext: 'png', email: 'a@b.com' })).toBe('_users/a@b.com/avatar.png')
    expect(buildPath({ kind: 'export', ext: 'pdf', company: 'Acme', name: 'Riser diagram.pdf' })).toBe('Acme/Exports/Riser diagram.pdf')
  })
  it('never lets a name leave its folder, and keeps the tree roots free', () => {
    const p = buildPath({ kind: 'plan', ext: 'pdf', company: '../../etc', project: '..\\x', plan: '../..', rev: 1, at, original: '../../passwd' })
    expect(isSafeRelPath(p)).toBe(true)
    expect(p.split('/').every(s => s !== '..' && s !== '.')).toBe(true)
    expect(companyFolder('_trash')).toBe('trash')
    expect(companyFolder('_Users')).toBe('Users')
    expect(companyFolder('CON')).toBe('CON_')
  })
  it('keeps the whole path short enough for Windows', () => {
    const long = 'n'.repeat(120)
    const p = buildPath({ kind: 'photo', ext: 'jpg', company: long, project: long, plan: long, tag: long, deviceType: long, caption: long, at })
    expect(p.length).toBeLessThanOrEqual(240)
    expect(p.endsWith('.jpg')).toBe(true)
    expect(p.split('/').every(s => s.length <= 80)).toBe(true)
  })
})

describe('collisions and legacy names', () => {
  it('adds " (2)" before the extension', () => {
    expect(withSuffix('a/b/x.pdf', 1)).toBe('a/b/x.pdf')
    expect(withSuffix('a/b/x.pdf', 2)).toBe('a/b/x (2).pdf')
    expect(withSuffix('a.b/x', 3)).toBe('a.b/x (3)')
  })
  it('treats a collision-suffixed name as the same place', () => {
    expect(samePlace('a/x.pdf', 'a/x.pdf')).toBe(true)
    expect(samePlace('a/x (2).pdf', 'a/x.pdf')).toBe(true)
    expect(samePlace('a/y.pdf', 'a/x.pdf')).toBe(false)
    expect(samePlace('b/x.pdf', 'a/x.pdf')).toBe(false)
    expect(samePlace('a/x (b).pdf', 'a/x.pdf')).toBe(false)
  })
  it('recognises old flat uuid names', () => {
    expect(isLegacyName('0f8fad5b-d9cb-469f-a165-70867728950e.pdf')).toBe(true)
    expect(isLegacyName('Acme/Projects/0f8fad5b-d9cb-469f-a165-70867728950e.jpg')).toBe(true)
    expect(isLegacyName('Acme/Projects/HQ/plan.pdf')).toBe(false)
  })
  it('rejects unsafe relative paths', () => {
    for (const bad of ['', '../x', 'a/../x', '/abs', 'C:/x', 'a\\b', 'a\0b', './x']) expect(isSafeRelPath(bad), bad).toBe(false)
    expect(isSafeRelPath('a/b c/d.pdf')).toBe(true)
    expect(isSafeRelPath('uuid.pdf')).toBe(true)
  })
})
