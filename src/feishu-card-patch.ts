/**
 * Feishu Interactive Card Button Patch
 *
 * Patches the Feishu adapter to:
 * 1. Send Schema 1.0 interactive cards with action buttons (instead of Schema 2.0)
 * 2. Intercept card.action.trigger events at TWO levels:
 *    a. EventDispatcher.invoke() — catches events regardless of dispatcher instance (safety net)
 *    b. WSClient.handleEventData() — full control over WS response frame (primary handler)
 * 3. On button click: resolve permission via WS response, then REST PATCH after delay
 */

import * as lark from '@larksuiteoapi/node-sdk';

// Apply the invoke() patch at import time — must happen before bridgeManager.start()
patchEventDispatcherInvoke();

/**
 * Patch a Feishu adapter instance.
 * Called from main.ts after bridgeManager.start() completes.
 */
export function patchFeishuAdapter(adapter: any): void {
  console.log('[feishu-card-patch] Patching Feishu adapter for interactive cards');

  // Store REST client globally so handleCardAction can use it for card updates
  (globalThis as any).__feishu_rest_client__ = adapter.restClient;

  // Replace sendPermissionCard with interactive Schema 1.0 card with buttons
  adapter.sendPermissionCard = sendPermissionCardImpl;

  // Patch WSClient.prototype.handleEventData for deeper interception
  patchWSClientHandleEventData();
}

/**
 * Wrap EventDispatcher.prototype.invoke to intercept card.action.trigger events.
 * Safety net — fires only if WSClient.handleEventData patch doesn't intercept first.
 */
function patchEventDispatcherInvoke(): void {
  const Dispatcher = lark.EventDispatcher;
  const prototype = Dispatcher.prototype as any;
  const originalInvoke = prototype.invoke;

  if (prototype.__cti_patched__) {
    return;
  }

  prototype.invoke = async function (data: any, options?: any) {
    const eventType = data?.header?.event_type ?? data?.event?.type;

    if (eventType === 'card.action.trigger') {
      console.log('[feishu-card-patch] Intercepted card.action.trigger via invoke()');
      return handleCardAction(data);
    }

    return originalInvoke.call(this, data, options);
  };

  prototype.__cti_patched__ = true;
  console.log('[feishu-card-patch] Patched EventDispatcher.prototype.invoke');
}

/**
 * Patch WSClient.prototype.handleEventData to intercept card.action.trigger
 * at the WebSocket protocol level. This gives full control over the response
 * frame sent back to Feishu.
 *
 * For card.action.trigger events:
 *   1. Resolve permission immediately
 *   2. Send WS response frame (empty ack — just { code: 200 })
 *   3. After 100ms delay, REST PATCH the card with updated content
 *
 * The delay ensures the WS ack is fully processed by Feishu before the
 * PATCH arrives, avoiding race conditions that cause card reversion.
 */
function patchWSClientHandleEventData(): void {
  const wsClientProto = (lark as any).WSClient?.prototype;
  if (!wsClientProto) {
    console.warn('[feishu-card-patch] WSClient.prototype not found, handleEventData patch skipped');
    return;
  }

  if (wsClientProto.__cti_handleEventData_patched__) {
    console.log('[feishu-card-patch] handleEventData already patched, skipping');
    return;
  }

  const originalHandleEventData = wsClientProto.handleEventData;

  wsClientProto.handleEventData = async function (data: any) {
    try {
      // Extract headers from the protobuf frame
      const headers: Record<string, string> = {};
      if (Array.isArray(data?.headers)) {
        for (const h of data.headers) {
          if (h?.key != null) headers[h.key] = h.value;
        }
      }

      // Only process event-type messages
      if (headers['type'] !== 'event') {
        return originalHandleEventData.call(this, data);
      }

      // Decode payload to check event type
      let payloadStr: string;
      try {
        payloadStr = new TextDecoder('utf-8').decode(data.payload);
      } catch {
        return originalHandleEventData.call(this, data);
      }

      let payloadObj: any;
      try {
        payloadObj = JSON.parse(payloadStr);
      } catch {
        return originalHandleEventData.call(this, data);
      }

      const eventType = payloadObj?.header?.event_type ?? payloadObj?.event?.type;

      if (eventType === 'card.action.trigger') {
        console.log('[feishu-card-patch] Intercepted card.action.trigger via handleEventData');

        // Handle the card action: resolve permission + build updated card
        const result = await handleCardActionFull(payloadObj);

        // Send WS response — use empty ack first, then PATCH after delay
        const respPayload: any = { code: 200 };

        if (result?.updatedCard) {
          // We'll PATCH via REST after sending WS ack
          // WS response is just an ack to prevent Feishu timeout
          // (Don't include card data in WS response — it causes reversion)
          console.log('[feishu-card-patch] Sending WS ack, will PATCH card via REST');
        }

        // Build response frame: reuse original frame structure
        const respFrame = {
          ...data,
          headers: [
            ...data.headers,
            { key: 'biz_rt', value: '0' },
          ],
          payload: new TextEncoder().encode(JSON.stringify(respPayload)),
        };

        // Send the WS response
        this.sendMessage(respFrame);

        // Delayed REST PATCH — after WS ack is processed
        if (result?.updatedCard && result?.messageId) {
          setTimeout(async () => {
            try {
              const restClient = (globalThis as any).__feishu_rest_client__;
              if (!restClient) {
                console.warn('[feishu-card-patch] No REST client for PATCH');
                return;
              }

              const cardJson = JSON.stringify(result.updatedCard);
              console.log(`[feishu-card-patch] PATCHing card via REST, messageId: ${result.messageId}`);

              const patchRes = await restClient.im.message.patch({
                path: { message_id: result.messageId },
                data: { content: cardJson },
              });

              console.log(`[feishu-card-patch] PATCH result: code=${patchRes?.code} msg=${patchRes?.msg}`);
            } catch (patchErr) {
              console.warn('[feishu-card-patch] PATCH error:',
                patchErr instanceof Error ? patchErr.message : patchErr);
            }
          }, 100);
        }

        return; // Handled — don't call original
      }
    } catch (err) {
      console.warn('[feishu-card-patch] handleEventData override error:', err);
    }

    // Not a card action or error — pass through to original
    return originalHandleEventData.call(this, data);
  };

  wsClientProto.__cti_handleEventData_patched__ = true;
  console.log('[feishu-card-patch] Patched WSClient.prototype.handleEventData');
}

/**
 * Handle card.action.trigger and return both the updated card AND the message ID
 * for REST PATCH. Unlike handleCardAction() which returns just the WS response,
 * this returns structured data for the handleEventData override to use.
 */
async function handleCardActionFull(data: any): Promise<{
  updatedCard?: Record<string, unknown>;
  messageId?: string;
} | undefined> {
  console.info(`[feishu-card-patch] handleCardActionFull called`);

  const eventPayload = data?.event ?? data;
  const action = eventPayload?.action;
  if (!action?.value) {
    console.info('[feishu-card-patch] No action.value');
    return undefined;
  }

  let callbackData: string;
  let chatId: string;

  try {
    let value = typeof action.value === 'string' ? JSON.parse(action.value) : action.value;
    if (typeof value === 'string') value = JSON.parse(value);
    callbackData = value.callbackData;
    chatId = value.chatId;
  } catch {
    console.info('[feishu-card-patch] Failed to parse action.value');
    return undefined;
  }

  if (!callbackData?.startsWith('perm:') || !chatId) {
    console.info(`[feishu-card-patch] Invalid callbackData or chatId`);
    return undefined;
  }

  const parts = callbackData.split(':');
  if (parts.length < 3) return undefined;

  const permAction = parts[1]; // allow | allow_session | deny
  const permId = parts.slice(2).join(':');

  console.info(`[feishu-card-patch] Card permission: ${permAction} for ${permId.slice(0, 12)}...`);

  // Resolve permission via bridge context
  try {
    const ctx = (globalThis as any).__bridge_context__;
    if (ctx?.permissions?.resolvePendingPermission) {
      const resolution: any = {
        behavior: permAction === 'deny' ? 'deny' : 'allow',
      };
      const ok = ctx.permissions.resolvePendingPermission(permId, resolution);
      if (ok) {
        console.info(`[feishu-card-patch] Permission resolved: ${permAction} for ${permId.slice(0, 12)}...`);
      } else {
        console.warn(`[feishu-card-patch] Permission not found in pending: ${permId.slice(0, 12)}...`);
      }
    }
  } catch (err) {
    console.warn('[feishu-card-patch] Permission resolution error:',
      err instanceof Error ? err.message : err);
  }

  // Extract open_message_id for REST PATCH
  const openMessageId =
    eventPayload?.context?.open_message_id ??
    data?.event?.context?.open_message_id;

  if (!openMessageId) {
    console.warn('[feishu-card-patch] No open_message_id found, cannot PATCH');
  }

  // Build updated card
  const actionLabel =
    permAction === 'allow' ? '已允许' :
    permAction === 'allow_session' ? '本次会话已允许' : '已拒绝';

  const disabledButtons = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '允许' },
      type: permAction === 'allow' ? 'primary' : 'default',
      disabled: true,
      value: '{}',
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '本次会话允许' },
      type: permAction === 'allow_session' ? 'primary' : 'default',
      disabled: true,
      value: '{}',
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '拒绝' },
      type: permAction === 'deny' ? 'danger' : 'default',
      disabled: true,
      value: '{}',
    },
  ];

  const updatedCard = {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: permAction === 'deny' ? 'red' : 'green',
      title: { tag: 'plain_text', content: actionLabel },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**${actionLabel}**` },
      },
      { tag: 'hr' },
      { tag: 'action', actions: disabledButtons },
    ],
  };

  return {
    updatedCard,
    messageId: openMessageId,
  };
}

/**
 * Handle card.action.trigger event data from Feishu.
 * Returns the WS response object (used by invoke() patch as safety net).
 */
async function handleCardAction(data: any): Promise<Record<string, unknown> | undefined> {
  const result = await handleCardActionFull(data);
  if (!result?.updatedCard) return undefined;

  // For the invoke() path, return the card directly as WS response data
  // (The handleEventData path uses REST PATCH instead)
  return { schema: '1.0', ...result.updatedCard };
}

/**
 * Send permission card with Schema 1.0 interactive card buttons.
 */
async function sendPermissionCardImpl(
  this: any,
  chatId: string,
  text: string,
  inlineButtons: any[][],
) {
  if (!this.restClient) {
    return { ok: false, error: 'Feishu client not initialized' };
  }

  const flatButtons = inlineButtons.flat();

  // Find button for each action type
  const allowBtn = flatButtons.find((b: any) =>
    b.callbackData?.includes(':allow:'),
  );
  const sessionBtn = flatButtons.find((b: any) =>
    b.callbackData?.includes(':allow_session:'),
  );
  const denyBtn = flatButtons.find((b: any) =>
    b.callbackData?.includes(':deny:'),
  );

  // Build Schema 1.0 action buttons with different colors
  const actionButtons: any[] = [];

  if (allowBtn) {
    actionButtons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '允许' },
      type: 'primary', // blue
      value: JSON.stringify({ callbackData: allowBtn.callbackData, chatId }),
    });
  }
  if (sessionBtn) {
    actionButtons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '本次会话允许' },
      type: 'default', // gray
      value: JSON.stringify({ callbackData: sessionBtn.callbackData, chatId }),
    });
  }
  if (denyBtn) {
    actionButtons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '拒绝' },
      type: 'danger', // red
      value: JSON.stringify({ callbackData: denyBtn.callbackData, chatId }),
    });
  }

  // Build /perm command lines for reference
  const permCommands = flatButtons.map((btn: any) => {
    if (btn.callbackData?.startsWith('perm:')) {
      const parts = btn.callbackData.split(':');
      return `\`/perm ${parts[1]} ${parts.slice(2).join(':')}\``;
    }
    return btn.text;
  });

  const cardContent = [
    text,
    '',
    '---',
    '**快捷操作：** 点击下方按钮',
    '',
    '或使用命令：' + permCommands.join(' · '),
  ].join('\n');

  // Schema 1.0 interactive card with action buttons
  const cardJson = JSON.stringify({
    schema: '1.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🔐 需要授权' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: cardContent } },
      { tag: 'hr' },
      { tag: 'action', actions: actionButtons },
    ],
  });

  try {
    const res = await this.restClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: cardJson,
      },
    });
    if (res?.data?.message_id) {
      console.log(
        `[feishu-card-patch] Sent interactive card: ${res.data.message_id}`,
      );
      return { ok: true, messageId: res.data.message_id };
    }
    console.warn(
      '[feishu-card-patch] Interactive card send failed:',
      res?.msg,
    );
  } catch (err) {
    console.warn(
      '[feishu-card-patch] Interactive card error:',
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback: plain text with /perm commands
  const plainCommands = flatButtons.map((btn: any) => {
    if (btn.callbackData?.startsWith('perm:')) {
      const parts = btn.callbackData.split(':');
      return `/perm ${parts[1]} ${parts.slice(2).join(':')}`;
    }
    return btn.text;
  });
  const fallbackText = [
    text,
    '',
    '回复: 1 (允许) · 2 (本次会话允许) · 3 (拒绝)',
    '或使用: ' + plainCommands.join(' · '),
  ].join('\n');

  try {
    const res = await this.restClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: fallbackText }),
      },
    });
    if (res?.data?.message_id) {
      return { ok: true, messageId: res.data.message_id };
    }
    return { ok: false, error: res?.msg || 'Send failed' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Send failed',
    };
  }
}
