import type { MaxWebhookEvent } from './MaxTriggerConfig';

/**
 * Дедупликация webhook-событий Max API.
 *
 * MAX server может повторно отправить один и тот же webhook (timeout
 * нашего endpoint, ретрай, гонка при апдейте подписки). Без дедупа
 * workflow запускался бы дважды.
 *
 * Поскольку сейчас в API нет общего поля `update_id` (см.
 * `INVESTIGATION.md` §1.4 / `API_QUESTIONS.md` §1), используем
 * композитный ключ: `<update_type>:<event_id>:<timestamp>`.
 *
 * Состояние хранится:
 *   - в памяти ноды на время одного жизненного цикла webhook;
 *   - персистентно в `getWorkflowStaticData('node')` — переживёт
 *     рестарт workflow / процесса n8n.
 *
 * TTL — 24 часа: записи старше игнорируются и чистятся при чтении.
 */

const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000;

export const DEDUP_STATIC_KEY = '_dedup';

export interface DedupEntry {
	/** Ключ события (см. {@link buildDedupKey}). */
	key: string;
	/** Когда записали (Date.now()). */
	ts: number;
}

export interface DedupState {
	recent: DedupEntry[];
}

/**
 * Создать пустое состояние.
 */
export function createEmptyState(): DedupState {
	return { recent: [] };
}

/**
 * Прочитать состояние из staticData. Если структура не совпадает или
 * пустая — возвращаем пустое состояние. Не мутирует переданный объект.
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
		if (
			item &&
			typeof item === 'object' &&
			typeof (item as DedupEntry).key === 'string' &&
			typeof (item as DedupEntry).ts === 'number'
		) {
			cleaned.push({ key: (item as DedupEntry).key, ts: (item as DedupEntry).ts });
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
 * Удалить записи старше TTL. Мутирует state.
 */
export function pruneExpired(state: DedupState, now: number): void {
	const cutoff = now - TTL_MS;
	state.recent = state.recent.filter((entry) => entry.ts > cutoff);
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
 * Записать ключ. Если переполнили — выкидываем самые старые. Мутирует
 * state.
 */
export function record(state: DedupState, key: string, now: number): void {
	state.recent.push({ key, ts: now });
	if (state.recent.length > MAX_ENTRIES) {
		state.recent.splice(0, state.recent.length - MAX_ENTRIES);
	}
}

/**
 * Построить дедуп-ключ из тела события. Возвращает `null`, если
 * событие не содержит ни `update_type`, ни `timestamp` — такие
 * пропускаем без дедупа (вызывающий должен отдельно решить что делать).
 *
 * Стабильный per-event id выбирается по приоритетам:
 *   1. `message.body.mid` — для message_created / message_edited /
 *      message_chat_created.
 *   2. `callback.callback_id` — для message_callback.
 *   3. `message_id` (на верхнем уровне) — для message_removed.
 *   4. `user.user_id` — для bot_started / user_added / user_removed
 *      / bot_added / bot_removed.
 *   5. `chat.chat_id` — для chat_title_changed.
 *   6. `'na'` — fallback, дедуп будет работать только по
 *      (update_type, timestamp).
 */
export function buildDedupKey(body: MaxWebhookEvent): string | null {
	const updateType = body.update_type;
	const timestamp = body.timestamp;
	if (!updateType || typeof timestamp !== 'number') {
		return null;
	}

	const id = pickEventId(body);
	return `${updateType}:${id}:${timestamp}`;
}

function pickEventId(body: MaxWebhookEvent): string {
	const mid = body.message?.body?.mid;
	if (typeof mid === 'string' && mid.length > 0) {
		return `m:${mid}`;
	}

	const callbackId = body.callback?.callback_id;
	if (typeof callbackId === 'string' && callbackId.length > 0) {
		return `cb:${callbackId}`;
	}

	const topMessageId = body.message_id;
	if (topMessageId !== undefined && topMessageId !== null) {
		return `mid:${topMessageId}`;
	}

	const userId = body.user?.user_id;
	if (typeof userId === 'number') {
		return `u:${userId}`;
	}

	const chatId = body.chat?.chat_id;
	if (typeof chatId === 'number') {
		return `c:${chatId}`;
	}

	// Top-level chat_id для bot_added / bot_removed.
	const topChatId = body.chat_id;
	if (typeof topChatId === 'number') {
		return `c:${topChatId}`;
	}

	return 'na';
}
