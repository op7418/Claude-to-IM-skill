# Platform Setup Guides

Detailed step-by-step guides for each IM platform. Referenced by the `setup` and `reconfigure` subcommands.

---

## Telegram

### Bot Token

**How to get a Telegram Bot Token:**
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` to create a new bot
3. Follow the prompts: choose a display name and a username (must end in `bot`)
4. BotFather will reply with a token like `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
5. Copy the full token and paste it here

**Recommended bot settings** (send these commands to @BotFather):
- `/setprivacy` → choose your bot → `Disable` (so the bot can read group messages, only needed for group use)
- `/setcommands` → set commands like `new - Start new session`, `mode - Switch mode`

Token format: `数字:字母数字字符串` (e.g. `7823456789:AAF-xxx...xxx`)

### Chat ID

**How to get your Telegram Chat ID:**
1. Start a chat with your bot (search for the bot's username and click **Start**)
2. Send any message to the bot (e.g. "hello")
3. Open this URL in your browser (replace `YOUR_BOT_TOKEN` with your actual bot token):
   `https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates`
4. In the JSON response, find `"chat":{"id":123456789,...}` — that number is your Chat ID
5. For group chats, the Chat ID is a negative number (e.g. `-1001234567890`)

**Why this matters:** The bot uses Chat ID for authorization. If neither Chat ID nor Allowed User IDs are configured, the bot will reject all incoming messages.

### Allowed User IDs (optional)

**How to find your Telegram User ID:**
1. Search for `@userinfobot` on Telegram and start a chat
2. It will reply with your User ID (a number like `123456789`)
3. Alternatively, forward a message from yourself to `@userinfobot`

Enter comma-separated IDs to restrict access (recommended for security).
Leave empty to allow anyone who can message the bot.

---

## Discord

### Bot Token

**How to create a Discord Bot and get the token:**
1. Go to https://discord.com/developers/applications
2. Click **"New Application"** → give it a name → click **"Create"**
3. Go to the **"Bot"** tab on the left sidebar
4. Click **"Reset Token"** → copy the token (you can only see it once!)

**Required bot settings (on the Bot tab):**
- Under **Privileged Gateway Intents**, enable:
  - ✅ **Message Content Intent** (required to read message text)

**Invite the bot to your server:**
1. Go to the **"OAuth2"** tab → **"URL Generator"**
2. Under **Scopes**, check: `bot`
3. Under **Bot Permissions**, check: `Send Messages`, `Read Message History`, `View Channels`
4. Copy the generated URL at the bottom and open it in your browser
5. Select the server and click **"Authorize"**

Token format: a long base64-like string (e.g. `MTIzNDU2Nzg5.Gxxxxx.xxxxxxxxxxxxxxxxxxxxxxxx`)

### Allowed User IDs

**How to find Discord User IDs:**
1. In Discord, go to Settings → Advanced → enable **Developer Mode**
2. Right-click on any user → **"Copy User ID"**

Enter comma-separated IDs.

**Why this matters:** The bot uses a default-deny policy. If neither Allowed User IDs nor Allowed Channel IDs are configured, the bot will silently reject all incoming messages. You must set at least one.

### Allowed Channel IDs (optional)

**How to find Discord Channel IDs:**
1. With Developer Mode enabled, right-click on any channel → **"Copy Channel ID"**

Enter comma-separated IDs to restrict the bot to specific channels.
Leave empty to allow all channels the bot can see.

### Allowed Guild (Server) IDs (optional)

**How to find Discord Server IDs:**
1. With Developer Mode enabled, right-click on the server icon → **"Copy Server ID"**

Enter comma-separated IDs. Leave empty to allow all servers the bot is in.

---

## Feishu / Lark

### App ID and App Secret

**How to create a Feishu/Lark app and get credentials:**
1. Go to Feishu: https://open.feishu.cn/app or Lark: https://open.larksuite.com/app
2. Click **"Create Custom App"**
3. Fill in the app name and description → click **"Create"**
4. On the app's **"Credentials & Basic Info"** page, find:
   - **App ID** (like `cli_xxxxxxxxxx`)
   - **App Secret** (click to reveal, like `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### Phase 1: Permissions + Bot capability

> Complete Phase 1 and publish before moving to Phase 2. Feishu requires a published version for permissions to take effect, and the bridge service needs active permissions to establish its WebSocket connection.

**Step A — Batch-add required permissions**

1. On the app page, go to **"Permissions & Scopes"**
2. Use **batch configuration** (click **"Batch switch to configure by dependency"** or find the JSON editor)
3. Paste the following JSON (required for streaming cards and interactive buttons):

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:update",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:chat:read",
      "im:resource",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": []
  }
}
```

4. Click **"Save"** to apply all permissions

If the batch import UI is not available, add each scope manually via the search box.

**Step B — Enable the bot**

1. Go to **"Add Features"** → enable **"Bot"**
2. Set the bot name and description

**Step C — First publish (makes permissions + bot effective)**

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version `1.0.0` and a description → click **"Save"** → **"Submit for Review"**
3. Admin approves in **Feishu Admin Console** → **App Review** (self-approve if you are the admin)

**The bot will NOT work until this version is approved.**

### Phase 2: Event subscription (requires running bridge)

> The bridge service must be running before configuring events. Feishu validates the WebSocket connection when saving event subscription — if the bridge is not running, you'll get "未检测到应用连接信息" (connection not detected) error.

**Step D — Start the bridge service**

Run `/claude-to-im start` in Claude Code. This establishes the WebSocket long connection that Feishu needs to detect.

**Step E — Configure Events & Callbacks (long connection)**

1. Go to **"Events & Callbacks"** in the left sidebar
2. Under **"Event Dispatch Method"**, select **"Long Connection"** (长连接 / WebSocket mode)
3. Click **"Add Event"** and add:
   - `im.message.receive_v1` — Receive messages
4. Click **"Add Callback"** and add:
   - `card.action.trigger` — Card interaction callback (for permission approval buttons)
5. Click **"Save"**

**Step F — Second publish (makes event subscription effective)**

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version `1.1.0` → **"Save"** → **"Submit for Review"** → Admin approves
3. After approval, the bot can receive and respond to messages

> **Ongoing rule:** Any change to permissions, events, or capabilities requires a new version publish + admin approval.

### Upgrading from a previous version

If you already have a Feishu app configured, you need to:

1. **Add new permissions**: Go to Permissions & Scopes, add these scopes:
   - `cardkit:card:write`, `cardkit:card:read` — Streaming cards
   - `im:message:update` — Real-time card content updates
   - `im:message.reactions:read`, `im:message.reactions:write_only` — Typing indicator
2. **Publish a new version** — Permission changes only take effect after a new version is approved
3. **Start (or restart) the bridge** — Run `/claude-to-im start` so the WebSocket connection is active
4. **Add callback**: Go to Events & Callbacks, add `card.action.trigger` callback (card interaction for permission buttons). This step requires the bridge to be running — Feishu validates the WebSocket connection when saving.
5. **Publish again** — The new callback requires another version publish + admin approval
6. **Restart the bridge** — Run `/claude-to-im stop` then `/claude-to-im start` to pick up the new capabilities

### Domain (optional)

Default: `https://open.feishu.cn`
Use `https://open.larksuite.com` for Lark (international version).
Leave empty to use the default Feishu domain.

### Allowed User IDs (optional)

Feishu user IDs (open_id format like `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
You can find them in the Feishu Admin Console under user profiles.
Leave empty to allow all users who can message the bot.

---

## QQ

> **Note:** QQ first version only supports **C2C private chat** (sandbox access). Group chat and channel are not supported yet.

### App ID and App Secret (required)

**How to get QQ Bot credentials:**
1. Go to https://q.qq.com/qqbot/openclaw
2. Log in and enter the QQ Bot / OpenClaw management page
3. Create a new QQ Bot or select an existing one
4. Find **App ID** and **App Secret** on the bot's credential page
5. Copy both values

These are the only two required fields for QQ.

### Sandbox private chat setup

1. In the QQ Bot management page, configure sandbox access
2. Scan the QR code with QQ to add the bot as a friend
3. Send a message to the bot via QQ private chat to start using it

### Allowed User OpenIDs (optional)

**Important:** The value is `user_openid`, NOT QQ number.

`user_openid` is an opaque identifier assigned by the QQ Bot platform to each user. You can obtain it from the bot's message logs after a user sends a message to the bot.

If you don't have the openid yet, leave this field empty. You can add it later via `reconfigure`.

Enter comma-separated openids to restrict access. Leave empty to allow all users who can message the bot.

### Image Enabled (optional)

Default: `true`. Set to `false` if the underlying LLM provider does not support image input.

When enabled, images sent by users in QQ private chat will be forwarded to the AI agent. Image output (sending images back to QQ) is not supported in this version — only text replies.

### Max Image Size MB (optional)

Default: `20`. Maximum image file size in MB that will be forwarded to the AI agent. Images larger than this limit are ignored.

---

## WeChat

> **Note for setup wizard:** AskUserQuestion only supports up to 4 checkbox options.
> Since there are now 5 channels (telegram, discord, feishu, qq, wechat), you cannot
> list them all as checkboxes. Instead, use a **text input** question for channel
> selection (e.g. "Which channels do you want to enable? Enter comma-separated names:
> telegram, discord, feishu, qq, wechat") so that all 5 channels are visible and selectable.

WeChat integration uses the official ClawBot ilink API to bridge messages from your personal WeChat account to Claude.

### Prerequisites

- iOS WeChat (latest version with ClawBot plugin enabled)
- Node.js >= 20 (for the QR login script)
- `qrcode-terminal` npm package (for terminal QR display)

### Environment check (run before QR login)

Before asking the user to scan, verify the environment is ready. Run these checks via Bash:

1. **Node.js**: `node --version` — must be >= 20. If missing or too old:
   - macOS: `brew install node`
   - Or: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts`
   - Tell the user which command to run and wait for them to install.

2. **qrcode-terminal**: `node -e "require('qrcode-terminal')" 2>&1` — if it fails:
   - Run: `cd "SKILL_DIR" && npm install qrcode-terminal` (replace SKILL_DIR with actual path)
   - This is a lightweight package, safe to install automatically via Bash without asking.

3. **Script exists**: `test -f "SKILL_DIR/scripts/wechat-login.mjs"` — if missing, the skill installation may be incomplete. Tell the user to reinstall the skill.

Only proceed to QR login after all checks pass.

### How to get the token

The WeChat token is obtained via QR code scan — it is NOT something you can find in a dashboard.

**Important:** The QR login script must be run by the user in a **separate terminal window** (not via the Bash tool and not with `!` prefix — those won't show the QR code interactively). After environment checks pass, tell the user:

> Please open a new terminal window and run:
> ```
> node "<SKILL_DIR>/scripts/wechat-login.mjs"
> ```
> (replace `<SKILL_DIR>` with the actual path shown above)
>
> A QR code will appear. Scan it with WeChat on your iPhone.
> After login succeeds, copy the last line of JSON output and paste it back here.

The script will:
1. Display a QR code in the terminal
2. Wait for the user to scan with WeChat on iOS
3. On success, print a single JSON line to stdout: `{"token":"...","baseUrl":"...","accountId":"...","userId":"..."}`

After the user pastes the JSON, parse it to extract the `token` field.

The token looks like: `<account_id>@im.bot:<hex_string>`

### Base URL (optional)

Default: `https://ilinkai.weixin.qq.com`. Only change this if Tencent provides a different endpoint.

### Allowed User IDs (optional)

WeChat user IDs look like `<openid>@im.wechat`. You can find your user ID in the bridge logs after sending your first message. Leave empty to allow all users.

### Limitations

- WeChat ClawBot only supports iOS WeChat (latest version)
- Each ClawBot can only connect one agent instance
- No inline permission buttons — uses numeric text shortcuts (1/2/3)
- No streaming preview
- Text messages only (no images)
