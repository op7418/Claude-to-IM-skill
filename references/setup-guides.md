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

## 飞书 / Lark

> **重要提示：飞书机器人的配置比 Telegram 复杂很多。请严格按顺序操作，不要跳步。**
> 整个流程大约需要 10-15 分钟。需要企业飞书管理员配合审核（如果你自己就是管理员，会自动通过）。
>
> **核心流程：** 创建应用 → 配权限/机器人 → **第一次发布**（让权限生效）→ 启动桥接服务 → 配事件订阅 → **第二次发布**（让事件生效）。必须发布两次，因为事件订阅依赖桥接服务的长连接，而长连接需要权限先生效。

---

### 第一步：创建企业自建应用

1. 打开浏览器，访问飞书开放平台：

```
https://open.feishu.cn/app
```

> 如果你用的是 Lark（国际版），请访问 `https://open.larksuite.com/app`

2. 如果还没登录，先用你的飞书账号登录
3. 登录后，你会看到"我的应用"页面
4. 点击页面左上角的 **「创建企业自建应用」** 按钮（蓝色按钮）
5. 在弹出的窗口中填写：
   - **应用名称**：起一个能辨识的名字，比如 `XXX的AI机器人`（企业账号大家都能看到，同名会很乱）
   - **应用描述**：随便写，比如 `AI 聊天机器人`
   - **应用图标**：可以不上传，用默认的就行
6. 点击 **「创建」**

创建完成后，你会自动进入这个应用的管理页面。

---

### 第二步：复制 App ID 和 App Secret

1. 在应用管理页面，看左侧导航栏，点击 **「凭证与基础信息」**
2. 你会看到两个重要信息：
   - **App ID**：格式像 `cli_a5xxxxxxxxxxxx`，直接可见
   - **App Secret**：默认隐藏，点击旁边的 **「显示」** 或 **眼睛图标** 查看
3. **把这两个值都复制下来**

> App ID 格式示例：`cli_a5xxxxxxxxxxxx`
> App Secret 格式示例：32位字母数字混合字符串

---

### 第三步：开启机器人能力

1. 在左侧导航栏，找到并点击 **「添加应用能力」**
2. 在页面中找到 **「机器人」** 卡片
   - 如果没看到，试试切换到 **「按能力添加」** 标签页
3. 点击机器人卡片上的 **「添加」** 按钮，点完就好了

> 开启机器人后，飞书用户才能直接和这个 bot 私聊。

---

### 第四步：批量添加权限（一次性导入，不要一个一个加）

**这一步非常关键。权限不全的话，机器人会各种报错。**

1. 在左侧导航栏，点击 **「权限管理」**
2. 你会看到一个权限列表页面
3. 找到页面上方的 **「批量开通」** 按钮（有的版本叫「按依赖关系批量配置」或有个导入图标）
4. 点击后会弹出一个 JSON 编辑器
5. **删掉编辑器里的内容**，然后把下面这段 JSON **完整复制粘贴进去**：

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

6. 点击 **「下一步」**，确认新增权限是 **16 条**，然后点击 **「申请开通」**
7. 会弹出一个「应用身份权限可访问的数据范围」的弹窗（关于通讯录权限范围），直接点击 **「确认」**

**如果找不到「批量开通」按钮：** 飞书开放平台界面经常更新，按钮位置可能会变。如果实在找不到，可以手动一个一个添加权限：

1. 在「权限管理」页面，点击 **「添加权限」** 或 **「开通权限」**
2. 在搜索框中搜索以下权限名称，逐个添加：
   - 搜 `aily:file` → 勾选 read 和 write → 添加
   - 搜 `application:application` → 勾选 app_message_stats 和 self_manage → 添加
   - 搜 `application:bot.menu` → 勾选 → 添加
   - 搜 `contact:user.employee_id` → 勾选 → 添加
   - 搜 `corehr:file` → 勾选 → 添加
   - 搜 `event:ip_list` → 勾选 → 添加
   - 搜 `im:chat.access_event` → 勾选 → 添加
   - 搜 `im:chat.members` → 勾选 → 添加
   - 搜 `im:message` → 勾选所有相关的（5个） → 添加
   - 搜 `im:resource` → 勾选 → 添加
3. 全部添加完后，确认权限列表里有 **16 条** tenant 权限 + **3 条** user 权限

---

### 第五步：第一次发布版本（让权限和机器人能力生效）

**飞书的所有配置（权限、机器人能力等）必须通过"发布版本"才能生效。不发布 = 配置不生效。**

> 这是第一次发布，目的是让权限和机器人能力先生效。事件订阅需要桥接服务先跑起来才能配，所以放到后面。

1. 在左侧导航栏，点击 **「版本管理与发布」**
2. 点击 **「创建版本」** 按钮
3. 填写以下信息：
   - **版本号**：填 `1.0.0`
   - **更新说明**：写一句话，比如 `初始版本，开通权限和机器人能力`
   - **可用范围**：点击 **「编辑」**，选择谁可以使用这个机器人。可以选「全部成员」，也可以只选你自己。如果只是先测试，选你自己就行，后面随时可以改
   - 其他字段保持默认即可
4. 点击 **「保存」**
5. 保存后会弹出一个弹窗，点击 **「申请线上发布」**

提交后，版本状态会变成 **「审核中」**。

---

### 第六步：管理员审核（第一次）

> **如果你自己就是企业飞书管理员**，系统可能会自动通过审核，你可以跳过这一步。
> **如果你不是管理员**，你需要联系你的飞书管理员，请他帮你审核通过。

**告诉管理员这样操作：**

方式一：管理员会在飞书 App 里收到一条审核通知，点击通知 → 查看详情 → 点击 **「通过」**

方式二：让管理员打开飞书管理后台：

```
https://admin.feishu.cn
```

然后操作：
1. 左侧菜单 → 点击 **「工作台」**
2. 点击 **「应用审核」**（在"应用管理"分类下）
3. 找到你刚提交的应用
4. 点击 **「审核」** → 点击 **「通过」**

**审核通过后，权限和机器人能力就生效了。** 接下来需要先启动桥接服务，再配置事件订阅。

---

### 第七步：启动桥接服务

> **这一步由 AI 帮你完成。** 回到 Claude Code 里执行 `/claude-to-im start` 即可。
>
> 桥接服务启动后会自动建立与飞书的长连接（WebSocket）。这是下一步配置事件订阅的前提——飞书需要检测到连接存在才能保存事件配置。

---

### 第八步：配置事件订阅（长连接模式）

**这一步让机器人能「听到」用户发来的消息。不配置的话，机器人是"聋"的。**

> 必须在桥接服务已经启动的状态下操作，否则保存时会报错「未检测到应用连接信息」。

1. 打开浏览器，访问飞书开放平台的应用管理页面：

```
https://open.feishu.cn/app
```

> Lark（国际版）用户访问 `https://open.larksuite.com/app`

2. 登录后你会看到「我的应用」列表，找到你之前创建的那个应用，**点击应用名称**进入应用管理页面
3. 在左侧导航栏，点击 **「事件与回调」**
4. 在「订阅方式」区域，你会看到当前是「暂未订阅」或者一个订阅方式的显示。点击旁边的 ✏️ **编辑图标**（小铅笔）
5. 选择 **「使用长连接接收事件」**（也叫 WebSocket 模式）
   - **不要选** "将事件发送至开发者服务器"（那个是 Webhook，需要公网服务器）
   - 长连接不需要公网服务器，不需要域名，不需要 SSL 证书
6. 点击 **「保存」**
7. 保存成功后，接着在下面找到 **「添加事件」** 按钮，点击它
8. 在弹出的搜索框中，搜索并添加以下事件：

**必须添加的事件：**

```
im.message.receive_v1
```

> 这是"接收消息"事件。搜 `im.message` 就能找到，全名是 **「接收消息 v2.0」** 或 **「Message received」**。

**推荐添加的事件：**

```
p2p_chat_create
```

> 这是"用户首次和机器人私聊"事件。搜 `p2p_chat` 就能找到。

9. 添加完后，点击 **「保存」**

---

### 第九步：第二次发布版本（让事件订阅生效）

> 上一步添加的事件订阅也需要发布版本才能生效。这次只需要创建新版本，之前的权限、机器人能力等配置都还在，不用重新设置。

1. 在左侧导航栏，点击 **「版本管理与发布」**
2. 点击 **「创建版本」**
3. 填写：
   - **版本号**：填 `1.1.0`
   - **更新说明**：比如 `添加事件订阅，机器人可以接收消息了`
   - 其他字段会自动沿用上一版的设置，不用重新填
4. 点击 **「保存」**，然后点击 **「申请线上发布」**

---

### 第十步：管理员审核（第二次）

和第六步一样，等管理员审核通过。如果你自己就是管理员，可能会自动通过。

**审核通过后，机器人就能正常收发消息了！**

> **以后的规律：** 每次修改权限、事件订阅或其他配置，都需要重新「创建版本」→「申请发布」→「管理员通过」。这是飞书的机制，不能跳过。

---

### 获取你的用户 ID（用于 allowed_users，可选）

> 如果你不需要限制谁能用这个机器人，可以跳过这一步（留空 = 所有人都能用）。

用户 ID 的格式是 `ou_` 开头的一串字符，例如 `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。

**最简单的获取方法：**

1. 先不配置 allowed_users（留空），直接启动桥接服务
2. 在飞书里找到你的机器人，给它发一条消息
3. 查看桥接服务的日志（`/claude-to-im logs`），里面会打出 `userId: ou_xxx...` 这样的字段
4. 把这个 `ou_xxx...` 复制下来，填到 allowed_users 配置里

**通过飞书 API 调试台获取：**

1. 打开 `https://open.feishu.cn/api-explorer/`
2. 搜索"获取用户信息"接口
3. 选择你的应用，授权后查询
4. 响应中的 `open_id` 字段就是你要的用户 ID

---

### 配置字段汇总

| 配置项 | 环境变量名 | 必填 | 说明 |
|--------|-----------|------|------|
| App ID | `CTI_FEISHU_APP_ID` | 是 | 格式：`cli_a5xxxxxxxxxxxx` |
| App Secret | `CTI_FEISHU_APP_SECRET` | 是 | 32位字符串 |
| 域名 | `CTI_FEISHU_DOMAIN` | 否 | 飞书留空或填 `https://open.feishu.cn`；Lark 填 `https://open.larksuite.com` |
| 用户白名单 | `CTI_FEISHU_ALLOWED_USERS` | 否 | `ou_xxx` 格式，多个用逗号分隔。留空 = 所有人可用 |

---

### 常见问题

**Q: 机器人创建了但是搜不到？**
A: 版本还没发布或审核没通过。回到「版本管理与发布」检查状态。

**Q: 机器人能搜到，但发消息没反应？**
A: 检查三个地方：① 事件订阅里有没有加 `im.message.receive_v1` ② 订阅方式是不是选了"长连接" ③ 桥接服务是否在运行

**Q: 改了权限后机器人又不工作了？**
A: 飞书要求每次改权限后重新发布版本。回到「版本管理与发布」→「创建版本」→「申请线上发布」→ 管理员审核通过。

**Q: 提示权限不足 / 403？**
A: 权限没有生效。通常是版本没发布，或者发布后管理员还没审核通过。

**Q: 长连接提示"未建立"？**
A: 先把桥接程序跑起来（`/claude-to-im start`），然后回到配置页面刷新就正常了。

**Q: 配置事件订阅时提示"未检测到应用连接信息"？**
A: 桥接服务没在运行。必须先完成第五步（发布）和第七步（启动桥接）后，飞书才能检测到长连接。回到第七步启动桥接服务再试。

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
