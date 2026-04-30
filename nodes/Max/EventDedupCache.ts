import { createHash } from 'node:crypto';

import type { MaxWebhookEvent } from './MaxTriggerConfig';

/**
 * Дедупликация webhook-событий MAX API.
 *
 * MAX server может повторно отправить один и тот же webhook (ретрай
 * по таймауту нашего endpoint, гонка при апдейте подписки). Без дедупа
 * workflow запускался бы дважды.
 *
 * **MAX Update objects не содержит `update_id`** (см.
 * https://dev.max.ru/docs-api/objects/Update). Поэтому ключ —
 * композитный, по `update_type`-специфичной схеме (см. {@link buildDedupKey}).
 *
 * Состояние:
 *   - в памяти ноды на время одного жизненного цикла webhook;
 *   - персистентно в `getWorkflowStaticData('node')` — переживает
 *     рестарт workflow / процесса n8n.
 *
 * TTL:
 *   - стандартные события (известные `update_type`) — 12 часов
 *     (с запасом до 8h auto-unsubscribe MAX'а);
 *   - неизвестные `update_type` — 60 секунд (короткое окно для
 *     hash-based fallback, чтобы не копить мусор).
 *
 * Записи с истёкшим TTL чистятся при чтении (lazy prune).
 */

const MAX_ENTRIES = 200;

/** Стандартный TTL для известных update_type. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** TTL для unknown update_type (SHA-256 fallback). */
export const UNKNOWN_TTL_MS = 60 * 1000;

export const DEDUP_STATIC_KEY = '_dedup';

export interface DedupEntry {
	/** Ключ события (см. {@link buildDedupKey}). */
	key: string;
	/** Когда запись истекает (Date.now()-совместимое значение в ms). */
	expires_at: number;
}

export interface DedupState {
	recent: DedupEntry[];
}

export interface BuiltKey {
	key: string;
	ttlMs: number;
}

/**
 * Создать пустое состояние.
 */
export function createEmptyState(): DedupState {
	return { recent: [] };
}

/**
 * Прочитать состояние из staticData. Если структура не совпадает или
 * пустая — возвращаем пустое состояние. Поддерживает миграцию со
 * старого формата (`{key, ts}` → `{key, expires_at = ts + DEFAULT_TTL_MS}`).
 */
export function readState(staticData: Record<string, unknown>): DedupState {
	const raw = staticData[DEDUP_STATIC_KEY];
	if (!raw || typeof raw !== 'object') {
		return createEmptyState();
	}
	const recent = (raw as { recent?: unknown }).recent;
	if (!Array.isArray(recent)) {
		return createEmptyState();
	}
	const cleaned: DedupEntry[] = [];
	for (const item of recent) {
		if (!item || typeof item !== 'object') continue;
		const entry = item as { key?: unknown; expires_at?: unknown; ts?: unknown };
		if (typeof entry.key !== 'string') continue;

		if (typeof entry.expires_at === 'number') {
			cleaned.push({ key: entry.key, expires_at: entry.expires_at });
		} else if (typeof entry.ts === 'number') {
			// Миграция со старого формата (ts → expires_at).
			cleaned.push({ key: entry.key, expires_at: entry.ts + DEFAULT_TTL_MS });
		}
	}
	return { recent: cleaned };
}

/**
 * Записать состояние в staticData (мутирует переданный объект).
 */
export function writeState(staticData: Record<string, unknown>, state: DedupState): void {
	staticData[DEDUP_STATIC_KEY] = state;
}

/**
 * Удалить записи с истёкшим TTL. Мутирует state.
 */
export function pruneExpired(state: DedupState, now: number): void {
	state.recent = state.recent.filter((entry) => entry.expires_at > now);
}

/**
 * Проверить, видели ли мы такой ключ.
 */
export function isDuplicate(state: DedupState, key: string): boolean {
	for (const entry of state.recent) {
		if (entry.key === key) {
			return true;
		}
	}
	return false;
}

/**
 * Записать ключ. Если переполнили MAX_ENTRIES — выкидываем самые
 * старые (FIFO). Мутирует state.
 *
 * @param expiresAt — момент истечения записи в ms (now + ttlMs).
 */
export function record(state: DedupState, key: string, expiresAt: number): void {
	state.recent.push({ key, expires_at: expiresAt });
	if (state.recent.length > MAX_ENTRIES) {
		state.recent.splice(0, state.recent.length - MAX_ENTRIES);
	}
}

/**
 * Построить дедуп-ключ из тела webhook-события.
 *
 * Возвращает `null` если у события нет `update_type` — такие
 * пропускаем без дедупа (вызывающий должен решить что делать).
 *
 * Схема ключа per `update_type`:
 *   - `message_created/edited/removed` → `${update_type}:${message.body.mid}`.
 *   - `message_callback` → `callback:${callback.callback_id}`.
 *   - `bot_started/added/removed` → `${update_type}:${chat_id}:${user_id}:${timestamp}`.
 *   - `user_added/removed` → `${update_type}:${chat_id}:${user_id}:${timestamp}`.
 *   - `chat_title_changed` → `chat_title:${chat_id}:${timestamp}`.
 *   - `message_chat_created` → `mcc:${chat.chat_id}:${timestamp}`.
 *   - неизвестный type → `unknown:SHA-256(JSON.stringify(body без timestamp))`,
 *     TTL 60 секунд.
 */
export function buildDedupKey(body: MaxWebhookEvent): BuiltKey | null {
	const updateType = body.update_type;
	if (!updateType) {
		return null;
	}
	const timestamp = typeof body.timestamp === 'number' ? body.timestamp : 0;

	switch (updateType) {
		case 'message_created':
		case 'message_edited':
		case 'message_removed': {
			const mid = body.message?.body?.mid ?? body.message_id;
			if (mid !== undefined && mid !== null && String(mid).length > 0) {
				return { key: `${updateType}:${mid}`, ttlMs: DEFAULT_TTL_MS };
			}
			return unknownKey(body);
		}

		case 'message_callback': {
			const cbId = body.callback?.callback_id ?? body.callback?.id;
			if (typeof cbId === 'string' && cbId.length > 0) {
				return { key: `callback:${cbId}`, ttlMs: DEFAULT_TTL_MS };
			}
			return unknownKey(body);
		}

		case 'bot_started':
		case 'bot_added':
		case 'bot_removed':
		case 'user_added':
		case 'user_removed': {
			const chatId = pickChatId(body);
			const userId = body.user?.user_id;
			if (chatId !== undefined && typeof userId === 'number') {
				return {
					key: `${updateType}:${chatId}:${userId}:${timestamp}`,
					ttlMs: DEFAULT_TTL_MS,
				};
			}
			return unknownKey(body);
		}

		case 'chat_title_changed': {
			const chatId = pickChatId(body);
			if (chatId !== undefined) {
				return { key: `chat_title:${chatId}:${timestamp}`, ttlMs: DEFAULT_TTL_MS };
			}
			return unknownKey(body);
		}

		case 'message_chat_created': {
			const chatId = body.chat?.chat_id ?? pickChatId(body);
			if (chatId !== undefined) {
				return { key: `mcc:${chatId}:${timestamp}`, ttlMs: DEFAULT_TTL_MS };
			}
			return unknownKey(body);
		}

		default:
			return unknownKey(body);
	}
}

/**
 * Fallback-ключ для неизвестных update_type (или известных, у которых
 * не нашлось ожидаемых полей). Хеш по телу без `timestamp` — две
 * подряд одинаковые доставки получат одинаковый ключ. TTL 60s — узкое
 * окно, чтобы не копить мусор от неподдерживаемых событий.
 */
function unknownKey(body: MaxWebhookEvent): BuiltKey {
	const copy: Record<string, unknown> = { ...(body as unknown as Record<string, unknown>) };
	delete copy['timestamp'];
	const json = JSON.stringify(copy);
	const hash = createHash('sha256').update(json).digest('hex');
	return { key: `unknown:${hash}`, ttlMs: UNKNOWN_TTL_MS };
}

function pickChatId(body: MaxWebhookEvent): number | undefined {
	const fromChat = body.chat?.chat_id;
	if (typeof fromChat === 'number') return fromChat;
	const top = body.chat_id;
	if (typeof top === 'number') return top;
	return undefined;
}
