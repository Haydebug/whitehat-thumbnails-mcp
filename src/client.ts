import { readFile } from 'fs/promises'
import { basename, extname } from 'path'

const DEFAULT_BASE_URL = 'https://whitehatthumbnails.vercel.app'

export class WhtError extends Error {}

function baseUrl(): string {
  return (process.env.WHT_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function apiKey(): string {
  const key = process.env.WHT_API_KEY
  if (!key) {
    throw new WhtError(
      'WHT_API_KEY is not set. Create a key on the site under "Keys", then put it in your MCP config.'
    )
  }
  return key
}

/**
 * Every call carries the key as a bearer token, which the site accepts in place
 * of a browser session. A key acts as the user who made it and reaches only
 * their projects, so nothing here needs to think about permissions.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  })

  const text = await res.text()
  if (!res.ok) {
    // The site answers with {error} for anything it refuses on purpose; keep
    // that wording rather than replacing it with a status code.
    let detail = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text)
      if (parsed?.error) detail = parsed.error
    } catch { /* not JSON */ }

    if (res.status === 401) throw new WhtError(`Rejected: ${detail}. Check WHT_API_KEY.`)
    if (res.status === 404) throw new WhtError(`Not found: ${detail}`)
    throw new WhtError(detail)
  }

  return text ? (JSON.parse(text) as T) : ({} as T)
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  universeId: string
  gameName: string
  count: number
  latestImage: string | null
  shared?: boolean
}

export async function listProjects(): Promise<Project[]> {
  const { projects } = await request<{ projects: Project[] }>('/api/projects')
  return projects
}

/**
 * Turn whatever the user called a game into a universe id.
 *
 * People say "+1 dumpling escape" for a project actually named "+1 Dumpling
 * SMASH Walls", so an exact match is tried first, then a loose one on the words
 * that carry meaning. An ambiguous answer is an error listing the candidates,
 * because silently picking one would act on the wrong game.
 */
export async function resolveProject(query: string): Promise<Project> {
  const projects = await listProjects()
  if (projects.length === 0) throw new WhtError('This account has no projects.')

  const q = query.trim()
  if (/^\d+$/.test(q)) {
    const byId = projects.find((p) => p.universeId === q)
    if (byId) return byId
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const target = norm(q)

  const exact = projects.find((p) => norm(p.gameName) === target)
  if (exact) return exact

  const contains = projects.filter(
    (p) => norm(p.gameName).includes(target) || target.includes(norm(p.gameName))
  )
  if (contains.length === 1) return contains[0]

  // Fall back to word overlap, so "dumpling escape" still finds "Dumpling SMASH Walls".
  const words = target.split(' ').filter((w) => w.length > 2)
  const scored = projects
    .map((p) => {
      const name = norm(p.gameName)
      return { p, score: words.filter((w) => name.includes(w)).length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    throw new WhtError(
      `No project matches "${query}". Known projects: ${projects.map((p) => p.gameName).join(', ')}`
    )
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    throw new WhtError(
      `"${query}" is ambiguous — could be: ${scored
        .filter((x) => x.score === scored[0].score)
        .map((x) => x.p.gameName)
        .join(', ')}. Say which one.`
    )
  }
  return scored[0].p
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

export interface ThumbnailRow {
  thumbnailId: string
  assetId: string
  imageUrl: string
  isActive: boolean
  impressions?: number
  qualifiedPlays?: number
  qptr?: number
  avgPlaytime?: number
  segments?: string[]
}

export interface ThumbnailReport {
  universeId: string
  gameName: string
  range: string
  source: string
  canSwap: boolean
  sessionLengthMinutes: number | null
  active: ThumbnailRow[]
  inactive: ThumbnailRow[]
}

export function getThumbnails(universeId: string, range = '7d'): Promise<ThumbnailReport> {
  return request<ThumbnailReport>(`/api/projects/${universeId}/thumbnails?range=${range}`)
}

// ── Discord ─────────────────────────────────────────────────────────────────

export interface DiscordRole {
  id: string
  name: string
  position: number
}

export interface NotificationRecord {
  id: string
  senderLabel: string
  roleName: string
  message: string
  imageUrls: string[]
  sentCount: number
  totalCount: number
  createdAt: string
  actionsEnabled: boolean
  approveLabel: string
  declineLabel: string
  /**
   * One row per person who answered. The Discord id is what a caller should
   * gate on — a label is a display name and changes the day someone renames
   * themselves, which would silently break "did both of them approve".
   */
  responses: {
    discordUserId: string
    responderLabel: string
    choice: string
    createdAt: string
  }[]
  /** Set only on tickets that asked for money. Decimal arrives as a string. */
  paymentAmount: string | number | null
  paypalLink: string | null
  paid: boolean
  paidAt: string | null
  paidByLabel: string | null
  /** Where it was filed from: 'site', 'discord' or 'mcp'. */
  source: string
  /** Set when it was filed as a ticket rather than sent as a note. */
  ticketType: string | null
  title: string | null
  channelId: string | null
  channelMessageId: string | null
}

export interface NotifyContext {
  configured: boolean
  roles: DiscordRole[]
  history: NotificationRecord[]
  error?: string
}

export function getNotifyContext(universeId: string): Promise<NotifyContext> {
  return request<NotifyContext>(`/api/projects/${universeId}/notify`)
}

/** Match a role by name, case-insensitively, then loosely. */
export function resolveRole(roles: DiscordRole[], query: string): DiscordRole {
  if (roles.length === 0) throw new WhtError('The Discord server has no roles to notify.')

  const q = query.trim().toLowerCase()
  const byId = roles.find((r) => r.id === query.trim())
  if (byId) return byId

  const exact = roles.find((r) => r.name.toLowerCase() === q)
  if (exact) return exact

  const partial = roles.filter((r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase()))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new WhtError(
      `"${query}" matches several roles: ${partial.map((r) => r.name).join(', ')}. Say which one.`
    )
  }
  throw new WhtError(
    `No role called "${query}". Available: ${roles.map((r) => r.name).join(', ')}`
  )
}

export interface Delivery {
  discordUserId: string
  label: string
  status: 'sent' | 'unreachable' | 'failed'
  detail?: string
}

export function notifyTeam(
  universeId: string,
  payload: {
    message: string
    roleId: string
    imageUrls?: string[]
    actionsEnabled?: boolean
    approveLabel?: string
    declineLabel?: string
    paymentAmount?: number
    paypalLink?: string
  }
): Promise<{ sent: number; deliveries: Delivery[]; entry: NotificationRecord }> {
  return request(`/api/projects/${universeId}/notify`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'image/png'
}

/** Put a local image somewhere public so Discord can render it. */
export async function uploadNotificationImage(universeId: string, filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeFor(filePath) }), basename(filePath))

  const { url } = await request<{ url: string }>(`/api/projects/${universeId}/notify/image`, {
    method: 'POST',
    body: form,
  })
  return url
}

// ── Roblox upload ───────────────────────────────────────────────────────────

export interface ExportResult {
  assetId?: string
  moderationStatus?: string
  imageUrl?: string
  error?: string
}

/**
 * Publish an image as a game thumbnail on Roblox.
 *
 * Moderation is asynchronous, so a result of Pending is normal and not a
 * failure — the site polls for a while and reports whatever it has.
 */
export async function uploadThumbnail(universeId: string, filePath: string): Promise<ExportResult> {
  const bytes = await readFile(filePath)
  return request<ExportResult>('/api/export-to-roblox', {
    method: 'POST',
    body: JSON.stringify({
      universeId,
      imageBase64: bytes.toString('base64'),
      mimeType: mimeFor(filePath),
    }),
  })
}

// ── Studio channels ─────────────────────────────────────────────────────────

/**
 * Artist conversations happen in per-person channels in the studio server.
 * These are guild-wide rather than per-project: a channel belongs to a person,
 * and the same artist works across several games.
 */

export interface StudioChannel {
  id: string
  name: string
  category: string | null
  position: number
}

export async function listChannels(): Promise<StudioChannel[]> {
  const { channels } = await request<{ channels: StudioChannel[] }>('/api/discord/channels')
  return channels
}

export interface CreatedChannel extends StudioChannel {
  /** False when a channel of this name was already there and was reused. */
  created: boolean
}

/**
 * Make a channel in the studio server.
 *
 * The bot needs Manage Channels for this, which is not part of a plain "let it
 * talk" invite — the site answers a missing permission with a sentence
 * saying so rather than a status code, and that is what surfaces to the caller.
 */
export function createChannel(payload: {
  name: string
  categoryName?: string
  topic?: string
}): Promise<{ guildId: string; channel: CreatedChannel; url: string }> {
  return request('/api/discord/channels', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * Point a game at a channel: where its tickets get posted, and where the "View
 * channel" button on its notifications goes. The same pairing /ticket config
 * makes in Discord. Pass null to unlink.
 */
export function linkChannel(
  universeId: string,
  channelId: string | null
): Promise<{
  ticketChannelId: string | null
  ticketChannelName?: string | null
  discordChannelUrl?: string | null
}> {
  return request(`/api/projects/${universeId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ ticketChannelId: channelId }),
  })
}

export interface ChannelMessage {
  id: string
  authorId: string
  authorLabel: string
  isBot: boolean
  timestamp: string
  text: string
  attachments: { url: string; filename: string; contentType: string | null; size: number }[]
}

export function getChannelMessages(
  channelId: string,
  opts: { since?: string; limit?: number } = {}
): Promise<{ messages: ChannelMessage[]; lastMessageId: string | null }> {
  const params = new URLSearchParams()
  if (opts.since) params.set('since', opts.since)
  if (opts.limit) params.set('limit', String(opts.limit))
  const query = params.toString()
  return request(`/api/discord/channels/${channelId}/messages${query ? `?${query}` : ''}`)
}

/**
 * Post as the bot.
 *
 * Files ride along in the same request rather than being hosted first, so an
 * art brief and its reference image arrive together.
 */
export interface EmbedInput {
  title?: string
  description?: string
  url?: string
  color?: string | number
  author?: string
  footer?: string
  fields?: { name: string; value: string; inline?: boolean }[]
  imageUrl?: string
  thumbnailUrl?: string
  buttons?: { label: string; url: string }[]
}

export async function sendChannelMessage(
  channelId: string,
  text: string,
  imagePaths: string[] = [],
  embed?: EmbedInput
): Promise<{ messageId: string }> {
  if (imagePaths.length === 0) {
    return request(`/api/discord/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, embed }),
    })
  }

  const form = new FormData()
  form.append('text', text)
  // A form field holds a string, so the embed travels as JSON and is parsed on
  // the other side.
  if (embed) form.append('embed', JSON.stringify(embed))
  for (const path of imagePaths.slice(0, 4)) {
    const bytes = await readFile(path)
    form.append(
      'files',
      new Blob([new Uint8Array(bytes)], { type: mimeFor(path) }),
      basename(path)
    )
  }

  return request(`/api/discord/channels/${channelId}/messages`, { method: 'POST', body: form })
}

// ── Tickets ─────────────────────────────────────────────────────────────────

export const TICKET_TYPES = ['concept_review', 'final_review', 'payment', 'status'] as const
export type TicketType = (typeof TICKET_TYPES)[number]

export interface TicketResult {
  ticketId: string
  /** Whether it reached the game's Discord channel. */
  posted: boolean
  channelName: string | null
  channelProblem: string | null
  dmSent: number
  dmTotal: number
}

/**
 * File a ticket.
 *
 * The same call the /ticket command in Discord makes, so a ticket opened by an
 * automation and one opened by a person are the same record with the same
 * buttons on it.
 */
export function createTicket(
  universeId: string,
  payload: {
    type: TicketType
    title: string
    description: string
    imageUrls?: string[]
    amountUsd?: number
    paypalLink?: string
    role?: string
  }
): Promise<TicketResult> {
  return request(`/api/projects/${universeId}/tickets`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
