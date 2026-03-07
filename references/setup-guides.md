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

### Step A — Batch-add required permissions

1. On the app page, go to **"Permissions & Scopes"**
2. Instead of adding permissions one by one, use **batch configuration**: click the **"Batch switch to configure by dependency"** link (or find the JSON editor)
3. Paste the following JSON to add all required permissions at once:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}
```

4. Click **"Save"** to apply all permissions

### Step B — Enable the bot

1. Go to **"Add Features"** → enable **"Bot"**
2. Set the bot name and description

### Step C — Configure Events & Callbacks (long connection)

1. Go to **"Events & Callbacks"** in the left sidebar
2. Under **"Event Dispatch Method"**, select **"Long Connection"** (长连接 / WebSocket mode)
3. Click **"Add Event"** and add these events:
   - `im.message.receive_v1` — Receive messages
   - `p2p_chat_create` — Bot added to chat (optional but recommended)
4. Click **"Save"**

### Step D — Publish the app

1. Go to **"Version Management & Release"** → click **"Create Version"**
2. Fill in version number and update description → click **"Save"**
3. Click **"Submit for Review"**
4. For personal/test use, the admin can approve it directly in the **Feishu Admin Console** → **App Review**
5. **Important:** The bot will NOT respond to messages until the version is approved and published

### Domain (optional)

Default: `https://open.feishu.cn`
Use `https://open.larksuite.com` for Lark (international version).
Leave empty to use the default Feishu domain.

### Allowed User IDs (optional)

Feishu user IDs (open_id format like `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
You can find them in the Feishu Admin Console under user profiles.
Leave empty to allow all users who can message the bot.

---

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
