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
  /** Position in the game's sequence — 7, shown everywhere as 0007. */
  ticketNumber: number | null
  closed: boolean
  closedAt: string | null
  closedByLabel: string | null
  /** Set on a note that was relayed into a ticket rather than sent alone. */
  parentTicketId: string | null
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
    /** Relay a copy into this ticket's channel, and its answers with it. */
    parentTicketId?: string
  }
): Promise<{
  sent: number
  deliveries: Delivery[]
  entry: NotificationRecord
  /** Null when no ticket was named; false when the copy could not be posted. */
  loggedToTicket: boolean | null
}> {
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

export interface StageView {
  ticketId: string
  ticketNumber: number | null
  title: string | null
  closed: boolean
  stage: string | null
  stageLabel: string | null
  phase: string | null
  position: number
  total: number
  bar: string
  note: string | null
  eta: string | null
  next: string | null
  history: { stage: string; from: string | null; by: string; at: string }[]
  stages: { position: number; key: string; label: string; phase: string }[]
}

/** Where a ticket sits in the twelve-stage pipeline, and how it got there. */
export function getTicketStage(universeId: string, ticket: string): Promise<StageView> {
  return request(`/api/projects/${universeId}/tickets/${encodeURIComponent(ticket)}/stage`)
}

/** Move a ticket to a stage and redraw its status embed. */
export function setTicketStage(
  universeId: string,
  ticket: string,
  payload: { stage: string; note?: string; eta?: string }
): Promise<{
  ticketId: string
  ticketNumber: number | null
  stage: string
  stageLabel: string
  fromLabel: string | null
  changed: boolean
  /** Stages jumped clean over by this move, by label. */
  skipped: string[]
  /** True when the move went back up the pipeline rather than down it. */
  movedBack: boolean
  posted: boolean
  problem: string | null
}> {
  return request(`/api/projects/${universeId}/tickets/${encodeURIComponent(ticket)}/stage`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/**
 * Close a ticket, or open it back up.
 *
 * Closing renames its channel to closed-0007 and greys the embed. Takes the
 * ticket's number or its id.
 */
export function setTicketClosed(
  universeId: string,
  ticket: string,
  closed: boolean,
  reason?: string
): Promise<{
  ticketId: string
  ticketNumber: number | null
  closed: boolean
  channelName: string | null
  renameProblem: string | null
  changed: boolean
}> {
  return request(`/api/projects/${universeId}/tickets/${encodeURIComponent(ticket)}`, {
    method: 'PATCH',
    body: JSON.stringify({ closed, ...(reason ? { reason } : {}) }),
  })
}

/**
 * Put the standing "Add ticket" button in a game's channel.
 *
 * Posting it again moves it to the bottom of the channel and removes the old
 * one, which is what you want after a month of conversation has pushed it out
 * of sight.
 */
export function postTicketPanel(
  universeId: string,
  channelId?: string | null,
  role?: string | null
): Promise<{
  channelId: string
  messageId: string
  replacedOld: boolean
  pingRoleName: string | null
}> {
  return request(`/api/projects/${universeId}/ticket-panel`, {
    method: 'POST',
    body: JSON.stringify({
      ...(channelId ? { channelId } : {}),
      ...(role ? { role } : {}),
    }),
  })
}


export const TICKET_TYPES = ['concept_review', 'final_review', 'payment', 'status'] as const
export type TicketType = (typeof TICKET_TYPES)[number]

export interface TicketResult {
  ticketId: string
  /** Position in the game's sequence — 7, shown everywhere as 0007. */
  ticketNumber: number
  /** Whether it reached a Discord channel at all. */
  posted: boolean
  channelName: string | null
  /** The channel opened for this ticket, when it got one of its own. */
  ticketChannelId: string | null
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

// ── Binary responses ────────────────────────────────────────────────────────

/**
 * Same call as request(), for routes that answer with a file rather than JSON.
 *
 * A refusal is still JSON, so the error path parses the body the same way and
 * the caller sees the site's sentence instead of a byte count.
 */
async function requestBinary(path: string, init: RequestInit = {}): Promise<Buffer> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    const text = await res.text()
    let detail = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text)
      if (parsed?.error) detail = parsed.error
    } catch { /* not JSON */ }
    throw new WhtError(detail)
  }

  return Buffer.from(await res.arrayBuffer())
}

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * What a caller can actually do to a game, gathered rather than guessed.
 *
 * Nothing here is a single flag on the site — authority is spread across a
 * Roblox cookie (uploads, deletes, swaps), an Open Cloud key (analytics), a
 * personalization config (whether the live set can change at all) and a Discord
 * bot (tickets and notifications). Each is probed separately and each failure
 * is kept as the sentence the site gave, because "no" and "no, because the key
 * is missing" lead to different next moves.
 *
 * Every section is caught on its own, so one dead source degrades the report
 * rather than replacing it with an error.
 */

export interface SettingsState {
  hasKey: boolean
  encrypted: boolean
  encryptionConfigured: boolean
  hint: string | null
  usingDefault: boolean
  hasProjectCookie: boolean
  account: { name: string | null; canEdit: boolean } | null
  discordChannelUrl: string | null
}

export interface AutoSwapConfig {
  autoSwapEnabled: boolean
  dropCount: number
  swapFrequencyMinutes: number
  qptrThreshold: number
  instantDropMinImpressions: number
  nextSwapAt: string | null
  lastSwapAt: string | null
  autoDisabledAt: string | null
  autoDisabledReason: string | null
}

export interface CronStatus {
  intervalMinutes: number
  lastFiredAt: string | null
  nextFireAt: string
  secondsUntilFire: number
}

export interface TicketChannel {
  ticketChannelId: string | null
  ticketChannelName: string | null
}

export interface Capabilities {
  project: Project
  settings: SettingsState | null
  settingsProblem: string | null
  thumbnails: ThumbnailReport | null
  thumbnailsProblem: string | null
  discord: NotifyContext | null
  discordProblem: string | null
  autoSwap: AutoSwapConfig | null
  autoSwapProblem: string | null
  cron: CronStatus | null
  channel: TicketChannel | null
  channelProblem: string | null
}

function problem(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Run a probe, keeping its failure as text rather than letting it throw. */
async function probe<T>(run: () => Promise<T>): Promise<[T, null] | [null, string]> {
  try {
    return [await run(), null]
  } catch (err) {
    return [null, problem(err)]
  }
}

export function getSettings(universeId: string): Promise<SettingsState> {
  return request<SettingsState>(`/api/projects/${universeId}/settings`)
}

export function getAutoSwap(universeId: string): Promise<AutoSwapConfig> {
  return request<AutoSwapConfig>(`/api/projects/${universeId}/auto-swap`)
}

export function getCronStatus(): Promise<CronStatus> {
  return request<CronStatus>('/api/cron-status')
}

export async function getCapabilities(project: Project): Promise<Capabilities> {
  const id = project.universeId

  const [
    [settings, settingsProblem],
    [thumbnails, thumbnailsProblem],
    [discord, discordProblem],
    [autoSwap, autoSwapProblem],
    [cron],
    [tickets, channelProblem],
  ] = await Promise.all([
    // Owner-only on the site, so a shared project reports a refusal here and
    // the rest of the picture still comes back.
    probe(() => getSettings(id)),
    // 24h keeps the probe cheap; the question is whether numbers arrive at all.
    probe(() => getThumbnails(id, '24h')),
    probe(() => getNotifyContext(id)),
    probe(() => getAutoSwap(id)),
    probe(() => getCronStatus()),
    probe(() => request<{ channel: TicketChannel | null }>(`/api/projects/${id}/tickets`)),
  ])

  return {
    project,
    settings,
    settingsProblem,
    thumbnails,
    thumbnailsProblem,
    discord,
    discordProblem,
    autoSwap,
    autoSwapProblem,
    cron,
    channel: tickets?.channel ?? null,
    channelProblem,
  }
}

export function setProjectCredentials(
  universeId: string,
  body: { openCloudKey?: string | null; robloSecurity?: string | null }
): Promise<{
  hasKey?: boolean
  hint?: string | null
  usingDefault?: boolean
  account?: { name: string | null; canEdit: boolean }
}> {
  return request(`/api/projects/${universeId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// ── The live set ────────────────────────────────────────────────────────────

/**
 * Replace which thumbnails are live.
 *
 * Roblox takes homepage thumbnail ids, not the asset ids the reports lead with,
 * and it takes the whole set rather than a diff — anything left out goes
 * inactive. Both are easy to get wrong from the outside, so the tool layer
 * resolves ids and states the resulting set before sending it.
 */
export function setActiveThumbnails(
  universeId: string,
  thumbnailIds: string[]
): Promise<{ ok: boolean }> {
  return request('/api/set-active-thumbnails', {
    method: 'POST',
    body: JSON.stringify({ universeId, thumbnailIds }),
  })
}

/** Remove a variant from the game for good. Roblox has no undo for this. */
export function deleteThumbnail(universeId: string, thumbnailId: string): Promise<{ ok: boolean }> {
  return request(
    `/api/delete-thumbnail?universeId=${encodeURIComponent(universeId)}` +
      `&thumbnailId=${encodeURIComponent(thumbnailId)}`,
    { method: 'DELETE' }
  )
}

// ── Generation ──────────────────────────────────────────────────────────────

export interface GenerateResult {
  imageBase64: string
  mimeType: string
  text?: string
  enhancedPrompt: string
  imageUrl: string | null
  generationId: string | null
  saved: boolean
}

export function generate(payload: {
  prompt: string
  imageUrls: string[]
  primaryIndex?: number
  universeId?: string
  gameName?: string
  gameDescription?: string
  enhanceWithAI?: boolean
  includeGameContext?: boolean
  imageModel?: 'gemini' | 'openai'
  profile?: string
}): Promise<GenerateResult> {
  return request<GenerateResult>('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface Generation {
  id: string
  date: string
  prompt: string
  enhancedPrompt: string
  referenceUrls: string[]
  imageUrl: string
}

export function getGenerations(universeId: string): Promise<{
  universeId: string
  gameName: string
  generations: Generation[]
}> {
  return request(`/api/projects/${universeId}`)
}

/** Publish an image already stored on the site, without downloading it first. */
export function uploadStoredGeneration(
  universeId: string,
  generationId: string
): Promise<ExportResult> {
  return request<ExportResult>('/api/export-to-roblox', {
    method: 'POST',
    body: JSON.stringify({ universeId, generationId }),
  })
}

/** The style profiles the prompt enhancer can be pointed at. */
export function listProfiles(): Promise<{ profiles: { id: string; name: string; content: string }[] }> {
  return request('/api/profiles')
}

// ── Auto-swap ───────────────────────────────────────────────────────────────

export function configureAutoSwap(
  universeId: string,
  body: Partial<{
    autoSwapEnabled: boolean
    dropCount: number
    swapFrequencyMinutes: number
    qptrThreshold: number
    instantDropMinImpressions: number
  }>
): Promise<AutoSwapConfig> {
  return request(`/api/projects/${universeId}/auto-swap`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export interface SwapRunResult {
  ok: boolean
  reason: string
  noop: boolean
  skipped: boolean
  note?: string
  logId?: string
  decision?: {
    dropped: { assetId: string; qptr: number | null }[]
    added: { assetId: string }[]
    kept: { assetId: string }[]
    newActiveHomepageIds: string[]
    autoDisableReason: string | null
    noop: boolean
    noopReason: string | null
  }
}

export function runAutoSwap(universeId: string): Promise<SwapRunResult> {
  return request(`/api/projects/${universeId}/auto-swap/run`, { method: 'POST' })
}

export interface SwapLog {
  id: string
  firedAt: string
  reason: string
  skipped: boolean
  note: string | null
  snapshots: { assetId: string; action: string; qptr: number | null; impressions: number | null }[]
}

export function getAutoSwapLogs(universeId: string, limit = 25): Promise<{ logs: SwapLog[] }> {
  return request(`/api/projects/${universeId}/auto-swap/logs?limit=${limit}`)
}

// ── Queue ───────────────────────────────────────────────────────────────────

export interface QueueEntry {
  id: string
  universeId: string
  assetId: string
  imageUrl: string
  position: number
}

export function getQueue(universeId: string): Promise<QueueEntry[]> {
  return request(`/api/queue?universeId=${encodeURIComponent(universeId)}`)
}

export function addToQueue(payload: {
  universeId: string
  assetId: string
  imageUrl: string
}): Promise<QueueEntry> {
  return request('/api/queue', { method: 'POST', body: JSON.stringify(payload) })
}

export function removeFromQueue(id: string): Promise<{ ok: boolean }> {
  return request(`/api/queue/${id}`, { method: 'DELETE' })
}

export function reorderQueue(order: { id: string; position: number }[]): Promise<unknown> {
  return request('/api/queue/reorder', { method: 'PUT', body: JSON.stringify({ order }) })
}

// ── Roblox lookup ───────────────────────────────────────────────────────────

export interface GameInfo {
  universeId: string
  placeId?: string
  name: string
  description?: string
  playing?: number
  visits?: number
  favorites?: number
  likes?: number
  dislikes?: number
  thumbnailUrl?: string
  creator?: { name?: string; type?: string }
  accessMode?: 'view' | 'write'
  writableSeedIndex?: number | null
}

export function getGameInfo(opts: { placeId?: string; universeId?: string }): Promise<GameInfo> {
  const params = new URLSearchParams()
  if (opts.universeId) params.set('universeId', opts.universeId)
  else if (opts.placeId) params.set('placeId', opts.placeId)
  return request<GameInfo>(`/api/game-info?${params}`)
}

/** Pull the id out of whatever shape the game was pasted in. */
export function parseGameRef(input: string): { placeId?: string; universeId?: string } {
  const trimmed = input.trim()
  const link = trimmed.match(/roblox\.com\/(?:games|experiences)\/(\d+)/i)
  if (link) return { placeId: link[1] }
  if (/^\d+$/.test(trimmed)) return { placeId: trimmed }
  throw new WhtError(
    `"${input}" is not a Roblox game link or id. Paste the URL from the game page, or give the place id.`
  )
}

export function addProject(payload: {
  universeId: string
  gameName: string
  seedIndex?: number
}): Promise<{ ok: boolean }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(payload) })
}

export interface SearchHit {
  universeId: string
  name: string
  playing?: number
  totalUpVotes?: number
  totalDownVotes?: number
  thumbnailUrl?: string
}

export function searchRobloxGames(
  query: string,
  opts: { seed?: number; pageToken?: string } = {}
): Promise<{ games: SearchHit[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({ q: query, seed: String(opts.seed ?? 0) })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  return request(`/api/search-games?${params}`)
}

// ── Trends ──────────────────────────────────────────────────────────────────

export function getQptrSeries(
  universeId: string,
  range: '7d' | '14d' | '30d' = '14d'
): Promise<{
  series: { date: string; qptr: number | null; impressions: number | null }[]
  liveDays: number
}> {
  return request(
    `/api/project-qptr-series?universeId=${encodeURIComponent(universeId)}&range=${range}`
  )
}

export function getMomentum(
  universeId: string,
  assetIds: string[],
  range: '24h' | '3d' | '7d' | '30d' = '7d'
): Promise<{
  momentum: Record<string, { delta: number; pct: number; direction: 'up' | 'down' | 'flat' } | null>
}> {
  const params = new URLSearchParams({ universeId, assetIds: assetIds.join(','), range })
  return request(`/api/thumbnail-series-momentum?${params}`)
}

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * The thumbnail overview as a PDF.
 *
 * Rows are posted rather than re-derived on the server so the document matches
 * the figures the caller was just looking at, instead of a second query that
 * quietly disagrees with them.
 */
export function buildThumbnailPdf(
  universeId: string,
  rangeLabel: string,
  items: {
    assetId: string
    imageUrl: string
    isActive: boolean
    qptr: number | null
    impressions: number | null
    qualifiedPlays: number | null
  }[]
): Promise<Buffer> {
  return requestBinary(`/api/projects/${universeId}/thumbnail-pdf`, {
    method: 'POST',
    body: JSON.stringify({ rangeLabel, items }),
  })
}

// ── Tickets and sharing ─────────────────────────────────────────────────────

export function listTickets(universeId: string): Promise<{
  tickets: NotificationRecord[]
  channel: TicketChannel | null
}> {
  return request(`/api/projects/${universeId}/tickets`)
}

export function listShares(universeId: string): Promise<{
  shares: { id: string; userId: string; createdAt: string }[]
}> {
  return request(`/api/projects/${universeId}/shares`)
}

export function listInvites(universeId: string): Promise<{
  invites: { id: string; token: string; createdAt: string; expiresAt: string }[]
}> {
  return request(`/api/projects/${universeId}/invites`)
}

export function createInvite(universeId: string): Promise<{
  invite: { id: string; token: string; createdAt: string; expiresAt: string }
}> {
  return request(`/api/projects/${universeId}/invites`, { method: 'POST' })
}
