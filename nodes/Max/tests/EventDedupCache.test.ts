import {
	buildDedupKey,
	createEmptyState,
	DEDUP_STATIC_KEY,
	DEFAULT_TTL_MS,
	UNKNOWN_TTL_MS,
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
						{ key: 'ok', expires_at: 1000 },
						{ key: 123, expires_at: 2000 }, // невалидный key
						{ key: 'no-expires' }, // нет ни expires_at, ни ts
						null,
						{ key: 'ok2', expires_at: 3000 },
					],
				},
			};
			expect(readState(data)).toEqual({
				recent: [
					{ key: 'ok', expires_at: 1000 },
					{ key: 'ok2', expires_at: 3000 },
				],
			});
		});

		it('мигрирует со старого формата ts → expires_at', () => {
			const data = {
				[DEDUP_STATIC_KEY]: {
					recent: [{ key: 'legacy', ts: 1_000_000 }],
				},
			};
			expect(readState(data)).toEqual({
				recent: [{ key: 'legacy', expires_at: 1_000_000 + DEFAULT_TTL_MS }],
			});
		});

		it('writeState кладёт state по ключу _dedup', () => {
			const data: Record<string, unknown> = {};
			const state = { recent: [{ key: 'a', expires_at: 1 }] };
			writeState(data, state);
			expect(data[DEDUP_STATIC_KEY]).toEqual(state);
		});
	});

	describe('pruneExpired', () => {
		it('удаляет записи с истёкшим expires_at', () => {
			const now = 1_700_000_000_000;
			const state = {
				recent: [
					{ key: 'old', expires_at: now - 1 }, // уже истёк
					{ key: 'fresh', expires_at: now + 1000 },
				],
			};
			pruneExpired(state, now);
			expect(state.recent).toEqual([{ key: 'fresh', expires_at: now + 1000 }]);
		});

		it('сохраняет записи на границе TTL (expires_at == now → удалить)', () => {
			const now = 1_700_000_000_000;
			const state = { recent: [{ key: 'edge', expires_at: now }] };
			pruneExpired(state, now);
			expect(state.recent).toEqual([]);
		});
	});

	describe('isDuplicate / record', () => {
		it('record добавляет запись, isDuplicate её потом видит', () => {
			const state = createEmptyState();
			expect(isDuplicate(state, 'k1')).toBe(false);
			record(state, 'k1', 1000);
			expect(isDuplicate(state, 'k1')).toBe(true);
			expect(isDuplicate(state, 'k2')).toBe(false);
		});

		it('обрезает recent до 200 записей (FIFO)', () => {
			const state = createEmptyState();
			for (let i = 0; i < 250; i++) {
				record(state, `k${i}`, i + 1000);
			}
			expect(state.recent).toHaveLength(200);
			// Самые старые выкинуты.
			expect(isDuplicate(state, 'k0')).toBe(false);
			expect(isDuplicate(state, 'k49')).toBe(false);
			expect(isDuplicate(state, 'k50')).toBe(true);
			expect(isDuplicate(state, 'k249')).toBe(true);
		});
	});

	describe('buildDedupKey — схема per update_type', () => {
		const baseTs = 1_640_995_200_000;

		it('null если нет update_type', () => {
			const body = { timestamp: baseTs } as unknown as MaxWebhookEvent;
			expect(buildDedupKey(body)).toBeNull();
		});

		describe('message_created / edited / removed → ${update_type}:${mid}', () => {
			it('message_created по message.body.mid', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_created',
					timestamp: baseTs,
					message: { body: { mid: 'msg_1', seq: 1 } },
				};
				const built = buildDedupKey(body);
				expect(built).toEqual({ key: 'message_created:msg_1', ttlMs: DEFAULT_TTL_MS });
			});

			it('message_edited по тому же mid → другой ключ за счёт update_type', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_edited',
					timestamp: baseTs,
					message: { body: { mid: 'msg_1', seq: 2 } },
				};
				expect(buildDedupKey(body)?.key).toBe('message_edited:msg_1');
			});

			it('message_removed: top-level message_id как fallback', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_removed',
					timestamp: baseTs,
					message_id: 'mr_7',
				};
				expect(buildDedupKey(body)?.key).toBe('message_removed:mr_7');
			});

			it('message_created без mid → unknown SHA-256 + TTL 60s', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_created',
					timestamp: baseTs,
					// нет message.body.mid и нет message_id
				};
				const built = buildDedupKey(body);
				expect(built?.key).toMatch(/^unknown:[0-9a-f]{64}$/);
				expect(built?.ttlMs).toBe(UNKNOWN_TTL_MS);
			});
		});

		describe('message_callback → callback:${callback_id}', () => {
			it('по callback.callback_id', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_callback',
					timestamp: baseTs,
					callback: { callback_id: 'cb_42' },
				};
				expect(buildDedupKey(body)).toEqual({ key: 'callback:cb_42', ttlMs: DEFAULT_TTL_MS });
			});

			it('legacy callback.id поддержан как fallback', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_callback',
					timestamp: baseTs,
					callback: { id: 'legacy_id' },
				};
				expect(buildDedupKey(body)?.key).toBe('callback:legacy_id');
			});
		});

		describe('bot_started/added/removed + user_added/removed → ${type}:${chat}:${user}:${ts}', () => {
			it.each([['bot_started'], ['bot_added'], ['bot_removed'], ['user_added'], ['user_removed']])(
				'%s',
				(updateType) => {
					const body: MaxWebhookEvent = {
						update_type: updateType,
						timestamp: baseTs,
						chat_id: 100,
						user: { user_id: 200 },
					};
					expect(buildDedupKey(body)).toEqual({
						key: `${updateType}:100:200:${baseTs}`,
						ttlMs: DEFAULT_TTL_MS,
					});
				},
			);

			it('chat.chat_id (вложенный) приоритетнее top-level chat_id', () => {
				const body: MaxWebhookEvent = {
					update_type: 'bot_added',
					timestamp: baseTs,
					chat_id: 999, // должен игнорироваться
					chat: { chat_id: 555, type: 'chat' },
					user: { user_id: 200 },
				};
				expect(buildDedupKey(body)?.key).toBe(`bot_added:555:200:${baseTs}`);
			});

			it('без user.user_id → unknown', () => {
				const body: MaxWebhookEvent = {
					update_type: 'bot_added',
					timestamp: baseTs,
					chat_id: 100,
				};
				expect(buildDedupKey(body)?.key).toMatch(/^unknown:/);
			});
		});

		describe('chat_title_changed → chat_title:${chat_id}:${ts}', () => {
			it('по chat.chat_id', () => {
				const body: MaxWebhookEvent = {
					update_type: 'chat_title_changed',
					timestamp: baseTs,
					chat: { chat_id: 999, type: 'chat' },
				};
				expect(buildDedupKey(body)).toEqual({
					key: `chat_title:999:${baseTs}`,
					ttlMs: DEFAULT_TTL_MS,
				});
			});
		});

		describe('message_chat_created → mcc:${chat.chat_id}:${ts}', () => {
			it('по chat.chat_id', () => {
				const body: MaxWebhookEvent = {
					update_type: 'message_chat_created',
					timestamp: baseTs,
					chat: { chat_id: 12345, type: 'chat' },
				};
				expect(buildDedupKey(body)).toEqual({
					key: `mcc:12345:${baseTs}`,
					ttlMs: DEFAULT_TTL_MS,
				});
			});
		});

		describe('неизвестный update_type → unknown:SHA-256(body без timestamp)', () => {
			it('одинаковое тело → одинаковый хеш, разные timestamp игнорируются', () => {
				const a: MaxWebhookEvent = {
					update_type: 'something_new',
					timestamp: baseTs,
					user: { user_id: 1 },
				};
				const b: MaxWebhookEvent = {
					update_type: 'something_new',
					timestamp: baseTs + 99999,
					user: { user_id: 1 },
				};
				const ka = buildDedupKey(a);
				const kb = buildDedupKey(b);
				expect(ka?.key).toBe(kb?.key);
				expect(ka?.key).toMatch(/^unknown:[0-9a-f]{64}$/);
				expect(ka?.ttlMs).toBe(UNKNOWN_TTL_MS);
			});

			it('разное тело → разный хеш', () => {
				const a: MaxWebhookEvent = {
					update_type: 'something_new',
					timestamp: baseTs,
					user: { user_id: 1 },
				};
				const b: MaxWebhookEvent = {
					update_type: 'something_new',
					timestamp: baseTs,
					user: { user_id: 2 },
				};
				expect(buildDedupKey(a)?.key).not.toBe(buildDedupKey(b)?.key);
			});
		});
	});
});
