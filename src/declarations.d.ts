// Type declarations for external packages that may not be installed

declare module 'claude-to-im/src/lib/bridge/context.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function initBridgeContext(config?: any): void;
}

declare module 'claude-to-im/src/lib/bridge/bridge-manager.js' {
  // Use any to make it work without exact types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridgeManager: any;
  export default bridgeManager;
}

declare module 'claude-to-im/src/lib/bridge/host.js' {
  export interface StreamChatParams {
    prompt: string;
    files?: Array<{
      type: string;
      data: string;
    }>;
    model?: string;
    workingDirectory?: string;
    sdkSessionId?: string;
    sessionId?: string;
    permissionMode?: string;
    abortController?: AbortController;
  }

  // Use any to avoid strict return type matching
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type LLMProvider = any;

  export type FileAttachment = {
    type: string;
    data: string;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BridgeStore = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BridgeSession = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BridgeMessage = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type BridgeApiProvider = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type AuditLogInput = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PermissionLinkInput = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PermissionLinkRecord = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OutboundRefInput = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type UpsertChannelBindingInput = any;
}

declare module 'claude-to-im/src/lib/bridge/types.js' {
  export interface PendingPermissions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ChannelBinding = any;
  export type ChannelType = string;
}

declare module '@anthropic-ai/claude-agent-sdk' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const query: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SDKMessage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const PermissionResult: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ClaudeAgent: any;
  export default ClaudeAgent;
}
