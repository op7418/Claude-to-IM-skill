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

---

## Weixin / 微信

> Risk note: this integration follows the same OpenClaw-style WeChat plugin protocol used by CodePilot. Because it connects a non-OpenClaw product to WeChat, there may be account risk. Use with caution.

### QR login flow

Weixin does **not** use a static bot token in `config.env`.

Instead, run the local QR helper from the installed skill directory:

- Claude Code default install:

```bash
cd ~/.claude/skills/claude-to-im
npm run weixin:login
```

- Codex default install:

```bash
cd ~/.codex/skills/Claude-to-IM-skill
npm run weixin:login
```

If you are running from a checked-out repo instead of an installed skill, use that repo's `Claude-to-IM-skill` directory.

What happens next:

1. The helper requests a fresh WeChat QR code
2. It writes a local HTML file to:
   `~/.claude-to-im/runtime/weixin-login.html`
3. It tries to open that HTML file in your default browser automatically
4. You scan the QR code with the WeChat app and confirm on your phone
5. On success, the helper stores the linked account in:
   `~/.claude-to-im/data/weixin-accounts.json`

The filename stays plural for backward compatibility, but Weixin currently runs in single-account mode.

If the browser does not open automatically, open the HTML file manually.

### Replacing the linked Weixin account

Run the helper again:

```bash
cd <skill-dir>
npm run weixin:login
```

Each successful scan replaces the previously linked Weixin account. Only the most recent account is kept locally and used by the bridge.

### Optional config

Most users should leave these unset:

- `CTI_WEIXIN_BASE_URL`
- `CTI_WEIXIN_CDN_BASE_URL`
- `CTI_WEIXIN_MEDIA_ENABLED`

Defaults:

- Base URL: `https://ilinkai.weixin.qq.com`
- CDN Base URL: `https://novac2c.cdn.weixin.qq.com/c2c`
- Media: disabled by default in CLI setups; when enabled, inbound images/files/videos are downloaded and forwarded as attachments

### Voice message behavior

Weixin voice messages are handled differently from image/file/video media:

- If WeChat includes built-in speech-to-text text in `voice_item.text`, the bridge forwards that text as the user message.
- If WeChat does **not** include a transcript, the bridge returns a user-visible error asking the sender to enable WeChat voice transcription and resend.
- The bridge does **not** download, decrypt, or transcribe raw voice audio on its own.

This rule applies in both Claude Code and Codex runtimes.



## DingTalk (钉钉)

### Client ID (AppKey) and Client Secret (AppSecret)

**How to create a DingTalk app and get credentials:**
1. Go to DingTalk Open Platform: https://open-dev.dingtalk.com/
2. Click **"Application Development"** → **"Enterprise Internal Development"** → **"Create Application"**
3. Fill in the app name and description → click **"Create"**
4. On the app's **"Credentials & Basic Info"** page, find:
   - **AppKey** (also called Client ID, like `dingxxxxxxxxxx`)
   - **AppSecret** (also called Client Secret, click to reveal)

### Step A — Enable the bot capability

1. In the app page, go to **"Add Capability"** → enable **"Robot"** (机器人)
2. Set the robot name, avatar and description
3. Under robot settings, configure the **message receiving mode** to **"Stream Mode"** (Stream 模式)

### Step B — Configure Stream Mode

1. In the robot settings, make sure **"Stream Mode"** is selected (not HTTP mode)
2. Stream mode uses WebSocket long connection — no public server URL needed
3. The robot will automatically connect when the bridge starts

### Step C — Publish the app

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version number and update description → click **"Save"**
3. Click **"Publish"**
4. For enterprise internal apps, the admin can approve it in the **DingTalk Admin Console** → **App Management**
5. **Important:** The bot will NOT respond to messages until the app is published and approved

### Robot Code (optional)

The Robot Code is used for sending proactive messages via OpenAPI. It defaults to the same value as Client ID (AppKey).
You can find it on the robot configuration page in the DingTalk Open Platform.
Leave empty to use Client ID as robot code.

### Allowed User IDs (optional)

DingTalk user IDs are **staffId** format (e.g. `manager1234`).
You can find them in the DingTalk Admin Console under employee profiles, or via the DingTalk contact API.
Enter comma-separated IDs to restrict access. Leave empty to allow all users.

### Allowed Group IDs (optional)

DingTalk group IDs are **conversationId** format (e.g. `cidXXXXXXXXXX`).
You can find the conversationId in the webhook callback data when the bot receives a group message.
Enter comma-separated IDs to restrict the bot to specific groups. Leave empty to allow all groups.