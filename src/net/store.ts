/**
 * 持久化：Cookie 存 SecretStorage，用户信息/书架缓存存 globalState。
 */
import * as vscode from 'vscode';
import { jar } from './http';

const COOKIE_KEY = 'fanqie.cookies.v1';
const USER_KEY = 'fanqie.user.v1';
const DEVICE_KEY = 'fanqie.device.v1';
const SHELF_KEY = 'fanqie.localShelf.v1';
const SETTINGS_KEY = 'fanqie.readerSettings.v1';
const HISTORY_KEY = 'fanqie.readHistory.v1';

export interface UserInfo {
  id: string;
  name: string;
  avatar: string;
  desc: string;
  isVip: boolean;
}

export interface DeviceInfo {
  deviceId: string;
  installId: string;
  deviceType: string;
  deviceBrand: string;
}

let secrets: vscode.SecretStorage | undefined;
let globalState: vscode.Memento | undefined;

export function initStore(ctx: vscode.ExtensionContext): void {
  secrets = ctx.secrets;
  globalState = ctx.globalState;
}

export async function loadPersisted(): Promise<void> {
  if (!secrets) return;
  try {
    const ck = await secrets.get(COOKIE_KEY);
    if (ck) {
      jar.importCookies(ck, 'https://fanqienovel.com/');
    }
  } catch {
    /* ignore */
  }
}

export async function saveCookies(): Promise<void> {
  if (!secrets) return;
  const ck = jar.all().join('; ');
  if (ck) {
    await secrets.store(COOKIE_KEY, ck);
  } else {
    await secrets.delete(COOKIE_KEY);
  }
}

export async function clearCookies(): Promise<void> {
  jar.clear();
  if (secrets) await secrets.delete(COOKIE_KEY);
  if (globalState) await globalState.update(USER_KEY, undefined);
}

export async function getUser(): Promise<UserInfo | null> {
  return globalState ? (globalState.get<UserInfo>(USER_KEY) ?? null) : null;
}

export async function setUser(u: UserInfo | null): Promise<void> {
  if (globalState) await globalState.update(USER_KEY, u ?? undefined);
}

export async function getDevice(): Promise<DeviceInfo> {
  const existing = globalState?.get<DeviceInfo>(DEVICE_KEY);
  if (existing?.deviceId && existing.installId) return existing;
  const dev: DeviceInfo = {
    deviceId: String(Math.floor(Math.random() * 9e15) + 1e15),
    installId: String(Math.floor(Math.random() * 9e15) + 1e15),
    deviceType: 'P30',
    deviceBrand: 'realme',
  };
  if (globalState) await globalState.update(DEVICE_KEY, dev);
  return dev;
}

export interface LocalShelfItem {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  addedAt: number;
  lastReadItemId?: string;
  lastReadChapterTitle?: string;
  lastReadAt?: number;
}

export async function getLocalShelf(): Promise<LocalShelfItem[]> {
  return globalState ? (globalState.get<LocalShelfItem[]>(SHELF_KEY) ?? []) : [];
}

export async function setLocalShelf(items: LocalShelfItem[]): Promise<void> {
  if (globalState) await globalState.update(SHELF_KEY, items);
}

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: 'day' | 'night' | 'sepia';
}

export function defaultReaderSettings(): ReaderSettings {
  // 沉浸式阅读（只显示极简顶栏 + 全屏正文），夜间主题低调不刺眼
  return { fontSize: 19, lineHeight: 1.9, theme: 'night' };
}

export function getReaderSettings(): ReaderSettings {
  const s = globalState?.get<ReaderSettings>(SETTINGS_KEY);
  const merged: ReaderSettings = { ...defaultReaderSettings(), ...(s ?? {}) };
  return merged;
}

export async function setReaderSettings(s: ReaderSettings): Promise<void> {
  if (globalState) await globalState.update(SETTINGS_KEY, s);
}

/** 历史记录条目：按书去重，最近阅读的排在最前（本地记录，无需登录） */
export interface HistoryItem {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  /** 最近读到的章节 */
  itemId: string;
  chapterTitle: string;
  order: number;
  readAt: number;
}

export async function getReadHistory(): Promise<HistoryItem[]> {
  return globalState ? (globalState.get<HistoryItem[]>(HISTORY_KEY) ?? []) : [];
}

export async function setReadHistory(items: HistoryItem[]): Promise<void> {
  if (globalState) await globalState.update(HISTORY_KEY, items);
}
