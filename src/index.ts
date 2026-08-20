#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  WhtError,
  listProjects,
  resolveProject,
  getThumbnails,
  getNotifyContext,
  resolveRole,
  notifyTeam,
  uploadNotificationImage,
  uploadThumbnail,
} from './client.js'

const server = new McpServer({ name: 'whitehat-thumbnails', version: '1.0.0' })

/** Tool results are text; errors are returned as text too so the model can react. */
function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
function fail(err: unknown) {
  const message = err instanceof WhtError ? err.message : err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

const pct = (v?: number) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(2)}%`)
const num = (v?: number) => (v === undefined || v === null ? '—' : Math.round(v).toLocaleString())

// ── Projects ────────────────────────────────────────────────────────────────

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description:
      'List the Roblox games on this account, with their universe ids. Use this to turn a game name the user said into an id.',
    inputSchema: {},
  },
  async () => {
    try {
      const projects = await listProjects()
      if (projects.length === 0) return ok('No projects on this account.')
      return ok(
        projects
          .map((p) => `${p.gameName} — universeId ${p.universeId}${p.shared ? ' (shared with you)' : ''}`)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Thumbnails ──────────────────────────────────────────────────────────────

server.registerTool(
  'get_thumbnails',
  {
    title: 'Get thumbnail performance',
    description:
      "Read a game's thumbnails and how they are performing: QPTR, impressions, qualified plays and average playtime, split into the live (active) set and inactive variants. Answers questions like 'how are the thumbnails doing on <game>'.",
    inputSchema: {
      game: z.string().describe('Game name or universe id. Names are matched loosely.'),
      range: z.enum(['24h', '3d', '7d', '30d']).optional().describe('Reporting window. Defaults to 7d.'),
      includeInactive: z.boolean().optional().describe('Include inactive variants. Defaults to false.'),
    },
  },
  async ({ game, range, includeInactive }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId, range ?? '7d')

      const line = (t: (typeof report.active)[number], i: number) =>
        `${i + 1}. asset ${t.assetId}\n` +
        `   QPTR ${pct(t.qptr)} · impressions ${num(t.impressions)} · qualified plays ${num(t.qualifiedPlays)}` +
        `${t.avgPlaytime !== undefined ? ` · avg playtime ${t.avgPlaytime.toFixed(1)}m` : ''}` +
        `${t.segments?.length ? ` · segments ${t.segments.join(', ')}` : ''}\n` +
        `   ${t.imageUrl}`

      const parts = [
        `${report.gameName} (universeId ${report.universeId}) — last ${report.range}`,
        report.sessionLengthMinutes !== null
          ? `Average session: ${report.sessionLengthMinutes.toFixed(1)} min`
          : null,
        '',
        `ACTIVE (${report.active.length})`,
        report.active.length ? report.active.map(line).join('\n') : '  none',
      ]

      if (includeInactive) {
        parts.push('', `INACTIVE (${report.inactive.length})`)
        parts.push(report.inactive.length ? report.inactive.map(line).join('\n') : '  none')
      } else if (report.inactive.length) {
        parts.push('', `(${report.inactive.length} inactive variants — pass includeInactive to see them)`)
      }

      if (!report.canSwap) {
        parts.push(
          '',
          'Note: Roblox returned no personalization config for this game, so the live set cannot be changed from here.'
        )
      }
      if (report.source === 'public') {
        parts.push(
          '',
          'Note: read from the public game page — live thumbnails only, and no analytics. Add credentials on the site for the full picture.'
        )
      }

      return ok(parts.filter((p) => p !== null).join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Discord ─────────────────────────────────────────────────────────────────

server.registerTool(
  'list_discord_roles',
  {
    title: 'List Discord roles',
    description: 'List the Discord roles that can be notified, so a name the user said can be matched to one.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const ctx = await getNotifyContext(project.universeId)
      if (!ctx.configured) return ok('Discord is not set up on the server — no bot token configured.')
      if (ctx.error) return ok(ctx.error)
      if (ctx.roles.length === 0) return ok('The Discord server has no roles.')
      return ok(ctx.roles.map((r) => `${r.name} — id ${r.id}`).join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'notify_team',
  {
    title: 'Notify a Discord role',
    description:
      'DM everyone holding a Discord role about a game. Can attach images and can ask for an answer with two buttons whose labels you choose (for example Approve/Disapprove, or Paid/Cancel). When buttons are used, whoever answers has their decision sent to the whole role.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      role: z.string().describe('Discord role name or id to notify.'),
      message: z.string().describe('What to tell them. Links are fine and will unfurl.'),
      imagePaths: z
        .array(z.string())
        .optional()
        .describe('Local image files to attach. Uploaded automatically. Up to 4.'),
      imageUrls: z
        .array(z.string())
        .optional()
        .describe('Already-public image URLs to attach. Up to 4 in total with imagePaths.'),
      askForAnswer: z
        .boolean()
        .optional()
        .describe('Add two answer buttons. Defaults to false.'),
      approveLabel: z.string().optional().describe('Label for the positive button. Defaults to "Approve".'),
      declineLabel: z.string().optional().describe('Label for the negative button. Defaults to "No".'),
    },
  },
  async ({ game, role, message, imagePaths, imageUrls, askForAnswer, approveLabel, declineLabel }) => {
    try {
      const project = await resolveProject(game)
      const ctx = await getNotifyContext(project.universeId)
      if (!ctx.configured) {
        return ok('Discord is not set up on the server, so nothing was sent.')
      }
      const chosen = resolveRole(ctx.roles, role)

      // Local files have to become URLs before Discord can render them.
      const uploaded: string[] = []
      for (const path of imagePaths ?? []) {
        uploaded.push(await uploadNotificationImage(project.universeId, path))
      }
      const allImages = [...uploaded, ...(imageUrls ?? [])].slice(0, 4)

      const result = await notifyTeam(project.universeId, {
        message,
        roleId: chosen.id,
        imageUrls: allImages,
        actionsEnabled: askForAnswer ?? false,
        approveLabel,
        declineLabel,
      })

      const lines = [
        `Sent to ${result.sent} of ${result.deliveries.length} in "${chosen.name}" about ${project.gameName}.`,
      ]
      const problems = result.deliveries.filter((d) => d.status !== 'sent')
      if (problems.length) {
        lines.push('', 'Did not arrive:')
        for (const p of problems) lines.push(`  ${p.label} — ${p.detail ?? p.status}`)
      }
      if (askForAnswer) {
        lines.push('', `Buttons: "${approveLabel ?? 'Approve'}" / "${declineLabel ?? 'No'}". Answers are broadcast to the role.`)
      }
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'get_notification_history',
  {
    title: 'Past notifications',
    description: 'What has already been sent to the team about a game, with timestamps and any answers.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      limit: z.number().optional().describe('How many to return. Defaults to 10.'),
    },
  },
  async ({ game, limit }) => {
    try {
      const project = await resolveProject(game)
      const ctx = await getNotifyContext(project.universeId)
      const items = ctx.history.slice(0, limit ?? 10)
      if (items.length === 0) return ok(`Nothing has been sent about ${project.gameName} yet.`)

      return ok(
        items
          .map((h) => {
            const answers = h.responses.length
              ? h.responses
                  .map((r) => `${r.responderLabel}=${r.choice === 'approve' ? h.approveLabel : h.declineLabel}`)
                  .join(', ')
              : h.actionsEnabled
                ? 'no answers yet'
                : null
            return (
              `${new Date(h.createdAt).toISOString()} — ${h.senderLabel} → "${h.roleName}" ` +
              `(${h.sentCount}/${h.totalCount} delivered)\n  ${h.message.replace(/\n/g, '\n  ')}` +
              `${h.imageUrls.length ? `\n  ${h.imageUrls.length} image(s)` : ''}` +
              `${answers ? `\n  answers: ${answers}` : ''}`
            )
          })
          .join('\n\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Upload ──────────────────────────────────────────────────────────────────

server.registerTool(
  'upload_thumbnail',
  {
    title: 'Upload a thumbnail to Roblox',
    description:
      'Publish a local image as a thumbnail on a Roblox game. Roblox moderates asynchronously, so a Pending result is normal rather than a failure.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      imagePath: z.string().describe('Path to the image file on this machine.'),
    },
  },
  async ({ game, imagePath }) => {
    try {
      const project = await resolveProject(game)
      const result = await uploadThumbnail(project.universeId, imagePath)

      if (result.error) return ok(`Roblox refused the upload: ${result.error}`)
      const status = result.moderationStatus ?? 'unknown'
      return ok(
        `Uploaded to ${project.gameName}. Moderation: ${status}` +
          `${result.assetId ? ` · asset ${result.assetId}` : ''}` +
          `${status === 'Pending' || status === 'Processing' ? '\nRoblox is still reviewing it; this is normal and it usually clears within a few minutes.' : ''}`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
