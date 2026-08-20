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
  listChannels,
  getChannelMessages,
  sendChannelMessage,
  createTicket,
  TICKET_TYPES,
} from './client.js'

const server = new McpServer({ name: 'whitehat-thumbnails', version: '1.2.0' })

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
      'DM everyone holding a Discord role about a game. Can attach images and can ask for an answer with two buttons whose labels you choose (for example Approve/Disapprove, or Paid/Cancel). When buttons are used, whoever answers has their decision sent to the whole role. Pass paymentAmount to make it an invoice for commissioned work: the DM shows the amount and a pay button, the buttons default to Paid/Cancel, and clicking Paid marks the ticket paid.',
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
      paymentAmount: z
        .number()
        .optional()
        .describe('What this commission costs, in dollars. Makes it a payment ticket.'),
      paypalLink: z
        .string()
        .optional()
        .describe('Where to send the money, e.g. paypal.me/name. Shown as a pay button.'),
    },
  },
  async ({
    game,
    role,
    message,
    imagePaths,
    imageUrls,
    askForAnswer,
    approveLabel,
    declineLabel,
    paymentAmount,
    paypalLink,
  }) => {
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
        // An invoice gets buttons whether or not they were asked for; there is
        // no way to mark it paid without them.
        actionsEnabled: askForAnswer ?? paymentAmount !== undefined,
        approveLabel,
        declineLabel,
        paymentAmount,
        paypalLink,
      })

      const lines = [
        `Sent to ${result.sent} of ${result.deliveries.length} in "${chosen.name}" about ${project.gameName}.`,
      ]
      const problems = result.deliveries.filter((d) => d.status !== 'sent')
      if (problems.length) {
        lines.push('', 'Did not arrive:')
        for (const p of problems) lines.push(`  ${p.label} — ${p.detail ?? p.status}`)
      }
      const isInvoice = paymentAmount !== undefined
      if (askForAnswer ?? isInvoice) {
        const yes = approveLabel ?? (isInvoice ? 'Paid' : 'Approve')
        const no = declineLabel ?? (isInvoice ? 'Cancel' : 'No')
        lines.push('', `Buttons: "${yes}" / "${no}". Answers are broadcast to the role.`)
      }
      if (isInvoice) {
        lines.push(
          `Invoice for $${paymentAmount}${paypalLink ? ` · ${paypalLink}` : ''} — ticket ${result.entry.id}. It counts as paid once someone clicks "${approveLabel ?? 'Paid'}".`
        )
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
    description:
      'What has already been sent to the team about a game, with timestamps and any answers. Each answer names who gave it, what they chose, their Discord id, and when — so a caller can gate on a specific pair of people having both approved. Payment tickets also report whether they are paid.',
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
            // One line per answer rather than a comma list: a caller gating on
            // "both of them approved" needs each person's id and the moment they
            // decided, not a summary that reads well.
            const answers = h.responses.length
              ? h.responses
                  .map(
                    (r) =>
                      `    ${r.responderLabel} (${r.discordUserId}) = ` +
                      `${r.choice === 'approve' ? h.approveLabel : h.declineLabel} ` +
                      `at ${new Date(r.createdAt).toISOString()}`
                  )
                  .join('\n')
              : h.actionsEnabled
                ? '    no answers yet'
                : null

            const payment =
              h.paymentAmount !== null && h.paymentAmount !== undefined
                ? `\n  payment: $${h.paymentAmount}` +
                  `${h.paypalLink ? ` · ${h.paypalLink}` : ''} · ` +
                  (h.paid
                    ? `PAID${h.paidByLabel ? ` by ${h.paidByLabel}` : ''}` +
                      `${h.paidAt ? ` at ${new Date(h.paidAt).toISOString()}` : ''}`
                    : 'UNPAID')
                : ''

            // A ticket names itself; a plain note is only ever "who told whom".
            const heading = h.ticketType
              ? `[${h.ticketType}] ${h.title ?? '(untitled)'} — ${h.senderLabel} via ${h.source}` +
                `${h.channelMessageId ? ` in channel ${h.channelId}` : ''}`
              : `${h.senderLabel} → "${h.roleName}" (${h.sentCount}/${h.totalCount} delivered)`

            return (
              `${new Date(h.createdAt).toISOString()} — ${heading} · ticket ${h.id}` +
              `\n  ${h.message.replace(/\n/g, '\n  ')}` +
              `${h.imageUrls.length ? `\n  ${h.imageUrls.length} image(s)` : ''}` +
              payment +
              `${answers ? `\n  answers:\n${answers}` : ''}`
            )
          })
          .join('\n\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Tickets ─────────────────────────────────────────────────────────────────

server.registerTool(
  'create_ticket',
  {
    title: 'File a ticket',
    description:
      "Open a ticket on a game — the same thing the /ticket command does in Discord. It is posted as an embed with Approve and Deny buttons in whichever channel that game is configured for, and shows up in get_notification_history alongside everything else. Use type 'payment' with amountUsd to ask for money; the ticket counts as paid once someone clicks Paid.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      type: z
        .enum(TICKET_TYPES)
        .describe('concept_review, final_review, payment, or status.'),
      title: z.string().describe('Short summary, shown as the embed heading.'),
      description: z.string().describe('What needs doing, or what happened.'),
      imagePaths: z
        .array(z.string())
        .optional()
        .describe('Local image files to attach. Uploaded automatically. Up to 4.'),
      imageUrls: z
        .array(z.string())
        .optional()
        .describe('Already-public image URLs to attach. Up to 4 in total with imagePaths.'),
      amountUsd: z
        .number()
        .optional()
        .describe('What it costs, in dollars. Required for a payment ticket.'),
      paypalLink: z.string().optional().describe('Where to send the money, e.g. paypal.me/name.'),
      role: z
        .string()
        .optional()
        .describe('Also DM this Discord role, for people who prefer DMs to channels.'),
    },
  },
  async ({ game, type, title, description, imagePaths, imageUrls, amountUsd, paypalLink, role }) => {
    try {
      const project = await resolveProject(game)

      const uploaded: string[] = []
      for (const path of imagePaths ?? []) {
        uploaded.push(await uploadNotificationImage(project.universeId, path))
      }
      const allImages = [...uploaded, ...(imageUrls ?? [])].slice(0, 4)

      const result = await createTicket(project.universeId, {
        type,
        title,
        description,
        imageUrls: allImages,
        amountUsd,
        paypalLink,
        role,
      })

      const lines = [`Ticket ${result.ticketId} — "${title}" on ${project.gameName}.`]
      lines.push(
        result.posted
          ? `Posted in ${result.channelName ? `#${result.channelName}` : 'the game channel'} with answer buttons.`
          : `Not posted: ${result.channelProblem ?? 'no channel configured for this game.'}`
      )
      if (result.dmTotal > 0) {
        lines.push(`Also DM'd to ${result.dmSent} of ${result.dmTotal} in "${role}".`)
      }
      if (amountUsd !== undefined) {
        lines.push(`Invoice for $${amountUsd}. It counts as paid once someone clicks Paid.`)
      }
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Studio channels ─────────────────────────────────────────────────────────

server.registerTool(
  'list_artist_channels',
  {
    title: 'List studio channels',
    description:
      'The text channels the bot can see in the studio Discord server, with their ids — one per artist. Use this to turn an artist name into a channel id. A channel missing from this list is one the bot has not been given access to.',
    inputSchema: {},
  },
  async () => {
    try {
      const channels = await listChannels()
      if (channels.length === 0) return ok('The bot cannot see any text channels in the server.')
      return ok(
        channels
          .map((c) => `#${c.name} — id ${c.id}${c.category ? ` (in ${c.category})` : ''}`)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'get_channel_messages',
  {
    title: 'Read a channel',
    description:
      'Messages in a studio channel, oldest first, with author, time, text and attachment URLs. Pass the lastMessageId from the previous read as `since` to get only what is new — that is how a poll avoids re-reading. Attachment links are signed and expire within about a day, so download art when you see it rather than saving the URL.',
    inputSchema: {
      channelId: z.string().describe('Channel id from list_artist_channels.'),
      since: z
        .string()
        .optional()
        .describe('Only messages after this one. A message id, or a time like 2026-08-19T10:00:00Z.'),
      limit: z.number().optional().describe('How many at most. Defaults to 50.'),
    },
  },
  async ({ channelId, since, limit }) => {
    try {
      const { messages, lastMessageId } = await getChannelMessages(channelId, { since, limit })
      if (messages.length === 0) return ok('Nothing new in that channel.')

      const body = messages
        .map((m) => {
          const files = m.attachments
            .map((a) => `\n    ${a.filename} (${Math.round(a.size / 1024)}kb) ${a.url}`)
            .join('')
          return (
            `${m.timestamp} — ${m.authorLabel}${m.isBot ? ' [bot]' : ''} (${m.authorId})` +
            `${m.text ? `\n  ${m.text.replace(/\n/g, '\n  ')}` : ''}` +
            `${files ? `\n  attachments:${files}` : ''}`
          )
        })
        .join('\n\n')

      return ok(`${body}\n\nlastMessageId: ${lastMessageId} — pass this as "since" next time.`)
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'send_channel_message',
  {
    title: 'Post in a channel',
    description:
      'Say something in a studio channel as the bot, as plain text or as an embed — the card with a coloured bar, a title, fields and link buttons. Images can be attached either way. Meant for messages that were already agreed on — briefs, thank-yous, status notes — not for improvising a conversation with an artist.',
    inputSchema: {
      channelId: z.string().describe('Channel id from list_artist_channels.'),
      text: z
        .string()
        .optional()
        .describe('What to post. Optional when an embed carries the message instead.'),
      imagePaths: z
        .array(z.string())
        .optional()
        .describe('Local image files to attach. Up to 4.'),
      embed: z
        .object({
          title: z.string().optional().describe('Heading, shown in the accent colour.'),
          description: z.string().optional().describe('The body. Markdown works here.'),
          url: z.string().optional().describe('Makes the title a link.'),
          color: z
            .union([z.string(), z.number()])
            .optional()
            .describe('The left bar, as "#facc15" or a number. Defaults to the app yellow.'),
          author: z.string().optional().describe('Small line above the title.'),
          footer: z.string().optional().describe('Small line underneath.'),
          fields: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
                inline: z.boolean().optional().describe('Sit side by side, up to three per row.'),
              })
            )
            .optional()
            .describe('Labelled rows, for numbers and short facts. Up to 25.'),
          imageUrl: z.string().optional().describe('Large image below the text. Must be a public URL.'),
          thumbnailUrl: z.string().optional().describe('Small image in the top-right corner.'),
          buttons: z
            .array(z.object({ label: z.string(), url: z.string() }))
            .optional()
            .describe('Link buttons underneath, up to 5. They open a URL; they cannot ask a question — use notify_team for that.'),
        })
        .optional()
        .describe('Send as an embed card rather than plain text.'),
    },
  },
  async ({ channelId, text, imagePaths, embed }) => {
    try {
      if (!text && !embed && !(imagePaths ?? []).length) {
        return fail(new Error('Give it something to post: text, an embed, or images.'))
      }
      const { messageId } = await sendChannelMessage(channelId, text ?? '', imagePaths ?? [], embed)
      const count = (imagePaths ?? []).slice(0, 4).length
      return ok(
        `Posted in the channel${embed ? ' as an embed' : ''}${count ? ` with ${count} attachment(s)` : ''}. Message ${messageId}.`
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
