# AttendEase — Facebook Messenger MCP Server

Sends attendance notifications to guardians via Facebook Messenger using the official Meta Graph API and the Model Context Protocol (MCP).

---

## How It Works

```
Guardian messages your Facebook Page
     ↓  (webhook captures their PSID)
psid-store.json stores studentId → PSID
     ↓
Claude (or any MCP client) calls notify_guardian
     ↓
Meta Graph API sends message to guardian's Messenger
```

---

## Prerequisites

1. **A Facebook Page** for your school (free to create at facebook.com/pages/create)
2. **A Meta Developer App** (free at developers.facebook.com)
3. **ngrok** or a public HTTPS URL for the webhook (during setup)
4. **Node.js ≥ 18** (you have v24 ✅)

---

## Step-by-Step Setup

### Step 1 — Install dependencies
```
cd messenger-mcp
npm install
```

### Step 2 — Create your .env file
```
copy .env.example .env
```
Then fill in the values (see Step 3 & 4).

### Step 3 — Create a Meta App & get your Page Access Token

1. Go to https://developers.facebook.com → **My Apps** → **Create App**
2. Choose **Business** → give it a name (e.g. "AttendEase Notifications")
3. Add **Messenger** product to your app
4. Under **Messenger → Settings**:
   - Connect your school's Facebook Page
   - Generate a **Page Access Token** (copy it → paste into `.env` as `FB_PAGE_ACCESS_TOKEN`)
   - Copy your **Page ID** → paste into `.env` as `FB_PAGE_ID`

### Step 4 — Set up the Webhook

**Option A: ngrok (for local development)**
```
npx ngrok http 3000
```
Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`)

**Option B: Deploy to a server** (for production)
Use any Node.js host: Railway, Render, Heroku, VPS, etc.

Then in the Meta App dashboard:
- Go to **Messenger → Webhooks** → **Add Callback URL**
- **Callback URL**: `https://your-url.ngrok.io/webhook`
- **Verify Token**: must match `FB_VERIFY_TOKEN` in your `.env`
- **Subscriptions**: check `messages`
- Click **Verify and Save**

### Step 5 — Have guardians register

Guardians must message your school's Facebook Page with:
```
REGISTER 2024-00001
```
(Replace with the actual student ID)

The webhook captures their PSID automatically. You can also manually register a PSID using the `register_guardian` MCP tool.

### Step 6 — Add to Claude Desktop (MCP configuration)

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "attendease-messenger": {
      "command": "node",
      "args": ["C:/Users/jcalv/Downloads/AttendEase/messenger-mcp/src/index.js"],
      "env": {
        "FB_PAGE_ACCESS_TOKEN": "your_token_here",
        "FB_PAGE_ID": "your_page_id_here",
        "FB_VERIFY_TOKEN": "attendease_verify_token_change_me",
        "SCHOOL_NAME": "Your School",
        "TEACHER_NAME": "Ms. Santos"
      }
    }
  }
}
```

Restart Claude Desktop. The messenger tools will appear automatically.

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `notify_guardian` | Send attendance alert to one student's guardian |
| `notify_all_absent` | Bulk-notify all absent (and optionally late) guardians |
| `register_guardian` | Manually register a guardian PSID for a student |
| `list_registered` | See all registered guardians |
| `remove_guardian` | Unlink a guardian from a student |
| `check_guardian_status` | Check if a student's guardian is registered |
| `send_custom_message` | Send any free-form message to a guardian |

---

## Important Limitations (Meta API Rules)

| Limitation | What it means |
|---|---|
| **No cold-messaging** | You cannot message a Facebook user who has never interacted with your Page |
| **24-hour window** | After a guardian messages your Page, you can reply freely for 24 hours |
| **After 24h** | Must use a **Message Tag** — this server uses `CONFIRMED_EVENT_UPDATE` for attendance |
| **PSID required** | You need the guardian's Page-Scoped ID (from the webhook), not their profile URL |
| **App review** | For large-scale/production use, Meta may require app review for `pages_messaging` |

---

## Local Dev Workflow

```bash
# Terminal 1 — start the MCP + webhook server
cd messenger-mcp
npm start

# Terminal 2 — expose webhook to internet
npx ngrok http 3000
```

---

## File Structure

```
messenger-mcp/
├── src/
│   ├── index.js       ← MCP server + all tools (entry point)
│   ├── messenger.js   ← Meta Graph API client
│   ├── webhook.js     ← Express webhook server (PSID capture)
│   └── psid-store.js  ← JSON file store (studentId → PSID)
├── data/
│   └── psid-store.json ← Auto-created; maps students to guardian PSIDs
├── .env               ← Your secrets (never commit this!)
├── .env.example       ← Template
├── package.json
└── README.md
```
