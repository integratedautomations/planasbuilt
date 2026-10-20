// Older Safari/iPadOS lacks APIs that pdf.js 6 and our code use. Imported first in main.tsx and the pdf worker.
/* eslint-disable @typescript-eslint/no-explicit-any */
const P = Promise as any
if (!P.withResolvers) {
  P.withResolvers = function () {
    let resolve: any, reject: any
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}
const M = Math as any
if (!M.sumPrecise) M.sumPrecise = (xs: Iterable<number>) => { let s = 0; for (const x of xs) s += x; return s }
const U8 = Uint8Array as any
if (!U8.fromBase64) {
  U8.fromBase64 = (b64: string) => {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
}
if (!U8.prototype.toHex) {
  U8.prototype.toHex = function (this: Uint8Array) { let s = ''; for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0'); return s }
}
if (!U8.prototype.toBase64) {
  U8.prototype.toBase64 = function (this: Uint8Array) { let s = ''; for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]); return btoa(s) }
}
const A = Array as any
if (!A.prototype.at) {
  A.prototype.at = function (this: unknown[], i: number) { i = Math.trunc(i) || 0; return this[i < 0 ? this.length + i : i] }
}
if (!A.prototype.findLast) {
  A.prototype.findLast = function (this: unknown[], f: (v: unknown, i: number, a: unknown[]) => boolean) { for (let i = this.length - 1; i >= 0; i--) if (f(this[i], i, this)) return this[i] }
}
const G = globalThis as any
if (!G.structuredClone) G.structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v))
export {}
