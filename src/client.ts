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
  responses: { responderLabel: string; choice: string; createdAt: string }[]
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
