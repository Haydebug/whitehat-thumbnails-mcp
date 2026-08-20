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
| `get_notification_history` | What was already sent, with timestamps and answers |
| `upload_thumbnail` | Publish a local image as a game thumbnail |

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
