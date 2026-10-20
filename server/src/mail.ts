// Email hook. With no SMTP configured the app runs in "copy link" mode: invites and resets return a link
// for the admin to hand over. With SMTP settings, the same flows also email it.
import nodemailer from 'nodemailer'

export interface SmtpConfig { host: string; port: number; secure: boolean; user: string; pass: string; from: string }
export interface MailMessage { to: string; subject: string; text: string }
export interface Mailer { send(msg: MailMessage): Promise<void> }

/** Replaceable in tests. */
export type TransportFactory = (c: SmtpConfig) => { sendMail(opts: any): Promise<unknown> }
let factory: TransportFactory = c => nodemailer.createTransport({
  host: c.host, port: c.port, secure: c.secure,
  auth: c.user ? { user: c.user, pass: c.pass } : undefined,
})
export const setTransportFactory = (f: TransportFactory) => { factory = f }

export const smtpConfigured = (c: Partial<SmtpConfig> | null | undefined): c is SmtpConfig =>
  !!c && !!String(c.host ?? '').trim() && !!String(c.from ?? '').trim() && Number(c.port) > 0

export function smtpProblem(c: Partial<SmtpConfig> | null | undefined): string | null {
  if (!c || !String(c.host ?? '').trim()) return 'SMTP host is required'
  if (!(Number(c.port) > 0 && Number(c.port) < 65536)) return 'SMTP port must be 1-65535'
  if (!/^[^@\s]+@[^@\s]+$|<[^@\s]+@[^@\s]+>/.test(String(c.from ?? ''))) return 'From address is required (name@example.com)'
  return null
}

/** A mailer when SMTP is configured, otherwise null (copy-link mode). */
export function mailerFor(c: Partial<SmtpConfig> | null | undefined): Mailer | null {
  if (!smtpConfigured(c)) return null
  const cfg = c
  return { send: async m => { await factory(cfg).sendMail({ from: cfg.from, to: m.to, subject: m.subject, text: m.text }) } }
}
