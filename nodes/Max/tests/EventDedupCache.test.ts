import {
	buildDedupKey,
	createEmptyState,
	DEDUP_STATIC_KEY,
	isDuplicate,
	pruneExpired,
	readState,
	record,
	writeState,
} from '../EventDedupCache';
import type { MaxWebhookEvent } from '../MaxTriggerConfig';

describe('EventDedupCache', () => {
	describe('createEmptyState', () => {
		it('возвращает {recent: []}', () => {
			expect(createEmptyState()).toEqual({ recent: [] });
		});
	});

	describe('readState / writeState', () => {
		it('для пустого staticData возвращает пустое состояние', () => {
			expect(readState({})).toEqual({ recent: [] });
		});

		it('игнорирует мусор в staticData[_dedup]', () => {
			expect(readState({ [DEDUP_STATIC_KEY]: 'broken' })).toEqual({ recent: [] });
			expect(readState({ [DEDUP_STATIC_KEY]: { recent: 'not-array' } })).toEqual({
				recent: [],
			});
		});

		it('фильтрует невалидные записи в recent', () => {
			const data = {
				[DEDUP_STATIC_KEY]: {
					recent: [
						{ key: 'ok', ts: 1000 },
						{ key: 123, ts: 2000 }, // невалидный key
						{ key: 'no-ts' }, // нет ts
						null,
						{ key: 'ok2', ts: 3000 },
					],
				},
			};
			expect(readState(data)).toEqual({
				recent: [
					{ key: 'ok', ts: 1000 },
					{ key: 'ok2', ts: 3000 },
				],
			});
		});

		it('writeState кладёт state по ключу _dedup', () => {
			const data: Record<string, unknown> = {};
			const state = { recent: [{ key: 'a', ts: 1 }] };
			writeState(data, state);
			expect(data[DEDUP_STATIC_KEY]).toEqual(state);
		});
	});

	describe('pruneExpired', () => {
		it('удаляет записи старше 24 часов', () => {
			const now = 1_700_000_000_000;
			const day = 24 * 60 * 60 * 1000;
			const state = {
				recent: [
					{ key: 'old', ts: now - day - 1 }, // 24ч+1мс назад → удалить
					{ key: 'fresh', ts: now - 1000 },
				],
			};
			pruneExpired(state, now);
			expect(state.recent).toEqual([{ key: 'fresh', ts: now - 1000 }]);
		});

		it('сохраняет записи на границе TTL', () => {
			const now = 1_700_000_000_000;
			const day = 24 * 60 * 60 * 1000;
			const state = {
				recent: [{ key: 'edge', ts: now - day + 1 }],
			};
			pruneExpired(state, now);
			expect(state.recent).toHaveLength(1);
		});
	});

	describe('isDuplicate / record', () => {
		it('record добавляет запись, isDuplicate его потом видит', () => {
			const state = createEmptyState();
			expect(isDuplicate(state, 'k1')).toBe(false);
			record(state, 'k1', 100);
			expect(isDuplicate(state, 'k1')).toBe(true);
			expect(isDuplicate(state, 'k2')).toBe(false);
		});

		it('обрезает recent до 200 записей (LRU)', () => {
			const state = createEmptyState();
			for (let i = 0; i < 250; i++) {
				record(state, `k${i}`, i);
			}
			expect(state.recent).toHaveLength(200);
			// Самые старые выкинуты.
			expect(isDuplicate(state, 'k0')).toBe(false);
			expect(isDuplicate(state, 'k49')).toBe(false);
			expect(isDuplicate(state, 'k50')).toBe(true);
			expect(isDuplicate(state, 'k249')).toBe(true);
		});
	});

	describe('buildDedupKey', () => {
		const baseTs = 1_640_995_200_000;

		it('null если нет update_type', () => {
			const body = { timestamp: baseTs } as unknown as MaxWebhookEvent;
			expect(buildDedupKey(body)).toBeNull();
		});

		it('null если нет timestamp', () => {
			const body = { update_type: 'message_created' } as unknown as MaxWebhookEvent;
			expect(buildDedupKey(body)).toBeNull();
		});

		it('для message_created использует body.mid', () => {
			const body: MaxWebhookEvent = {
				update_type: 'message_created',
				timestamp: baseTs,
				message: {
					body: { mid: 'msg_1', seq: 1 },
				},
			};
			expect(buildDedupKey(body)).toBe(`message_created:m:msg_1:${baseTs}`);
		});

		it('для message_callback использует callback_id', () => {
			const body: MaxWebhookEvent = {
				update_type: 'message_callback',
				timestamp: baseTs,
				callback: { callback_id: 'cb_42' },
			};
			expect(buildDedupKey(body)).toBe(`message_callback:cb:cb_42:${baseTs}`);
		});

		it('для message_removed использует верхнеуровневый message_id', () => {
			const body: MaxWebhookEvent = {
				update_type: 'message_removed',
				timestamp: baseTs,
				message_id: 'mr_7',
			};
			expect(buildDedupKey(body)).toBe(`message_removed:mid:mr_7:${baseTs}`);
		});

		it('для bot_started падает на user.user_id', () => {
			const body: MaxWebhookEvent = {
				update_type: 'bot_started',
				timestamp: baseTs,
				user: { user_id: 555 },
			};
			expect(buildDedupKey(body)).toBe(`bot_started:u:555:${baseTs}`);
		});

		it('для chat_title_changed падает на chat.chat_id', () => {
			const body: MaxWebhookEvent = {
				update_type: 'chat_title_changed',
				timestamp: baseTs,
				chat: { chat_id: 999, type: 'chat' },
			};
			expect(buildDedupKey(body)).toBe(`chat_title_changed:c:999:${baseTs}`);
		});

		it('для bot_added/bot_removed использует верхнеуровневый chat_id', () => {
			const body: MaxWebhookEvent = {
				update_type: 'bot_added',
				timestamp: baseTs,
				chat_id: 777,
			};
			expect(buildDedupKey(body)).toBe(`bot_added:c:777:${baseTs}`);
		});

		it('fallback "na" если ни одного id нет', () => {
			const body: MaxWebhookEvent = {
				update_type: 'unknown_event',
				timestamp: baseTs,
			};
			expect(buildDedupKey(body)).toBe(`unknown_event:na:${baseTs}`);
		});
	});
});
