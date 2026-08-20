#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
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
  createChannel,
  linkChannel,
  getChannelMessages,
  sendChannelMessage,
  createTicket,
  postTicketPanel,
  setTicketClosed,
  TICKET_TYPES,
  type Capabilities,
  getCapabilities,
  getAutoSwap,
  getCronStatus,
  setProjectCredentials,
  setActiveThumbnails,
  deleteThumbnail,
  generate,
  getGenerations,
  uploadStoredGeneration,
  listProfiles,
  configureAutoSwap,
  runAutoSwap,
  getAutoSwapLogs,
  getQueue,
  addToQueue,
  removeFromQueue,
  getGameInfo,
  parseGameRef,
  addProject,
  searchRobloxGames,
  getQptrSeries,
  getMomentum,
  buildThumbnailPdf,
  listTickets,
  listShares,
  listInvites,
  createInvite,
} from './client.js'

const server = new McpServer({ name: 'whitehat-thumbnails', version: '1.3.0' })

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
      ticket: z
        .string()
        .optional()
        .describe(
          'Relay a copy into this ticket, by number (0007, or just 7) or by id. The DMs still go out exactly the same; the ticket additionally gets the note and every answer to it, so it reads as the whole story.'
        ),
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
    ticket,
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

      // A number is what someone reading the channel list has; an id is what
      // create_ticket handed back. Resolved here so the API only ever sees an id.
      let parentTicketId: string | undefined
      if (ticket) {
        const digits = ticket.replace(/[^0-9]/g, '')
        const { tickets } = await listTickets(project.universeId)
        const found =
          tickets.find((t) => t.id === ticket) ??
          (digits ? tickets.find((t) => t.ticketNumber === Number(digits)) : undefined)
        if (!found) {
          const open = tickets
            .filter((t) => t.ticketNumber != null && !t.closed)
            .map((t) => String(t.ticketNumber).padStart(4, '0'))
          return fail(
            new Error(
              `No ticket "${ticket}" on ${project.gameName}. Open right now: ${open.join(', ') || 'none'}.`
            )
          )
        }
        parentTicketId = found.id
      }

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
        parentTicketId,
      })

      const lines = [
        `Sent to ${result.sent} of ${result.deliveries.length} in "${chosen.name}" about ${project.gameName}.`,
      ]
      if (ticket) {
        lines.push(
          result.loggedToTicket
            ? `Copied into ticket ${ticket}, and answers will land there too.`
            : `Could not write it into ticket ${ticket} — the DMs went out regardless.`
        )
      }
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
      "Open a ticket on a game — the same thing the /ticket command does in Discord. Each ticket gets a channel of its own, named 🟢-0001 and filed under a category named after the game, so the sidebar reads as what is open on it; closing the ticket renames that channel to closed-0001 and drops the dot. The ticket itself is an embed with Approve, Deny and Close buttons. Use type 'payment' with amountUsd to ask for money; it counts as paid once someone clicks Paid.",
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

      const number = String(result.ticketNumber).padStart(4, '0')
      const lines = [`Ticket ${number} — "${title}" on ${project.gameName}. Id ${result.ticketId}.`]
      lines.push(
        result.posted
          ? `Opened ${result.channelName ? `#${result.channelName}` : 'a channel'} for it, with answer and close buttons.`
          : `Not posted: ${result.channelProblem ?? 'no channel available for this game.'}`
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

server.registerTool(
  'close_ticket',
  {
    title: 'Close or reopen a ticket',
    description:
      "Close a ticket once it is done, or open a closed one back up. Closing renames its channel from 🟢-0007 to closed-0007 and greys the embed, so the sidebar stops showing it as live work. The same thing the Close button on the ticket and /close-ticket in Discord do. Name the ticket by its number (0007, or just 7) or by the id create_ticket handed back.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      ticket: z.string().describe('Ticket number, e.g. 0007, or the ticket id.'),
      reopen: z
        .boolean()
        .optional()
        .describe('Open it back up instead of closing it.'),
      reason: z
        .string()
        .optional()
        .describe('A closing note, posted in the ticket channel for the record.'),
    },
  },
  async ({ game, ticket, reopen, reason }) => {
    try {
      const project = await resolveProject(game)
      const closing = reopen !== true
      const r = await setTicketClosed(project.universeId, ticket, closing, reason)

      const number = r.ticketNumber != null ? String(r.ticketNumber).padStart(4, '0') : ticket
      if (!r.changed) return ok(`Ticket ${number} was already ${closing ? 'closed' : 'open'}.`)

      const lines = [
        closing ? `Closed ticket ${number} on ${project.gameName}.` : `Reopened ticket ${number} on ${project.gameName}.`,
      ]
      if (r.channelName) lines.push(`Its channel is #${r.channelName} now.`)
      if (r.renameProblem) lines.push(r.renameProblem)
      return ok(lines.join(' '))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'post_ticket_panel',
  {
    title: 'Put up the Add ticket button',
    description:
      "Post a game's standing \"Add ticket\" button in its channel. Anyone who clicks it gets a short form, and filing it opens a numbered channel for that ticket under the game's category. create_channel and link_channel already do this when they point a game at a channel, so this is for putting the button back after it has scrolled out of sight, or moving it somewhere else. Posting it again takes the previous one down rather than leaving two.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      channelId: z
        .string()
        .optional()
        .describe("Where to put it. Defaults to the channel the game is already linked to."),
      role: z
        .string()
        .optional()
        .describe(
          'Who to ping in each new ticket channel, by name, e.g. "Thumbnail Team". Guessed from the role list the first time and remembered after that.'
        ),
    },
  },
  async ({ game, channelId, role }) => {
    try {
      const project = await resolveProject(game)
      const result = await postTicketPanel(project.universeId, channelId, role)
      return ok(
        `The Add ticket button for ${project.gameName} is up in channel ${result.channelId}.` +
          (result.pingRoleName
            ? ` New tickets ping ${result.pingRoleName} in their own channel.`
            : ' Nothing gets pinged on a new ticket — pass a role to change that.') +
          (result.replacedOld ? ' The previous one was taken down.' : '')
      )
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
  'create_channel',
  {
    title: 'Create a studio channel',
    description:
      "Make a text channel in the studio Discord server - one per game or per artist. Pass a game to point it at that game at the same time, which is the whole of setting a new game up: the channel exists, its tickets go there, and the site's View channel button follows. Running it twice with the same name reuses the channel already there rather than making a second one. The bot needs Manage Channels; without it this comes back saying so, and the fix is a fresh invite link, not another call.",
    inputSchema: {
      name: z
        .string()
        .describe('What to call it. Tidied into the shape Discord accepts, so "Build a Mini City!" becomes build-a-mini-city.'),
      category: z
        .string()
        .optional()
        .describe('Category to file it under, by name, e.g. "bugs stuff". Top level when left out.'),
      topic: z.string().optional().describe('Channel topic, shown under the name.'),
      game: z
        .string()
        .optional()
        .describe('Game name or universe id. Given, the new channel is linked to it as well.'),
    },
  },
  async ({ name, category, topic, game }) => {
    try {
      const { channel, url } = await createChannel({ name, categoryName: category, topic })

      const lines = [
        channel.created
          ? `Created #${channel.name} - id ${channel.id}${channel.category ? ` in ${channel.category}` : ''}.`
          : `#${channel.name} already existed - id ${channel.id}${channel.category ? ` in ${channel.category}` : ''}. Reused it.`,
        url,
      ]

      // Linking is a second call against the project rather than part of
      // creation, so a game that cannot be resolved still leaves the channel
      // standing and says what is left to do.
      if (game) {
        const project = await resolveProject(game)
        await linkChannel(project.universeId, channel.id)
        lines.push(
          `Linked to ${project.gameName}: tickets post there, and the site's View channel button points at it.`
        )

        // The button is the whole point of the channel, so it goes up as part
        // of setting the game up rather than as a second thing to remember.
        // A failure here is reported and nothing else: the channel exists and
        // is linked, and post_ticket_panel can finish the job on its own.
        try {
          await postTicketPanel(project.universeId, channel.id)
          lines.push('Put the Add ticket button in it.')
        } catch (err) {
          lines.push(
            `Could not put the Add ticket button up: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'link_channel',
  {
    title: 'Link a game to a channel',
    description:
      'Point a game at a channel that already exists: where its tickets get posted, and where the View channel button on its notifications goes. The same pairing /ticket config makes in Discord, without needing to be in the server. Take the id from list_artist_channels. Pass no channel to unlink.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      channelId: z
        .string()
        .optional()
        .describe('Channel id from list_artist_channels. Leave out to unlink the game.'),
    },
  },
  async ({ game, channelId }) => {
    try {
      const project = await resolveProject(game)
      const result = await linkChannel(project.universeId, channelId ?? null)

      if (!result.ticketChannelId) return ok(`${project.gameName} is no longer linked to a channel.`)

      const lines = [
        `${project.gameName} -> #${result.ticketChannelName ?? result.ticketChannelId}. ` +
          `Tickets post there${result.discordChannelUrl ? `, and the View channel button points at ${result.discordChannelUrl}` : ''}.`,
      ]

      // Linking a game to a channel is the moment its Add ticket button belongs
      // in that channel, so it goes up here too rather than being left as a
      // step someone has to know about.
      try {
        const panel = await postTicketPanel(project.universeId, result.ticketChannelId)
        lines.push(
          panel.replacedOld
            ? 'Moved the Add ticket button there and took the old one down.'
            : 'Put the Add ticket button in it.'
        )
      } catch (err) {
        lines.push(
          `Could not put the Add ticket button up: ${err instanceof Error ? err.message : String(err)}`
        )
      }

      return ok(lines.join('\n'))
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

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * Render the capability report.
 *
 * Two lists rather than one annotated list: the first question anyone has is
 * "what can I do right now", and burying three working tools among six broken
 * ones answers it slowly. Everything that does not work carries the reason and
 * the fix, since "no" alone sends a caller round the same loop again.
 */
function renderCapabilities(cap: Capabilities): string {
  const can: string[] = []
  const cannot: string[] = []
  const yes = (tool: string, why: string) => can.push(`  ${tool}\n      ${why}`)
  const no = (tool: string, why: string, fix: string) =>
    cannot.push(`  ${tool}\n      ${why}\n      Fix: ${fix}`)

  const { settings, thumbnails, discord, autoSwap, channel } = cap
  const owner = !cap.project.shared

  // A cookie is the authority behind every write to Roblox. The site falls back
  // to a shared default account, which is why "configured" and "can edit this
  // game" are separate questions.
  const account = settings?.account ?? null
  const canEdit = account?.canEdit ?? null
  const accountLabel = account
    ? `${account.name ?? 'unnamed account'}${settings?.usingDefault ? ' (the shared default account)' : ' (set on this project)'}`
    : null

  // ── Reading ──
  if (thumbnails) {
    const total = thumbnails.active.length + thumbnails.inactive.length
    yes(
      'get_thumbnails',
      `${thumbnails.active.length} active, ${thumbnails.inactive.length} inactive` +
        `${thumbnails.source === 'public' ? ' — read from the public game page' : ''}`
    )

    const withNumbers = [...thumbnails.active, ...thumbnails.inactive].filter(
      (t) => t.impressions !== undefined || t.qptr !== undefined
    )
    if (withNumbers.length) {
      yes(
        'analytics (QPTR, impressions, playtime)',
        `figures came back for ${withNumbers.length} of ${total} thumbnails` +
          `${settings?.hasKey ? ` via the Open Cloud key ${settings.hint ?? ''}`.trimEnd() : ' via the Roblox account'}`
      )
    } else {
      no(
        'analytics (QPTR, impressions, playtime)',
        settings?.hasKey
          ? 'an Open Cloud key is stored but returned no figures for this game'
          : 'no Open Cloud key is stored for this game, and the account could not read the numbers',
        settings?.hasKey
          ? 'the key belongs to a different creator, or lacks the analytics scope on this universe. Mint one under the group or user that owns the game, with universe.analytics read, then set it with set_project_credentials.'
          : 'create a Roblox Open Cloud key with analytics read on this universe and pass it to set_project_credentials.'
      )
    }
  } else {
    no(
      'get_thumbnails and everything downstream of it',
      cap.thumbnailsProblem ?? 'the thumbnail report could not be read',
      'check the universe id, and that this key reaches the project.'
    )
  }

  // ── Writing to Roblox ──
  if (canEdit === true) {
    yes('upload_thumbnail', `signed in as ${accountLabel}, which can edit this game`)
    yes('delete_thumbnail', 'the same account can remove variants')
  } else if (canEdit === false) {
    no(
      'upload_thumbnail, delete_thumbnail',
      `${accountLabel} is signed in but Roblox refuses it edit access to this game`,
      'give that account permission on the experience, or store a cookie for one that already has it with set_project_credentials.'
    )
  } else if (!owner) {
    // The settings route is owner-only, so a shared project cannot see the
    // account at all — but the thumbnail source still says whether writes are
    // plausible, which is more useful than silence.
    const plausible = thumbnails?.source !== 'public'
    cannot.push(
      `  upload_thumbnail, delete_thumbnail, set_active_thumbnails\n` +
        `      This project is shared with you, not owned by you, so the account behind it is not visible from here.\n` +
        `      ${plausible ? 'Reads are coming from the authenticated API, so writes will probably work — try one.' : 'Reads are falling back to the public page, so writes will probably fail.'}\n` +
        `      Fix: ask the owner, or run this against a project you own.`
    )
  } else {
    no(
      'upload_thumbnail, delete_thumbnail',
      'no Roblox account is configured for this project',
      'store a .ROBLOSECURITY cookie for an account that can edit the game with set_project_credentials.'
    )
  }

  // ── Swapping the live set ──
  if (thumbnails?.canSwap && canEdit !== false) {
    yes('set_active_thumbnails', 'a personalization config was resolved, so the live set can be changed')
  } else if (thumbnails && !thumbnails.canSwap) {
    no(
      'set_active_thumbnails, auto-swap',
      'Roblox returned no personalization config for this game, so it has no swappable live set',
      'the game needs more than one homepage thumbnail before Roblox will personalize it. Upload another and check again.'
    )
  }

  // ── Auto-swap ──
  if (autoSwap) {
    if (autoSwap.autoDisabledReason) {
      no(
        'auto-swap',
        `it turned itself off: ${autoSwap.autoDisabledReason}`,
        'fix the cause, then call configure_auto_swap with enabled true to clear the flag.'
      )
    } else if (autoSwap.autoSwapEnabled) {
      yes(
        'auto-swap',
        `on, every ${autoSwap.swapFrequencyMinutes} min, dropping ${autoSwap.dropCount} at a time` +
          `${autoSwap.nextSwapAt ? ` — next ${new Date(autoSwap.nextSwapAt).toISOString()}` : ''}` +
          `${cap.cron ? `; the cron ticks every ${cap.cron.intervalMinutes} min` : ''}`
      )
    } else {
      yes('configure_auto_swap, run_auto_swap', 'auto-swap is off; it can be turned on or fired once by hand')
    }
  }

  // ── Discord ──
  if (discord?.configured && !discord.error) {
    yes('notify_team, create_ticket', `${discord.roles.length} roles reachable`)
    if (channel?.ticketChannelId) {
      yes('channel tools', `tickets on this game post to #${channel.ticketChannelName ?? channel.ticketChannelId}`)
    } else {
      no(
        'ticket posting to a channel',
        'this game is not linked to a Discord channel, so tickets only go out as DMs',
        'call create_channel with this game, or link_channel with an existing channel id.'
      )
    }
  } else {
    no(
      'notify_team, create_ticket, channel tools',
      discord?.error ?? cap.discordProblem ?? 'Discord is not set up on the server',
      'the bot token and guild have to be configured on the site side; this is not something a key can grant.'
    )
  }

  // ── Generation ──
  // Not probed: the only honest check is generating an image, which costs money
  // and would leave a stray record behind.
  can.push(
    '  generate_thumbnail\n' +
      '      Runs on the site\'s own image keys rather than anything stored per project, so it is not probed here. ' +
      'If it is going to fail, it fails on the first call with the reason.'
  )

  const header =
    `${cap.project.gameName} — universeId ${cap.project.universeId}\n` +
    `${owner ? 'You own this project.' : 'This project is shared with you; owner-only settings are not readable from here.'}` +
    `${settings?.hasKey ? `\nOpen Cloud key: stored${settings.hint ? ` (${settings.hint})` : ''}${settings.encrypted ? ', encrypted at rest' : ', NOT encrypted — set ENCRYPTION_KEY on the site'}` : ''}` +
    `${accountLabel ? `\nRoblox account: ${accountLabel}` : ''}`

  return [
    header,
    '',
    `WORKS (${can.length})`,
    can.join('\n'),
    '',
    cannot.length ? `DOES NOT WORK (${cannot.length})` : 'Nothing is blocked.',
    cannot.join('\n'),
  ]
    .filter((part) => part !== '')
    .join('\n')
}

server.registerTool(
  'check_permissions',
  {
    title: 'What can I do to this game',
    description:
      "Everything this key is allowed to do to one game, probed rather than assumed: whether analytics are readable, whether the Roblox account behind the project can upload, delete and swap the live set, whether the game has a personalization config at all, whether auto-swap is armed, and whether Discord and its channel are wired up. Call this first when a write is about to happen, or when something failed and it is not obvious which credential was missing — every 'no' comes back with the reason and what would fix it.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const cap = await getCapabilities(project)
      return ok(renderCapabilities(cap))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'set_project_credentials',
  {
    title: 'Store Roblox credentials for a game',
    description:
      "Attach an Open Cloud API key and/or a .ROBLOSECURITY cookie to a game — the two things check_permissions reports missing. The key unlocks analytics; the cookie unlocks uploading, deleting and swapping the live set. Both are stored encrypted and never read back. Pass an empty string to clear one: clearing the cookie reverts the game to the shared default account. Owner only. Do not invent these values — they come from the user.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      openCloudKey: z
        .string()
        .optional()
        .describe('Roblox Open Cloud API key, minted by whoever owns the experience. Empty string removes it.'),
      robloSecurity: z
        .string()
        .optional()
        .describe('.ROBLOSECURITY cookie for an account that can edit this game. Empty string reverts to the default account.'),
    },
  },
  async ({ game, openCloudKey, robloSecurity }) => {
    try {
      if (openCloudKey === undefined && robloSecurity === undefined) {
        return fail(new Error('Give it an openCloudKey, a robloSecurity cookie, or both.'))
      }
      const project = await resolveProject(game)
      const lines: string[] = []

      // Sent one at a time: the site's PATCH takes a single branch per call, and
      // a rejected cookie should not silently discard a good key.
      if (openCloudKey !== undefined) {
        const res = await setProjectCredentials(project.universeId, { openCloudKey: openCloudKey || null })
        lines.push(
          res.hasKey
            ? `Open Cloud key stored for ${project.gameName}${res.hint ? ` (${res.hint})` : ''}.`
            : `Open Cloud key removed from ${project.gameName}.`
        )
      }
      if (robloSecurity !== undefined) {
        const res = await setProjectCredentials(project.universeId, { robloSecurity: robloSecurity || null })
        if (res.usingDefault) {
          lines.push(`${project.gameName} is back on the shared default Roblox account.`)
        } else {
          lines.push(
            `Roblox account stored: ${res.account?.name ?? 'unnamed'}. ` +
              (res.account?.canEdit
                ? 'It can edit this game.'
                : 'Roblox does NOT give it edit access to this game — uploads and swaps will fail until it is granted.')
          )
        }
      }

      lines.push('Run check_permissions to see what that changed.')
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

// ── The live set ────────────────────────────────────────────────────────────

server.registerTool(
  'set_active_thumbnails',
  {
    title: 'Choose which thumbnails are live',
    description:
      "Change which of a game's thumbnails Roblox shows on the homepage. Ids can be either the asset ids get_thumbnails leads with or the internal thumbnail ids — both are accepted and resolved. mode 'replace' makes exactly the listed set live and everything else inactive; 'add' and 'remove' adjust the current set instead, which is what you usually want when acting on one thumbnail. The change is immediate and Roblox starts serving it to players; nothing is deleted either way, so an inactive variant can always be brought back.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      ids: z
        .array(z.string())
        .describe('Asset ids or thumbnail ids from get_thumbnails.'),
      mode: z
        .enum(['replace', 'add', 'remove'])
        .optional()
        .describe("'replace' (default) sets the live set to exactly these. 'add' activates them alongside what is live. 'remove' deactivates them."),
    },
  },
  async ({ game, ids, mode }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId)

      if (!report.canSwap) {
        return ok(
          `Roblox returned no personalization config for ${project.gameName}, so its live set cannot be changed. ` +
            'A game needs more than one homepage thumbnail before Roblox will personalize it.'
        )
      }

      const all = [...report.active, ...report.inactive]
      // Callers read asset ids off the report far more often than thumbnail ids,
      // so both are accepted rather than making them look up a second id.
      const byAny = new Map<string, (typeof all)[number]>()
      for (const t of all) {
        byAny.set(t.assetId, t)
        byAny.set(t.thumbnailId, t)
      }

      const chosen: typeof all = []
      const unknown: string[] = []
      for (const id of ids) {
        const hit = byAny.get(id.trim())
        if (!hit) unknown.push(id)
        else if (!chosen.includes(hit)) chosen.push(hit)
      }
      if (unknown.length) {
        return fail(
          new Error(
            `Not thumbnails on ${project.gameName}: ${unknown.join(', ')}. Call get_thumbnails with includeInactive to see the ids.`
          )
        )
      }

      const currentIds = report.active.map((t) => t.thumbnailId)
      const chosenIds = chosen.map((t) => t.thumbnailId)

      let nextIds: string[]
      if (mode === 'add') nextIds = [...new Set([...currentIds, ...chosenIds])]
      else if (mode === 'remove') nextIds = currentIds.filter((id) => !chosenIds.includes(id))
      else nextIds = chosenIds

      if (nextIds.length === 0) {
        return fail(
          new Error(
            'That would leave the game with no live thumbnail. Roblox needs at least one — activate a replacement in the same call.'
          )
        )
      }

      const same =
        nextIds.length === currentIds.length && nextIds.every((id) => currentIds.includes(id))
      if (same) {
        return ok(`No change — those ${nextIds.length} thumbnail(s) are already the live set on ${project.gameName}.`)
      }

      await setActiveThumbnails(project.universeId, nextIds)

      const label = (id: string) => byAny.get(id)?.assetId ?? id
      const added = nextIds.filter((id) => !currentIds.includes(id))
      const removed = currentIds.filter((id) => !nextIds.includes(id))

      return ok(
        [
          `${project.gameName} is now serving ${nextIds.length} thumbnail(s): ${nextIds.map(label).join(', ')}.`,
          added.length ? `Activated: ${added.map(label).join(', ')}` : null,
          removed.length ? `Deactivated (still stored, not deleted): ${removed.map(label).join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'delete_thumbnail',
  {
    title: 'Delete a thumbnail from Roblox',
    description:
      'Permanently remove a thumbnail from a Roblox game. This is not the same as taking it out of the live set — set_active_thumbnails with mode "remove" does that and keeps the image, which is almost always what is wanted. Roblox has no undo for a delete, and the analytics history for that asset goes with it. Only reach for this when the image should not exist on the game at all.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      id: z.string().describe('Asset id or thumbnail id from get_thumbnails.'),
    },
  },
  async ({ game, id }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId)
      const all = [...report.active, ...report.inactive]
      const target = all.find((t) => t.assetId === id.trim() || t.thumbnailId === id.trim())

      if (!target) {
        return fail(
          new Error(
            `${id} is not a thumbnail on ${project.gameName}. Call get_thumbnails with includeInactive to see the ids.`
          )
        )
      }
      if (target.isActive && report.active.length === 1) {
        return fail(
          new Error(
            'That is the only live thumbnail on the game. Activate another one first, or the game would be left with none.'
          )
        )
      }

      await deleteThumbnail(project.universeId, target.thumbnailId)
      return ok(
        `Deleted asset ${target.assetId} from ${project.gameName}${target.isActive ? ' — it was live, so the remaining active thumbnails now carry the game' : ''}. This cannot be undone.`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Generation ──────────────────────────────────────────────────────────────

server.registerTool(
  'generate_thumbnail',
  {
    title: 'Generate a thumbnail',
    description:
      "Make a new thumbnail image with the site's AI pipeline — the same one the generator page uses — from a prompt and at least one reference image. The prompt is rewritten against the studio style guide first unless enhance is turned off. The result is written to a file on this machine so it can be looked at, and saved to the project's history. Pass publish to send it straight to Roblox, which is only worth doing when the image has already been agreed on; otherwise generate, look at it, then call upload_thumbnail.",
    inputSchema: {
      game: z.string().describe('Game name or universe id. The generation is saved to this project.'),
      prompt: z.string().describe('What the thumbnail should show.'),
      referenceUrls: z
        .array(z.string())
        .optional()
        .describe('Public image URLs to steer style and subject. The first is treated as the primary reference unless primaryIndex says otherwise.'),
      referencePaths: z
        .array(z.string())
        .optional()
        .describe('Local image files to use as references. Hosted automatically. At least one reference, by path or URL, is required.'),
      primaryIndex: z
        .number()
        .optional()
        .describe('Which reference to match most closely, counting URLs then paths. Defaults to the first.'),
      enhance: z
        .boolean()
        .optional()
        .describe('Rewrite the prompt against the style guide first. Defaults to true.'),
      profile: z
        .string()
        .optional()
        .describe('Name of a style profile to enhance against. See list_style_profiles.'),
      model: z
        .enum(['gemini', 'openai'])
        .optional()
        .describe('Which image model to use. Defaults to gemini.'),
      outputPath: z
        .string()
        .optional()
        .describe('Where to write the PNG. Defaults to a temp file, whose path is returned.'),
      publish: z
        .boolean()
        .optional()
        .describe('Upload it to Roblox immediately. Defaults to false.'),
    },
  },
  async ({ game, prompt, referenceUrls, referencePaths, primaryIndex, enhance, profile, model, outputPath, publish }) => {
    try {
      const project = await resolveProject(game)

      const hosted: string[] = []
      for (const path of referencePaths ?? []) {
        hosted.push(await uploadNotificationImage(project.universeId, path))
      }
      const allRefs = [...(referenceUrls ?? []), ...hosted]
      if (allRefs.length === 0) {
        return fail(
          new Error('The image model needs at least one reference. Pass referenceUrls or referencePaths.')
        )
      }

      const result = await generate({
        prompt,
        imageUrls: allRefs,
        primaryIndex: primaryIndex ?? 0,
        universeId: project.universeId,
        gameName: project.gameName,
        enhanceWithAI: enhance ?? true,
        imageModel: model ?? 'gemini',
        profile,
      })

      const ext = result.mimeType.split('/')[1] ?? 'png'
      const target = outputPath ?? join(tmpdir(), `wht-${project.universeId}-${Date.now()}.${ext}`)
      await writeFile(target, Buffer.from(result.imageBase64, 'base64'))

      const lines = [
        `Generated a thumbnail for ${project.gameName}.`,
        `Written to ${target} — open it before publishing.`,
        result.saved
          ? `Saved to the project history as generation ${result.generationId}.`
          : 'Not saved to history (the site has no blob storage configured), so it exists only as that file.',
      ]
      if (enhance !== false) {
        lines.push('', 'Prompt actually used:', result.enhancedPrompt)
      }

      if (publish) {
        // Publishing by id reuses the stored copy rather than sending the bytes
        // back up, and is the only path that records the asset id against the
        // generation.
        const exported = result.generationId
          ? await uploadStoredGeneration(project.universeId, result.generationId)
          : await uploadThumbnail(project.universeId, target)

        lines.push(
          '',
          exported.error
            ? `Roblox refused the upload: ${exported.error}`
            : `Published to Roblox. Moderation: ${exported.moderationStatus ?? 'unknown'}` +
              `${exported.assetId ? ` · asset ${exported.assetId}` : ''}`
        )
      }

      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'list_generations',
  {
    title: 'Past generations',
    description:
      "Every thumbnail generated for a game, newest first, with the prompt behind it, the rewritten prompt the model actually saw, the references used and the stored image URL. Use it to find something made earlier and publish it with upload_generation, or to reuse a prompt that worked.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      limit: z.number().optional().describe('How many to return. Defaults to 20.'),
    },
  },
  async ({ game, limit }) => {
    try {
      const project = await resolveProject(game)
      const { generations } = await getGenerations(project.universeId)
      const items = generations.slice(0, limit ?? 20)
      if (items.length === 0) return ok(`Nothing has been generated for ${project.gameName} yet.`)

      return ok(
        items
          .map(
            (g) =>
              `${new Date(g.date).toISOString()} — generation ${g.id}\n` +
              `  prompt: ${g.prompt.replace(/\n/g, ' ')}\n` +
              `  ${g.imageUrl}` +
              `${g.referenceUrls.length ? `\n  ${g.referenceUrls.length} reference(s)` : ''}`
          )
          .join('\n\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'upload_generation',
  {
    title: 'Publish a stored generation',
    description:
      'Publish an image already in a project\'s history to Roblox, by its generation id from list_generations. Nothing is downloaded or re-uploaded — the site sends its own stored copy — and the resulting Roblox asset id is recorded against the generation, which is what later lets its analytics be traced back to the prompt that made it.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      generationId: z.string().describe('Generation id from list_generations.'),
    },
  },
  async ({ game, generationId }) => {
    try {
      const project = await resolveProject(game)
      const result = await uploadStoredGeneration(project.universeId, generationId)
      if (result.error) return ok(`Roblox refused the upload: ${result.error}`)
      const status = result.moderationStatus ?? 'unknown'
      return ok(
        `Published to ${project.gameName}. Moderation: ${status}` +
          `${result.assetId ? ` · asset ${result.assetId}` : ''}` +
          `${status === 'Pending' || status === 'Processing' ? '\nRoblox is still reviewing it; this is normal and usually clears within a few minutes.' : ''}`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'list_style_profiles',
  {
    title: 'List style profiles',
    description:
      'The named style guides the prompt enhancer can be pointed at, with the instructions each one carries. Pass a name as `profile` to generate_thumbnail to generate in that style instead of the studio default.',
    inputSchema: {},
  },
  async () => {
    try {
      const { profiles } = await listProfiles()
      if (profiles.length === 0) return ok('No style profiles are configured; generation uses the default studio guide.')
      return ok(
        profiles
          .map((p) => `${p.name}\n  ${p.content.replace(/\n/g, '\n  ').slice(0, 600)}`)
          .join('\n\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Auto-swap ───────────────────────────────────────────────────────────────

server.registerTool(
  'get_auto_swap',
  {
    title: 'Auto-swap status',
    description:
      "Whether a game rotates its own thumbnails, on what schedule and rules, and what the last runs actually did. Auto-swap drops the worst-performing live thumbnails by QPTR and promotes replacements from the queue. A game that turned itself off reports why — that reason is the thing to act on.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      logs: z.number().optional().describe('How many past runs to include. Defaults to 5.'),
    },
  },
  async ({ game, logs }) => {
    try {
      const project = await resolveProject(game)
      const [config, history, cron] = await Promise.all([
        getAutoSwap(project.universeId),
        getAutoSwapLogs(project.universeId, logs ?? 5),
        getCronStatus().catch(() => null),
      ])

      const lines = [
        `${project.gameName} — auto-swap is ${config.autoSwapEnabled ? 'ON' : 'OFF'}`,
        `  drops ${config.dropCount} thumbnail(s) every ${config.swapFrequencyMinutes} min`,
        `  QPTR floor ${config.qptrThreshold}% · instant drop needs ${num(config.instantDropMinImpressions)} impressions`,
        config.nextSwapAt ? `  next run ${new Date(config.nextSwapAt).toISOString()}` : null,
        config.lastSwapAt ? `  last run ${new Date(config.lastSwapAt).toISOString()}` : null,
        config.autoDisabledReason
          ? `  TURNED ITSELF OFF: ${config.autoDisabledReason}${config.autoDisabledAt ? ` at ${new Date(config.autoDisabledAt).toISOString()}` : ''}`
          : null,
        cron ? `  the scheduler ticks every ${cron.intervalMinutes} min; next tick in ${cron.secondsUntilFire}s` : null,
      ].filter(Boolean) as string[]

      if (history.logs.length) {
        lines.push('', `RECENT RUNS (${history.logs.length})`)
        for (const log of history.logs) {
          const moves = log.snapshots.length
            ? log.snapshots
                .map((s) => `      ${s.action} ${s.assetId}${s.qptr !== null ? ` (QPTR ${pct(s.qptr)})` : ''}`)
                .join('\n')
            : null
          lines.push(
            `  ${new Date(log.firedAt).toISOString()} — ${log.reason}${log.skipped ? ' · SKIPPED' : ''}` +
              `${log.note ? `\n      ${log.note}` : ''}` +
              `${moves ? `\n${moves}` : ''}`
          )
        }
      } else {
        lines.push('', 'It has never run on this game.')
      }

      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'configure_auto_swap',
  {
    title: 'Configure auto-swap',
    description:
      "Turn a game's automatic thumbnail rotation on or off and set its rules. Turning it on schedules the next run and clears any self-disabled flag. Every field is optional: only what is passed changes. Rotation pulls replacements from the queue, so a game with an empty queue will run and do nothing — check get_queue before turning it on.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      enabled: z.boolean().optional().describe('Turn rotation on or off.'),
      dropCount: z.number().optional().describe('How many of the worst live thumbnails to drop per run.'),
      frequencyMinutes: z.number().optional().describe('Minutes between runs. The scheduler ticks every few minutes, so anything under that is rounded up in practice.'),
      qptrThreshold: z.number().optional().describe('QPTR floor as a percentage, not a fraction: 2 means 2%. Live thumbnails under it are candidates to drop.'),
      instantDropMinImpressions: z
        .number()
        .optional()
        .describe('How many impressions a thumbnail needs before a bad QPTR is trusted enough to drop it immediately.'),
    },
  },
  async ({ game, enabled, dropCount, frequencyMinutes, qptrThreshold, instantDropMinImpressions }) => {
    try {
      const project = await resolveProject(game)
      const updated = await configureAutoSwap(project.universeId, {
        ...(enabled !== undefined ? { autoSwapEnabled: enabled } : {}),
        ...(dropCount !== undefined ? { dropCount } : {}),
        ...(frequencyMinutes !== undefined ? { swapFrequencyMinutes: frequencyMinutes } : {}),
        ...(qptrThreshold !== undefined ? { qptrThreshold } : {}),
        ...(instantDropMinImpressions !== undefined ? { instantDropMinImpressions } : {}),
      })

      return ok(
        [
          `${project.gameName} — auto-swap is now ${updated.autoSwapEnabled ? 'ON' : 'OFF'}.`,
          `  drops ${updated.dropCount} every ${updated.swapFrequencyMinutes} min, QPTR floor ${updated.qptrThreshold}%, instant drop over ${num(updated.instantDropMinImpressions)} impressions`,
          updated.nextSwapAt ? `  next run ${new Date(updated.nextSwapAt).toISOString()}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'run_auto_swap',
  {
    title: 'Run auto-swap now',
    description:
      "Fire a game's rotation once, immediately, without waiting for the schedule or needing it enabled. It applies the same rules — drop the worst live thumbnails by QPTR, promote from the queue — and changes what players see. A run that finds nothing worth swapping reports that rather than failing.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const result = await runAutoSwap(project.universeId)

      if (result.skipped || !result.ok) {
        return ok(`Nothing swapped on ${project.gameName}: ${result.note ?? 'the run was skipped'}.`)
      }
      const d = result.decision
      if (!d || d.noop) {
        return ok(`Ran on ${project.gameName} and changed nothing: ${d?.noopReason ?? 'no thumbnail met the rules'}.`)
      }

      return ok(
        [
          `Swapped on ${project.gameName}.`,
          d.dropped.length
            ? `  dropped: ${d.dropped.map((t) => `${t.assetId}${t.qptr !== null ? ` (QPTR ${pct(t.qptr)})` : ''}`).join(', ')}`
            : null,
          d.added.length ? `  promoted from the queue: ${d.added.map((t) => t.assetId).join(', ')}` : null,
          d.kept.length ? `  kept: ${d.kept.map((t) => t.assetId).join(', ')}` : null,
          d.autoDisableReason ? `  auto-swap turned itself off: ${d.autoDisableReason}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Queue ───────────────────────────────────────────────────────────────────

server.registerTool(
  'get_queue',
  {
    title: 'The swap queue',
    description:
      "Thumbnails lined up to go live, in the order auto-swap will promote them. This is where rotation gets its replacements: an empty queue is why an enabled auto-swap runs and does nothing.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const entries = await getQueue(project.universeId)
      if (entries.length === 0) {
        return ok(
          `${project.gameName} has an empty queue, so auto-swap has nothing to promote. Queue an inactive thumbnail with queue_thumbnail.`
        )
      }
      return ok(
        entries
          .map((e, i) => `${i + 1}. asset ${e.assetId} — entry ${e.id}\n   ${e.imageUrl}`)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'queue_thumbnail',
  {
    title: 'Queue a thumbnail',
    description:
      'Line an existing thumbnail up to go live at the next rotation. It has to already be on the game — upload it first if it is not. Queuing does not change what players see; auto-swap promotes it when it drops something, or set_active_thumbnails can put it live straight away.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      id: z.string().describe('Asset id or thumbnail id from get_thumbnails.'),
    },
  },
  async ({ game, id }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId)
      const all = [...report.active, ...report.inactive]
      const target = all.find((t) => t.assetId === id.trim() || t.thumbnailId === id.trim())

      if (!target) {
        return fail(
          new Error(
            `${id} is not a thumbnail on ${project.gameName}. Upload it first, or call get_thumbnails with includeInactive for the ids.`
          )
        )
      }
      if (target.isActive) {
        return ok(`Asset ${target.assetId} is already live on ${project.gameName}; there is nothing to promote it to.`)
      }

      const entry = await addToQueue({
        universeId: project.universeId,
        assetId: target.assetId,
        imageUrl: target.imageUrl,
      })
      return ok(`Queued asset ${target.assetId} on ${project.gameName} at position ${entry.position} — entry ${entry.id}.`)
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'unqueue_thumbnail',
  {
    title: 'Take a thumbnail out of the queue',
    description:
      'Remove an entry from the swap queue so auto-swap will not promote it. The thumbnail itself is untouched and stays on the game.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      id: z.string().describe('Queue entry id or asset id, both from get_queue.'),
    },
  },
  async ({ game, id }) => {
    try {
      const project = await resolveProject(game)
      const entries = await getQueue(project.universeId)
      const entry = entries.find((e) => e.id === id.trim() || e.assetId === id.trim())
      if (!entry) {
        return fail(new Error(`Nothing in ${project.gameName}'s queue matches ${id}. Call get_queue to see it.`))
      }
      await removeFromQueue(entry.id)
      return ok(`Took asset ${entry.assetId} out of ${project.gameName}'s queue.`)
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Trends ──────────────────────────────────────────────────────────────────

server.registerTool(
  'get_qptr_trend',
  {
    title: 'QPTR over time',
    description:
      "A game's daily click-through rate and impressions, to answer whether it is trending up or down rather than how one thumbnail is doing right now. Roblox only serves the last 30 days; anything older comes from the site's own archive, and days it has neither for come back empty rather than as a zero.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      range: z.enum(['7d', '14d', '30d']).optional().describe('How far back. Defaults to 14d.'),
    },
  },
  async ({ game, range }) => {
    try {
      const project = await resolveProject(game)
      const { series, liveDays } = await getQptrSeries(project.universeId, range ?? '14d')
      const withData = series.filter((p) => p.qptr !== null || p.impressions !== null)
      if (withData.length === 0) {
        return ok(
          `No daily figures for ${project.gameName}. Analytics need an Open Cloud key on the project — run check_permissions.`
        )
      }

      const body = series
        .map((p) => `${p.date}  QPTR ${pct(p.qptr ?? undefined)}  impressions ${num(p.impressions ?? undefined)}`)
        .join('\n')

      // Halves rather than first-vs-last: a single quiet day should not read as
      // a collapse.
      const known = withData.filter((p) => p.qptr !== null) as { qptr: number }[]
      let verdict = ''
      if (known.length >= 4) {
        const half = Math.floor(known.length / 2)
        const before = known.slice(0, half).reduce((s, p) => s + p.qptr, 0) / half
        const after = known.slice(half).reduce((s, p) => s + p.qptr, 0) / (known.length - half)
        const change = ((after - before) / before) * 100
        verdict = `\n\nSecond half vs first: ${change >= 0 ? '+' : ''}${change.toFixed(1)}% (${pct(before)} → ${pct(after)}).`
      }

      return ok(
        `${project.gameName} — last ${range ?? '14d'}\n${body}${verdict}` +
          `\n\n${liveDays} day(s) came from Roblox directly; the rest from the stored archive.`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'get_thumbnail_momentum',
  {
    title: 'Which thumbnails are rising or falling',
    description:
      "Per-thumbnail direction over a window: whether each one's QPTR is climbing, sliding or flat, compared against its own earlier half rather than against the others. Use it to decide what to drop when a game's overall numbers are fine but something in the set is dragging. Needs stored history, so a game added recently will have nothing to compare.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      range: z.enum(['24h', '3d', '7d', '30d']).optional().describe('Window to compare across. Defaults to 7d.'),
      includeInactive: z.boolean().optional().describe('Also cover inactive variants. Defaults to false.'),
    },
  },
  async ({ game, range, includeInactive }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId, range ?? '7d')
      const rows = includeInactive ? [...report.active, ...report.inactive] : report.active
      if (rows.length === 0) return ok(`${project.gameName} has no thumbnails to compare.`)

      const { momentum } = await getMomentum(
        project.universeId,
        rows.map((t) => t.assetId),
        range ?? '7d'
      )

      const arrow = { up: 'rising', down: 'falling', flat: 'flat' } as const
      const lines = rows.map((t) => {
        const m = momentum[t.assetId]
        return (
          `asset ${t.assetId}${t.isActive ? ' (live)' : ''} — QPTR now ${pct(t.qptr)}\n` +
          `  ${m ? `${arrow[m.direction]}, ${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(1)}% across the window` : 'not enough stored history to compare'}`
        )
      })

      return ok(`${project.gameName} — last ${range ?? '7d'}\n${lines.join('\n')}`)
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'export_thumbnail_report',
  {
    title: 'Export a thumbnail PDF',
    description:
      "Render a game's thumbnails and their figures, ordered by QPTR, into a PDF written to this machine — the shareable version of get_thumbnails, for sending to a client or an artist. Images are fetched and embedded, so this takes a few seconds.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      range: z.enum(['24h', '3d', '7d', '30d']).optional().describe('Reporting window. Defaults to 7d.'),
      includeInactive: z.boolean().optional().describe('Include inactive variants. Defaults to true.'),
      outputPath: z.string().optional().describe('Where to write the PDF. Defaults to a temp file, whose path is returned.'),
    },
  },
  async ({ game, range, includeInactive, outputPath }) => {
    try {
      const project = await resolveProject(game)
      const report = await getThumbnails(project.universeId, range ?? '7d')
      const rows = (includeInactive ?? true) ? [...report.active, ...report.inactive] : report.active
      if (rows.length === 0) return ok(`${project.gameName} has no thumbnails to report on.`)

      const pdf = await buildThumbnailPdf(
        project.universeId,
        `the last ${range ?? '7d'}`,
        rows.map((t) => ({
          assetId: t.assetId,
          imageUrl: t.imageUrl,
          isActive: t.isActive,
          qptr: t.qptr ?? null,
          impressions: t.impressions ?? null,
          qualifiedPlays: t.qualifiedPlays ?? null,
        }))
      )

      const target =
        outputPath ?? join(tmpdir(), `${project.gameName.replace(/[^\w]+/g, '-').toLowerCase()}-thumbnails.pdf`)
      await writeFile(target, pdf)

      return ok(
        `Wrote ${rows.length} thumbnail(s) for ${project.gameName} to ${target} (${Math.round(pdf.byteLength / 1024)}kb).`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Projects ────────────────────────────────────────────────────────────────

server.registerTool(
  'get_game_info',
  {
    title: 'Look up a Roblox game',
    description:
      "What Roblox knows about a game — name, description, players, visits, likes, creator — from a game link, a place id or a universe id. It does not have to be a project on this account. The reply also says whether any configured Roblox account can edit its thumbnails, which is what decides whether adding it as a project would be read-only.",
    inputSchema: {
      game: z.string().describe('A roblox.com game link, a place id, or a universe id.'),
      isUniverseId: z
        .boolean()
        .optional()
        .describe('Set when the number given is a universe id rather than a place id. Links are detected on their own.'),
    },
  },
  async ({ game, isUniverseId }) => {
    try {
      const ref = isUniverseId && /^\d+$/.test(game.trim())
        ? { universeId: game.trim() }
        : parseGameRef(game)
      const info = await getGameInfo(ref)

      return ok(
        [
          `${info.name} — universeId ${info.universeId}${info.placeId ? ` · placeId ${info.placeId}` : ''}`,
          info.creator?.name ? `by ${info.creator.name}${info.creator.type ? ` (${info.creator.type})` : ''}` : null,
          `${num(info.playing)} playing · ${num(info.visits)} visits · ${num(info.likes)} likes / ${num(info.dislikes)} dislikes`,
          info.accessMode
            ? info.accessMode === 'write'
              ? `Thumbnails are editable from here${info.writableSeedIndex !== null && info.writableSeedIndex !== undefined ? ` (account ${info.writableSeedIndex})` : ''}.`
              : 'No configured account can edit this game, so it would be read-only as a project.'
            : null,
          info.description ? `\n${info.description.slice(0, 1200)}` : null,
          info.thumbnailUrl ? `\n${info.thumbnailUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'add_project',
  {
    title: 'Add a game as a project',
    description:
      "Put a Roblox game on this account so the rest of these tools can act on it. Takes a game link, place id or universe id, looks the game up, and pins it to whichever Roblox account can actually edit it — without that pin, writes default to an account with no access and fail. A game already claimed by someone else is refused rather than taken over. Follow it with check_permissions to see what still needs a credential.",
    inputSchema: {
      game: z.string().describe('A roblox.com game link, a place id, or a universe id.'),
      isUniverseId: z.boolean().optional().describe('Set when the number given is a universe id rather than a place id.'),
      channelName: z
        .string()
        .optional()
        .describe('Also make a Discord channel of this name and point the game at it, the way create_channel does.'),
    },
  },
  async ({ game, isUniverseId, channelName }) => {
    try {
      const ref = isUniverseId && /^\d+$/.test(game.trim())
        ? { universeId: game.trim() }
        : parseGameRef(game)
      const info = await getGameInfo(ref)

      await addProject({
        universeId: info.universeId,
        gameName: info.name,
        ...(typeof info.writableSeedIndex === 'number' ? { seedIndex: info.writableSeedIndex } : {}),
      })

      const lines = [
        `Added ${info.name} — universeId ${info.universeId}.`,
        info.accessMode === 'write'
          ? 'A configured Roblox account can edit its thumbnails, so uploads and swaps should work.'
          : 'No configured account can edit its thumbnails, so it is read-only until a cookie is stored with set_project_credentials.',
      ]

      if (channelName) {
        const { channel, url } = await createChannel({ name: channelName })
        await linkChannel(info.universeId, channel.id)
        lines.push(
          `${channel.created ? 'Created' : 'Reused'} #${channel.name} and pointed the game at it — tickets go there. ${url}`
        )
      }

      lines.push('Run check_permissions on it to see what is still missing.')
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'search_roblox_games',
  {
    title: 'Search Roblox',
    description:
      "Search Roblox for games by name or keyword — for finding a game to add, or for looking at what comparable experiences are using as thumbnails. Results are what Roblox shows a signed-in account, so they are tailored rather than absolute.",
    inputSchema: {
      query: z.string().describe('What to search for.'),
      limit: z.number().optional().describe('How many results to show. Defaults to 15.'),
    },
  },
  async ({ query, limit }) => {
    try {
      const { games } = await searchRobloxGames(query)
      if (games.length === 0) return ok(`Roblox returned nothing for "${query}".`)
      return ok(
        games
          .slice(0, limit ?? 15)
          .map(
            (g) =>
              `${g.name} — universeId ${g.universeId}` +
              `${g.playing !== undefined ? ` · ${num(g.playing)} playing` : ''}` +
              `${g.thumbnailUrl ? `\n  ${g.thumbnailUrl}` : ''}`
          )
          .join('\n')
      )
    } catch (err) {
      return fail(err)
    }
  }
)

// ── Tickets and sharing ─────────────────────────────────────────────────────

server.registerTool(
  'list_tickets',
  {
    title: 'Open tickets on a game',
    description:
      "Just the tickets on a game, without the plain notes get_notification_history mixes in — what was asked for, who answered, and for payment tickets whether the money has been marked paid. Use it to answer 'what is outstanding on this game'.",
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
      limit: z.number().optional().describe('How many to return. Defaults to 15.'),
      unansweredOnly: z.boolean().optional().describe('Only tickets nobody has answered yet. Defaults to false.'),
    },
  },
  async ({ game, limit, unansweredOnly }) => {
    try {
      const project = await resolveProject(game)
      const { tickets, channel } = await listTickets(project.universeId)

      const filtered = (unansweredOnly ? tickets.filter((t) => t.responses.length === 0) : tickets).slice(
        0,
        limit ?? 15
      )
      if (filtered.length === 0) {
        return ok(
          unansweredOnly
            ? `Every ticket on ${project.gameName} has been answered.`
            : `No tickets have been filed on ${project.gameName}.`
        )
      }

      const body = filtered
        .map((t) => {
          const answers = t.responses.length
            ? t.responses
                .map(
                  (r) =>
                    `    ${r.responderLabel} (${r.discordUserId}) = ${r.choice === 'approve' ? t.approveLabel : t.declineLabel}` +
                    ` at ${new Date(r.createdAt).toISOString()}`
                )
                .join('\n')
            : '    no answers yet'
          const money =
            t.paymentAmount !== null && t.paymentAmount !== undefined
              ? `\n  $${t.paymentAmount} — ${t.paid ? `PAID${t.paidByLabel ? ` by ${t.paidByLabel}` : ''}` : 'UNPAID'}`
              : ''
          return (
            `${new Date(t.createdAt).toISOString()} — [${t.ticketType}] ${t.title ?? '(untitled)'} · ticket ${t.id}\n` +
            `  ${t.message.replace(/\n/g, '\n  ')}${money}\n  answers:\n${answers}`
          )
        })
        .join('\n\n')

      return ok(
        `${project.gameName}${channel?.ticketChannelName ? ` — tickets post to #${channel.ticketChannelName}` : ''}\n\n${body}`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'list_collaborators',
  {
    title: 'Who else can reach this project',
    description:
      'The people a project has been shared with, and any invite links still open. Owner only. A shared collaborator can read and act on the project but cannot see or change its stored credentials.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const [{ shares }, { invites }] = await Promise.all([
        listShares(project.universeId),
        listInvites(project.universeId).catch(() => ({ invites: [] })),
      ])

      const lines = [`${project.gameName} — ${shares.length} collaborator(s)`]
      for (const s of shares) {
        lines.push(`  ${s.userId} — since ${new Date(s.createdAt).toISOString()}`)
      }
      if (invites.length) {
        lines.push('', `${invites.length} unused invite(s):`)
        for (const i of invites) {
          lines.push(`  ${i.token} — expires ${new Date(i.expiresAt).toISOString()}`)
        }
      }
      return ok(lines.join('\n'))
    } catch (err) {
      return fail(err)
    }
  }
)

server.registerTool(
  'invite_collaborator',
  {
    title: 'Mint an invite link',
    description:
      'Create a single-use invite token for a project, good for seven days. Whoever redeems it on the site gains access to the project — they can read its thumbnails and act on it, but never see its stored credentials. Owner only. Hand the token to one person; it is spent on first use.',
    inputSchema: {
      game: z.string().describe('Game name or universe id.'),
    },
  },
  async ({ game }) => {
    try {
      const project = await resolveProject(game)
      const { invite } = await createInvite(project.universeId)
      return ok(
        `Invite for ${project.gameName}: ${invite.token}\n` +
          `Single use, expires ${new Date(invite.expiresAt).toISOString()}.`
      )
    } catch (err) {
      return fail(err)
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
