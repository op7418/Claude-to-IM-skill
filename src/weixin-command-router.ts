export type WeixinCommand =
  | { type: 'list' }
  | { type: 'current' }
  | { type: 'switch'; alias: string }
  | { type: 'help' };

export function parseWeixinCommand(text: string): WeixinCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === '项目列表') {
    return { type: 'list' };
  }
  if (trimmed === '当前项目') {
    return { type: 'current' };
  }
  if (trimmed === '帮助') {
    return { type: 'help' };
  }

  const switchMatch = trimmed.match(/^切换项目\s+([A-Za-z0-9._-]+)$/);
  if (switchMatch) {
    return {
      type: 'switch',
      alias: switchMatch[1]!,
    };
  }

  return null;
}
