import type { ITriggerFunctions, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { MaxPollingTrigger, POLLING_BACKOFF_DELAYS_MS } from '../MaxPollingTrigger.node';

interface MockTriggerCtx {
	ctx: ITriggerFunctions;
	httpMock: jest.Mock;
	emitMock: jest.Mock;
	staticGlobal: Record<string, unknown>;
	staticNode: Record<string, unknown>;
	loggerMock: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };
}

interface MockOptions {
	events?: string[];
	pollingTimeout?: number;
	batchLimit?: number;
	forceUnsubscribeWebhooks?: boolean;
	additionalFields?: Record<string, unknown>;
	staticGlobal?: Record<string, unknown>;
	staticNode?: Record<string, unknown>;
	credentials?: Record<string, unknown>;
}

function createTriggerCtx(options: MockOptions = {}): MockTriggerCtx {
	const params: Record<string, unknown> = {
		events: options.events ?? ['message_created'],
		pollingTimeout: options.pollingTimeout ?? 30,
		batchLimit: options.batchLimit ?? 100,
		forceUnsubscribeWebhooks: options.forceUnsubscribeWebhooks ?? false,
		additionalFields: options.additionalFields ?? {},
	};

	const staticGlobal = options.staticGlobal ?? {};
	const staticNode = options.staticNode ?? {};

	const httpMock = jest.fn();
	const emitMock = jest.fn();
	const loggerMock = {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};

	const ctx = {
		getCredentials: jest.fn().mockResolvedValue(
			options.credentials ?? {
				accessToken: 'test-token',
				baseUrl: 'https://platform-api.max.ru',
			},
		),
		getNodeParameter: jest.fn((name: string, fallback?: unknown) =>
			Object.prototype.hasOwnProperty.call(params, name) ? params[name] : fallback,
		),
		getNode: jest.fn().mockReturnValue({
			name: 'Max Polling Trigger',
			type: 'n8n-nodes-max.maxPollingTrigger',
			typeVersion: 1,
		}),
		getWorkflowStaticData: jest.fn((scope: string) =>
			scope === 'global' ? staticGlobal : staticNode,
		),
		emit: emitMock,
		logger: loggerMock,
		helpers: {
			httpRequest: httpMock,
			returnJsonArray: jest.fn((items: unknown[]) => items.map((json) => ({ json }))),
		},
	} as unknown as ITriggerFunctions;

	return { ctx, httpMock, emitMock, staticGlobal, staticNode, loggerMock };
}

async function waitForCalls(mock: jest.Mock, count: number, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (mock.mock.calls.length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`waitForCalls: ожидал ${count} вызовов, получил ${mock.mock.calls.length} за ${timeoutMs}ms`,
			);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

/**
 * Резолвится через `ms` миллисекунд. Нужен в тестах вместо
 * `mockResolvedValue`, чтобы default-ответ не превращал polling
 * loop в синхронный microtask-цикл (миллионы итераций → OOM).
 * Реальный сетевой вызов всегда ≥ 5 ms, так что это адекватный
 * stand-in.
 */
function delayedResolve<T>(value: T, ms = 5): Promise<T> {
	return new Promise((r) => setTimeout(() => r(value), ms));
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((r) => setImmediate(r));
	}
}

function makeMessageCreatedUpdate(mid: string, chatId = 100, userId = 200, timestamp = 1000) {
	return {
		update_type: 'message_created',
		timestamp,
		message: {
			body: { mid, text: 'hello' },
			recipient: { chat_id: chatId },
			sender: { user_id: userId, name: 'Tester' },
		},
	};
}

describe('MaxPollingTrigger Node', () => {
	let triggerInstance: MaxPollingTrigger;

	beforeEach(() => {
		triggerInstance = new MaxPollingTrigger();
	});

	describe('Description', () => {
		it('exposes correct node metadata', () => {
			const description: INodeTypeDescription = triggerInstance.description;
			expect(description.displayName).toBe('Max Polling Trigger');
			expect(description.name).toBe('maxPollingTrigger');
			expect(description.group).toEqual(['trigger']);
			expect(description.version).toBe(1);
			expect(description.inputs).toEqual([]);
			expect(description.outputs).toEqual(['main']);
			expect(description.credentials).toEqual([{ name: 'maxApi', required: true }]);
			expect(description.webhooks).toBeUndefined();

			const propertyNames = description.properties.map((p) => p.name);
			expect(propertyNames).toEqual(
				expect.arrayContaining([
					'events',
					'pollingTimeout',
					'batchLimit',
					'forceUnsubscribeWebhooks',
					'additionalFields',
				]),
			);
		});
	});

	describe('handleWebhookConflict', () => {
		it('пропускает запуск, если /subscriptions вернул пустой список', async () => {
			const { ctx, httpMock, emitMock } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] }); // GET /subscriptions
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 1 })); // GET /updates loop

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 2); // /subscriptions + первый /updates
			await response.closeFunction!();
			await flushMicrotasks();

			expect(httpMock.mock.calls[0]?.[0].url).toMatch(/\/subscriptions$/);
			expect(httpMock.mock.calls[0]?.[0].method).toBe('GET');
			expect(httpMock.mock.calls[1]?.[0].url).toMatch(/\/updates$/);
			expect(emitMock).not.toHaveBeenCalled();
		});

		it('кидает NodeOperationError при подписках без forceUnsubscribe', async () => {
			const { ctx, httpMock } = createTriggerCtx({ forceUnsubscribeWebhooks: false });
			httpMock.mockResolvedValue({
				subscriptions: [{ url: 'https://hook.example/webhook' }],
			});

			await expect(triggerInstance.trigger.call(ctx)).rejects.toThrow(NodeOperationError);
			await expect(triggerInstance.trigger.call(ctx)).rejects.toThrow(/несовместим/);
		});

		it('удаляет подписки при forceUnsubscribe=true и продолжает', async () => {
			const { ctx, httpMock, loggerMock } = createTriggerCtx({ forceUnsubscribeWebhooks: true });
			httpMock.mockResolvedValueOnce({
				subscriptions: [
					{ url: 'https://hook1.example/webhook' },
					{ url: 'https://hook2.example/webhook' },
				],
			});
			httpMock.mockResolvedValueOnce({}); // DELETE 1
			httpMock.mockResolvedValueOnce({}); // DELETE 2
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 1 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 4);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(httpMock.mock.calls[1]?.[0]).toMatchObject({
				method: 'DELETE',
				qs: { url: 'https://hook1.example/webhook' },
			});
			expect(httpMock.mock.calls[2]?.[0]).toMatchObject({
				method: 'DELETE',
				qs: { url: 'https://hook2.example/webhook' },
			});
			expect(loggerMock.info).toHaveBeenCalledWith(
				'Max Polling Trigger - удалена webhook-подписка',
				expect.objectContaining({ url: 'https://hook1.example/webhook' }),
			);
		});

		it('продолжает при ошибке GET /subscriptions (warn, не throw)', async () => {
			const { ctx, httpMock, loggerMock } = createTriggerCtx();
			httpMock.mockRejectedValueOnce(new Error('subscriptions endpoint down'));
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 1 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 2);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(loggerMock.warn).toHaveBeenCalledWith(
				expect.stringMatching(/не удалось проверить webhook-подписки/),
				expect.any(Object),
			);
		});
	});

	describe('Polling cycle', () => {
		it('передаёт marker в /updates если он есть в staticData', async () => {
			const { ctx, httpMock } = createTriggerCtx({
				staticGlobal: { maxPollingMarker: 4242 },
			});
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 4243 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 2);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(httpMock.mock.calls[1]?.[0]).toMatchObject({
				method: 'GET',
				url: 'https://platform-api.max.ru/updates',
				qs: { marker: 4242, timeout: 30, limit: 100 },
				headers: { Authorization: 'test-token' },
			});
		});

		it('сохраняет новый marker из ответа в staticData', async () => {
			const { ctx, httpMock, staticGlobal } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockResolvedValueOnce({ updates: [], marker: 999 });
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 1000 }));

			const response = await triggerInstance.trigger.call(ctx);
			// Ждём: /subscriptions + первый /updates (Once: marker 999) + второй /updates (default: marker 1000)
			await waitForCalls(httpMock, 4);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(staticGlobal['maxPollingMarker']).toBe(1000);
		});

		it("emit нормализованных update'ов с metadata.source = polling", async () => {
			const { ctx, httpMock, emitMock } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockResolvedValueOnce({
				updates: [makeMessageCreatedUpdate('mid-1')],
				marker: 1,
			});
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 2 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 3);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(emitMock).toHaveBeenCalledTimes(1);
			const items = emitMock.mock.calls[0][0][0];
			expect(items).toHaveLength(1);
			expect(items[0].json.update_type).toBe('message_created');
			expect(items[0].json.metadata.source).toBe('polling');
		});

		it("фильтрует update'ы, чей update_type не в events", async () => {
			const { ctx, httpMock, emitMock } = createTriggerCtx({
				events: ['message_created'],
			});
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockResolvedValueOnce({
				updates: [
					makeMessageCreatedUpdate('mid-1'),
					{ update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'cb-1' } },
				],
				marker: 1,
			});
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 2 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 3);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(emitMock).toHaveBeenCalledTimes(1);
			expect(emitMock.mock.calls[0][0][0]).toHaveLength(1);
			expect(emitMock.mock.calls[0][0][0][0].json.update_type).toBe('message_created');
		});

		it("дубликат update (тот же mid) не emit'ится повторно", async () => {
			const { ctx, httpMock, emitMock } = createTriggerCtx();
			const dup = makeMessageCreatedUpdate('mid-dup');
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockResolvedValueOnce({ updates: [dup], marker: 1 });
			httpMock.mockResolvedValueOnce({ updates: [dup], marker: 2 });
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 3 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 4);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(emitMock).toHaveBeenCalledTimes(1);
			expect(emitMock.mock.calls[0][0][0]).toHaveLength(1);
		});

		it('применяет фильтр по chatIds из additionalFields', async () => {
			const { ctx, httpMock, emitMock } = createTriggerCtx({
				additionalFields: { chatIds: '999' },
			});
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockResolvedValueOnce({
				updates: [makeMessageCreatedUpdate('mid-1', /* chatId */ 100)],
				marker: 1,
			});
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 2 }));

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 3);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(emitMock).not.toHaveBeenCalled();
		});
	});

	describe('Error handling', () => {
		it('останавливает polling при 401 Unauthorized', async () => {
			const { ctx, httpMock, loggerMock } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			const err: any = new Error('Unauthorized');
			err.httpCode = 401;
			httpMock.mockRejectedValue(err);

			const response = await triggerInstance.trigger.call(ctx);
			await waitForCalls(httpMock, 2);
			await flushMicrotasks();

			expect(loggerMock.error).toHaveBeenCalledWith(
				expect.stringMatching(/401 Unauthorized/),
				expect.any(Object),
			);
			// Дальше не должно быть новых вызовов
			const callsBefore = httpMock.mock.calls.length;
			await new Promise((r) => setTimeout(r, 50));
			expect(httpMock.mock.calls.length).toBe(callsBefore);

			await response.closeFunction!();
		});

		it('делает backoff на сетевой ошибке и сбрасывает на успехе', async () => {
			const { ctx, httpMock, loggerMock } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
			httpMock.mockImplementation(() => delayedResolve({ updates: [], marker: 1 }));

			const response = await triggerInstance.trigger.call(ctx);
			// Ждём: subscriptions + первый /updates (fail) + backoff 1s + второй /updates (ok)
			await waitForCalls(httpMock, 3, /* timeoutMs */ 5000);
			await response.closeFunction!();
			await flushMicrotasks();

			expect(loggerMock.warn).toHaveBeenCalledWith(
				expect.stringMatching(/backoff 1000ms.*step 1/),
				expect.objectContaining({ error: expect.stringContaining('ECONNREFUSED') }),
			);
		}, 10000);
	});

	describe('Constants', () => {
		it('экспортирует POLLING_BACKOFF_DELAYS_MS с ожидаемыми значениями', () => {
			expect(POLLING_BACKOFF_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
		});
	});

	describe('closeFunction', () => {
		it('останавливает polling и прерывает sleep немедленно', async () => {
			const { ctx, httpMock } = createTriggerCtx();
			httpMock.mockResolvedValueOnce({ subscriptions: [] });
			httpMock.mockRejectedValue(new Error('keep failing'));

			const response = await triggerInstance.trigger.call(ctx);
			// Ждём первой ошибки → нода уйдёт в backoff (1s)
			await waitForCalls(httpMock, 2);
			const t0 = Date.now();
			await response.closeFunction!();
			await flushMicrotasks();
			const elapsed = Date.now() - t0;

			// Если sleep не прерывается — было бы ~1000ms. Должно быть гораздо меньше.
			expect(elapsed).toBeLessThan(500);
		}, 10000);
	});
});
