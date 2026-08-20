# White Hat Thumbnails — MCP server

Lets an AI assistant run your Roblox thumbnails end to end from a chat window:
read how they are performing, generate new ones, publish them, choose which are
live, rotate them automatically, and talk to your Discord team about it.

```
"how are the thumbnails doing on +1 dumpling escape?"
"what am I actually allowed to do on magnet simulator?"
"generate three variants from this reference and put the best one live"
"drop the worst performer and promote the next one from the queue"
"go notify the thumbnail team on +1 dumpling escape walls to pay this link,
 with two options approve and disapprove"
```

Everything runs against your own account. A key only reaches the projects you
already have access to on the site, and it can never read back a stored
credential — only tell you whether one is there and whether it works.

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

**Knowing what you can do**

| Tool | What it does |
|---|---|
| `check_permissions` | Probes one game and reports exactly which tools will work on it, and why the rest will not |
| `set_project_credentials` | Store an Open Cloud key and/or a Roblox cookie on a game — the two things the report asks for |

**Projects**

| Tool | What it does |
|---|---|
| `list_projects` | Your games and their universe ids |
| `get_game_info` | Look up any Roblox game by link, place id or universe id — it need not be yours |
| `search_roblox_games` | Search Roblox by name or keyword |
| `add_project` | Put a game on your account, pinned to whichever Roblox account can edit it |
| `list_collaborators` / `invite_collaborator` | Who else reaches a project, and a single-use invite link |

**Thumbnails**

| Tool | What it does |
|---|---|
| `get_thumbnails` | Live and inactive thumbnails with QPTR, impressions, qualified plays, average playtime |
| `set_active_thumbnails` | Choose which thumbnails Roblox actually shows — replace, add or remove |
| `upload_thumbnail` | Publish a local image as a game thumbnail |
| `delete_thumbnail` | Permanently remove a thumbnail from the game |
| `get_qptr_trend` | Daily click-through and impressions over 7, 14 or 30 days |
| `get_thumbnail_momentum` | Which individual thumbnails are rising, falling or flat |
| `export_thumbnail_report` | The whole set, ordered by QPTR, as a PDF written to disk |

**Making thumbnails**

| Tool | What it does |
|---|---|
| `generate_thumbnail` | Generate an image from a prompt and references, write it to disk, optionally publish it |
| `list_generations` | Everything generated for a game, with the prompts behind each one |
| `upload_generation` | Publish something from that history without re-uploading it |
| `list_style_profiles` | The named style guides generation can be pointed at |

**Rotating them**

| Tool | What it does |
|---|---|
| `get_auto_swap` | Whether a game rotates itself, on what rules, and what recent runs did |
| `configure_auto_swap` | Turn rotation on or off and set its thresholds |
| `run_auto_swap` | Fire one rotation now, without waiting for the schedule |
| `get_queue` | What is lined up to go live next |
| `queue_thumbnail` / `unqueue_thumbnail` | Add to or remove from that line |

**Discord**

| Tool | What it does |
|---|---|
| `list_discord_roles` | Roles that can be notified |
| `notify_team` | DM a role, optionally with images and two answer buttons |
| `get_notification_history` | What was already sent, with per-person answers and paid status |
| `create_ticket` | Open a ticket — posts an embed with Approve/Deny in the game's channel |
| `list_tickets` | Just the tickets on a game, with what is still unanswered or unpaid |
| `list_artist_channels` | Text channels in the studio server, with ids |
| `create_channel` / `link_channel` | Make a channel, and point a game's tickets at one |
| `get_channel_messages` | Read a channel — author, time, text, attachment URLs |
| `send_channel_message` | Post in a channel as the bot, as plain text or an embed, optionally with images |

Game names are matched loosely, so "dumpling escape" finds
"+1 Dumpling SMASH Walls". If a name is ambiguous the tool says so and lists the
candidates rather than guessing.

### Knowing what you are allowed to do

Authority over a Roblox game is not one permission. It is spread across a
`.ROBLOSECURITY` cookie (uploads, deletes, swapping the live set), an Open Cloud
key (analytics), a personalization config Roblox only creates once a game has
several thumbnails (whether there is a swappable live set at all), and a Discord
bot (tickets and notifications). Any of them can be missing on its own, and the
failure you see is the same shrug either way.

`check_permissions` probes all of them at once and answers in two lists:

```
MAGNET SIMULATOR LEGENDS — universeId 7592711723
You own this project.
Open Cloud key: stored (••••YkpR), encrypted at rest
Roblox account: WH_AIbot (the shared default account)

WORKS (6)
  get_thumbnails
      2 active, 124 inactive
  analytics (QPTR, impressions, playtime)
      figures came back for 16 of 126 thumbnails via the Open Cloud key ••••YkpR
  set_active_thumbnails
      a personalization config was resolved, so the live set can be changed
  …

DOES NOT WORK (2)
  upload_thumbnail, delete_thumbnail
      WH_AIbot (the shared default account) is signed in but Roblox refuses it
      edit access to this game
      Fix: give that account permission on the experience, or store a cookie for
      one that already has it with set_project_credentials.
  ticket posting to a channel
      this game is not linked to a Discord channel, so tickets only go out as DMs
      Fix: call create_channel with this game, or link_channel with an id.
```

Every "no" carries the reason and the fix, because "no" on its own sends you
round the same loop again. Run it before a write you care about, or after one
fails and it is not obvious which credential was missing.

The two credentials it asks for go in with `set_project_credentials`. They are
stored encrypted and never read back — the report can say a key is present and
whether it works, and nothing more.

### Choosing what is live

Uploading a thumbnail does not show it to anyone. Roblox keeps every image a
game has ever had and serves a chosen subset; `set_active_thumbnails` is what
changes that subset, and it takes effect immediately.

```
set_active_thumbnails(game: "magnet simulator", ids: ["108286870859415"], mode: "add")
set_active_thumbnails(game: "magnet simulator", ids: ["112922133257215"], mode: "remove")
```

`add` and `remove` adjust what is already live and are what you usually want.
`replace` makes exactly the listed set live and everything else inactive — easy
to fire by accident when you meant `add`. Ids can be the asset ids the reports
lead with or the internal thumbnail ids; both are accepted.

Nothing here deletes anything. A deactivated thumbnail keeps its history and can
be brought back. `delete_thumbnail` is the one that cannot be undone, and it
refuses to remove a game's last live image.

### Generating

`generate_thumbnail` runs the same pipeline the site's generator page does: your
prompt is rewritten against a style guide, then rendered against one or more
reference images. The result is written to a file on your machine so it can
actually be looked at before it goes anywhere near a game.

```
generate_thumbnail(
  game: "magnet simulator",
  prompt: "character yanking a giant magnet out of a pile of loot",
  referencePaths: ["ref.png"],
  profile: "Simulator"
)
```

References can be local paths or public URLs; at least one is required, since the
model works from an image rather than from nothing. `profile` picks one of the
style guides `list_style_profiles` lists. Pass `publish: true` only when the
image has already been agreed on — otherwise generate, look at the file, then
`upload_thumbnail`.

### Rotating automatically

Auto-swap drops the worst-performing live thumbnails by QPTR and promotes
replacements from a queue, on a schedule.

```
queue_thumbnail(game: "magnet simulator", id: "108286870859415")
configure_auto_swap(game: "magnet simulator", enabled: true, dropCount: 1,
                    frequencyMinutes: 1440, qptrThreshold: 2)
run_auto_swap(game: "magnet simulator")
```

`qptrThreshold` is a percentage, not a fraction: `2` means 2%. A game with an
empty queue will run and do nothing, so check `get_queue` before turning it on.
`get_auto_swap` shows the rules, the schedule and what recent runs actually
moved — and if rotation turned itself off, the reason it gives is the thing to
fix.
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
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=117760
```

Both scopes matter. `bot` gets it into the server; `applications.commands` is what
makes `/ticket` visible there. A bot invited without the second one works fine for
DMs and channel posts while its slash commands silently never appear.

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
something is unavailable rather than failing silently. `check_permissions` is the
quickest way to find out which case a game is in.

**Three tools change what players actually see**, and do so the moment they
return: `set_active_thumbnails`, `run_auto_swap`, and `configure_auto_swap` with
`enabled: true`. Uploading and generating do not — an uploaded thumbnail sits
inactive until something puts it live.

**One tool cannot be undone.** `delete_thumbnail` removes the image from Roblox
along with its analytics history. Deactivating with
`set_active_thumbnails(mode: "remove")` is the reversible version and is almost
always what was meant.

**`check_permissions` does not probe generation.** The only honest check would be
generating an image, which costs money and leaves a record behind. If
`generate_thumbnail` is going to fail it fails on the first call, with the reason.

## Licence

MIT
