# White Hat Thumbnails — MCP server

Lets an AI assistant read how your Roblox thumbnails are performing, upload new
ones, and notify your Discord team — from a chat window.

```
"how are the thumbnails doing on +1 dumpling escape?"
"go notify the thumbnail team on +1 dumpling escape walls to pay this link,
 with two options approve and disapprove"
"upload this thumbnail and tell the whole team with an approve or deny button"
```

Everything runs against your own account. A key only reaches the projects you
already have access to on the site.

---

## Setup

**1. Get a key**

Sign in at <https://whitehatthumbnails.vercel.app>, open **Keys**, and create
one. It is shown once — copy it then.

**2. Install**

```bash
git clone https://github.com/Haydebug/whitehat-thumbnails-mcp.git
cd whitehat-thumbnails-mcp
npm install
npm run build
```

**3. Point your assistant at it**

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add whitehat-thumbnails \
  --env WHT_API_KEY=wht_your_key_here \
  -- node /absolute/path/to/whitehat-thumbnails-mcp/dist/index.js
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whitehat-thumbnails": {
      "command": "node",
      "args": ["/absolute/path/to/whitehat-thumbnails-mcp/dist/index.js"],
      "env": { "WHT_API_KEY": "wht_your_key_here" }
    }
  }
}
```

The config file lives at:
- macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop afterwards.
</details>

Use an **absolute** path — the assistant does not run from this folder.

---

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Your games and their universe ids |
| `get_thumbnails` | Live and inactive thumbnails with QPTR, impressions, qualified plays, average playtime |
| `list_discord_roles` | Roles that can be notified |
| `notify_team` | DM a role, optionally with images and two answer buttons |
| `get_notification_history` | What was already sent, with per-person answers and paid status |
| `upload_thumbnail` | Publish a local image as a game thumbnail |
| `create_ticket` | Open a ticket — posts an embed with Approve/Deny in the game's channel |
| `list_artist_channels` | Text channels in the studio server, with ids |
| `get_channel_messages` | Read a channel — author, time, text, attachment URLs |
| `send_channel_message` | Post in a channel as the bot, as plain text or an embed, optionally with images |

Game names are matched loosely, so "dumpling escape" finds
"+1 Dumpling SMASH Walls". If a name is ambiguous the tool says so and lists the
candidates rather than guessing.

### Answer buttons

`notify_team` can attach two buttons and let people answer:

```
notify_team(
  game: "+1 dumpling escape",
  role: "Thumbnail Team",
  message: "Pay here please: https://…",
  askForAnswer: true,
  approveLabel: "Paid",
  declineLabel: "Cancel"
)
```

Whoever clicks has their decision DM'd to everyone with that role, including
themselves. Each person can answer once.

`get_notification_history` reports each answer on its own line with the person's
Discord id and the moment they clicked, so an automation can gate on a specific
pair of people having both approved rather than on a count:

```
2026-08-20T03:42:31.704Z — Hayden S → "Thumbnail Team" (2/2 delivered) · ticket clx…
  Dumpling concept art from lamy
  payment: $10 · https://paypal.me/asianlamy · PAID by Bug at 2026-08-20T03:45:02.118Z
  answers:
    Bug (4207…) = Paid at 2026-08-20T03:45:02.118Z
    ang (9931…) = Deny at 2026-08-20T03:46:44.500Z
```

### Paying for commissioned work

Pass `paymentAmount` and the ticket becomes an invoice — the DM shows the amount
and a pay button, the buttons default to **Paid** / **Cancel**, and the first
click on Paid marks the ticket paid:

```
notify_team(
  game: "+1 dumpling escape",
  role: "Thumbnail Team",
  message: "Dumpling concept art from lamy",
  paymentAmount: 10,
  paypalLink: "paypal.me/asianlamy"
)
```

`paid` latches. A decline after someone has already marked it paid is recorded as
an answer but does not un-pay the ticket — money that went out cannot be recalled
by a button.

### Tickets

A ticket is the same record as a team notification — same table, same per-person
answers, same paid flag — with a title, a type and a channel to live in. It can
be opened three ways and they are indistinguishable afterwards:

- `/ticket create` in Discord, from any channel or a DM with the bot
- `create_ticket` here, for automations
- the notification tooling on the site

```
create_ticket(
  game: "+1 dumpling escape",
  type: "concept_review",
  title: "Dumpling wall smash — first pass",
  description: "Three angles from lamy. Picking one for the A/B.",
  imagePaths: ["pass1.png", "pass2.png"]
)
```

Types are `concept_review`, `final_review`, `payment` and `status`. Everything
but `status` gets Approve / Deny buttons; a payment ticket gets Paid / Cancel
plus the amount and a tappable PayPal link, and the first Paid click sets the
paid flag. Answers land in `get_notification_history` exactly as button answers
on a DM do, and the embed in the channel is rewritten as people answer so the
message everyone is looking at shows the current state.

Each game posts its tickets to one channel, set once from Discord:

```
/ticket config game:<game> channel:#lammyta
```

Without that, a ticket is still created and still readable — it just has nowhere
to appear, and the tool says so rather than pretending it was delivered.

### Talking to artists

Each artist has their own text channel in the studio server. The three channel
tools are a poll loop, not a live feed: read with `since` set to the
`lastMessageId` you were given last time, and you see only what arrived since.

```
list_artist_channels()                              → #lammyta — id 1539…
get_channel_messages(channelId: "1539…", since: "…") → replies + art
send_channel_message(channelId: "1539…", text: "…", imagePaths: ["brief.png"])
```

Attachment URLs from Discord are signed and expire in roughly a day, so download
art when you first see it rather than storing the link for later.

### Embeds

A channel post can be an embed rather than a line of text — the card with a
coloured bar down the side, the same one the notification DMs use. Pass `embed`
instead of, or alongside, `text`:

```
send_channel_message(
  channelId: "1539…",
  embed: {
    author: "White Hat Thumbnails · MCP",
    title: "+1 Dumpling SMASH Walls",
    url: "https://whitehatthumbnails.vercel.app/projects/10307670587",
    color: "#facc15",
    description: "Five thumbnails live. **0.41% QPTR** on 1.95M impressions.",
    fields: [
      { name: "Top QPTR", value: "0.41%", inline: true },
      { name: "Impressions", value: "1,947,283", inline: true }
    ],
    thumbnailUrl: "https://tr.rbxcdn.com/…",
    imageUrl: "https://tr.rbxcdn.com/…",
    footer: "Sent by the MCP",
    buttons: [{ label: "View project", url: "https://whitehatthumbnails.vercel.app/…" }]
  }
)
```

The shape is flat on purpose — Discord nests the footer, the image and every
button inside wrappers, and none of that is worth knowing to send a message.
Fields are cut to the lengths Discord enforces rather than sent long, because it
rejects the whole message over one oversized field.

Buttons here only open links. A button that asks a question and records the
answer belongs to `notify_team` or `create_ticket`, which have somewhere to write
the answer down.

For the bot to see a channel it needs **View Channel**, **Read Message History**,
**Send Messages** and **Attach Files** there. Invite it with:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=117760
```

---

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `WHT_API_KEY` | yes | Your key from the Keys page |
| `WHT_BASE_URL` | no | Only if you run your own copy of the site |

---

## Notes

**Discord DMs can be refused, and that is not a bug.** Discord will not let a bot
message someone who has blocked it, or who has DMs from server members turned
off, or who shares no server with the bot. `notify_team` reports per person which
of those happened rather than a single success count.

**Roblox moderates uploads asynchronously.** `upload_thumbnail` returning
`Pending` means it was accepted and is being reviewed — usually a few minutes.

**Some games are read-only.** Uploading and swapping need a Roblox account with
edit access to that experience; an Open Cloud key cannot do either. The site
shows each project as Full Edit, View Only or Public View, and the tools say when
something is unavailable rather than failing silently.

## Licence

MIT
