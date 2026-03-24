export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface TextItem {
  text: string;
}

interface MediaItemBase {
  media?: CDNMedia;
  aeskey?: string;
}

export interface ImageItem extends MediaItemBase {
  mid_size?: number;
}

export interface VoiceItem extends MediaItemBase {
  voice_length_ms?: number;
  text?: string;
}

export interface FileItem extends MediaItemBase {
  file_name?: string;
  file_size?: number;
}

export interface VideoItem extends MediaItemBase {
  video_length_s?: number;
}

export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface RefMessage {
  title?: string;
  content?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  from_user_id: string;
  item_list?: MessageItem[];
  context_token?: string;
  create_time?: number;
  ref_message?: RefMessage;
}

export interface GetUpdatesResponse {
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResponse {
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface QrCodeStartResponse {
  errcode?: number;
  errmsg?: string;
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrCodeStatusResponse {
  errcode?: number;
  errmsg?: string;
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface WeixinCredentials {
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;
  cdnBaseUrl: string;
}

export const ERRCODE_SESSION_EXPIRED = -14;
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
