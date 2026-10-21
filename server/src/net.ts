import { BlockList, isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'

/** Loopback, link-local and private (docker network, LAN) ranges: the only peers whose forwarding headers we believe. */
const PRIVATE = new BlockList()
for (const [net, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
PRIVATE.addSubnet('::1', 128, 'ipv6')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')

/** Fastify `trustProxy` value: X-Forwarded-* is honoured only from private/loopback peers, never from the open internet. */
export const TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal']

const stripMapped = (a: string) => (a.toLowerCase().startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a)

export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = stripMapped(addr)
  const kind = isIP(a)
  return kind !== 0 && PRIVATE.check(a, kind === 4 ? 'ipv4' : 'ipv6')
}

/**
 * The real client IP, for rate limiting. The TCP peer of this process is the cloudflared container (private network)
 * when a request came through the tunnel; only then is the CF-Connecting-IP header believed. A request straight from the
 * internet (or any public peer) is keyed on its socket address, whatever headers it sends.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket?.remoteAddress
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && isPrivateAddress(peer)) {
    const v = cf.trim()
    if (isIP(v)) return stripMapped(v)
  }
  return peer ? stripMapped(peer) : req.ip
}

/** Normalises PUBLIC_URL to a bare origin (https://pab.example.com); throws on anything that is not http(s). */
export function normalizePublicUrl(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  let u: URL
  try { u = new URL(s) } catch { throw new Error(`PUBLIC_URL is not a valid URL: ${s}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('PUBLIC_URL must start with https:// (or http://)')
  return u.origin
}
