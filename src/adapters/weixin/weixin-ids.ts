const WEIXIN_PREFIX = 'weixin::';
const SEPARATOR = '::';

export function encodeWeixinChatId(accountId: string, peerUserId: string, workspaceAlias?: string): string {
  if (workspaceAlias) {
    return `${WEIXIN_PREFIX}${accountId}${SEPARATOR}${peerUserId}${SEPARATOR}${workspaceAlias}`;
  }
  return `${WEIXIN_PREFIX}${accountId}${SEPARATOR}${peerUserId}`;
}

export function decodeWeixinChatId(chatId: string): { accountId: string; peerUserId: string; workspaceAlias?: string } | null {
  if (!chatId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = chatId.slice(WEIXIN_PREFIX.length);
  const parts = rest.split(SEPARATOR);
  if (parts.length < 2 || parts.length > 3) return null;

  const [accountId, peerUserId, workspaceAlias] = parts;
  if (!accountId || !peerUserId) return null;

  return { accountId, peerUserId, workspaceAlias };
}
