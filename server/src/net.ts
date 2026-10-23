import { lookup } from 'node:dns/promises'
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

// ---- Outbound requests an admin can aim (S3 endpoint, SMTP host): refuse the server's own network ----
const INTERNAL = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15]] as const)
  INTERNAL.addSubnet(net, bits, 'ipv4')
INTERNAL.addAddress('::', 'ipv6'); INTERNAL.addAddress('::1', 'ipv6')
INTERNAL.addSubnet('fc00::', 7, 'ipv6'); INTERNAL.addSubnet('fe80::', 10, 'ipv6')

/** Loopback, private, link-local (cloud metadata) and other non-public addresses. */
export function isInternalAddress(addr: string): boolean {
  const a = stripMapped(addr.replace(/^\[|\]$/g, ''))
  const kind = isIP(a)
  return kind !== 0 && INTERNAL.check(a, kind === 4 ? 'ipv4' : 'ipv6')
}

export type HostResolver = (host: string) => Promise<string[]>
let resolveHost: HostResolver = async host => (await lookup(host, { all: true })).map(r => r.address)
/** Tests replace DNS here. */
export const setHostResolver = (r: HostResolver) => { resolveHost = r }

export const INTERNAL_HOST_MESSAGE = 'That address points at a private or internal network. Only a platform admin can use one.'

/** A problem message when `host` (a name or IP) is, or resolves to, a private/loopback/link-local address; null when it is public or cannot be resolved. */
export async function internalHostProblem(host: string): Promise<string | null> {
  const h = host.trim().replace(/^\[|\]$/g, '')
  if (!h) return null
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(h)) return INTERNAL_HOST_MESSAGE
  if (isIP(h)) return isInternalAddress(h) ? INTERNAL_HOST_MESSAGE : null
  let addrs: string[] = []
  try { addrs = await resolveHost(h) } catch { return null } // unknown names cannot reach anything
  return addrs.some(isInternalAddress) ? INTERNAL_HOST_MESSAGE : null
}

/** The host of an endpoint URL (or a bare host), '' when there is none. */
export function hostOf(endpoint: string): string {
  try { return new URL(endpoint).hostname } catch { return '' }
}
