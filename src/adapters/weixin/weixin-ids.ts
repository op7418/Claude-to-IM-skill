const WEIXIN_PREFIX = 'weixin::';
const SEPARATOR = '::';

export function encodeWeixinChatId(accountId: string, peerUserId: string): string {
  return `${WEIXIN_PREFIX}${accountId}${SEPARATOR}${peerUserId}`;
}

export function decodeWeixinChatId(chatId: string): { accountId: string; peerUserId: string } | null {
  if (!chatId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = chatId.slice(WEIXIN_PREFIX.length);
  const separatorIndex = rest.indexOf(SEPARATOR);
  if (separatorIndex < 0) return null;

  const accountId = rest.slice(0, separatorIndex);
  const peerUserId = rest.slice(separatorIndex + SEPARATOR.length);
  if (!accountId || !peerUserId) return null;

  return { accountId, peerUserId };
}
