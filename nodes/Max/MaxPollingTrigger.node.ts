import type {
	IDataObject,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

import { MaxEventProcessor } from './MaxEventProcessor';
import type {
	MaxSubscriptionsResponse,
	MaxTriggerEvent,
	MaxWebhookEvent,
} from './MaxTriggerConfig';

/**
 * Max Polling Trigger — long-polling-альтернатива webhook-триггеру.
 *
 * Использует `GET /updates?marker=&timeout=&limit=` (см. MAX docs:
 * https://dev.max.ru/docs-api/methods/GET/updates). Подходит для сред
 * без публичного HTTPS endpoint (закрытые сети, локальный n8n без
 * проброса наружу).
 *
 * Поведение:
 *   - long polling и webhook несовместимы. При активации проверяем
 *     `GET /subscriptions`; если есть подписки — либо ошибка, либо
 *     удаляем их (поведение управляется параметром
 *     `forceUnsubscribeWebhooks`).
 *   - marker сохраняется в `getWorkflowStaticData('global')['maxPollingMarker']`
 *     и переживает рестарт workflow.
 *   - дедупликация — secondary safety net через `MaxEventProcessor.checkDuplicate`
 *     (composite key, TTL 12h). Marker сам по себе уже исключает повторы,
 *     но при потере staticData ре-активация без marker может прийти на
 *     накопленные update'ы — дедуп защищает workflow от двойного запуска.
 *   - на сетевых ошибках / 5xx — экспоненциальный backoff
 *     (`POLLING_BACKOFF_DELAYS_MS`), сбрасывается на успехе.
 *   - на 401 Unauthorized — останавливаем цикл (auto-restart бесполезен
 *     без смены credentials).
 */

const DEFAULT_BASE_URL = 'https://platform-api.max.ru';
const MARKER_STATIC_KEY = 'maxPollingMarker';

/** Backoff на временных ошибках. На успехе индекс сбрасывается в 0. */
export const POLLING_BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

const MAX_POLLING_TRIGGER_PROPERTIES: INodeProperties[] = [
	{
		displayName: 'Events',
		name: 'events',
		type: 'multiOptions',
		options: [
			{
				name: 'Bot Added To Chat',
				value: 'bot_added',
				description: 'Trigger when added to a chat (update_type: bot_added)',
			},
			{
				name: 'Bot Removed From Chat',
				value: 'bot_removed',
				description: 'Trigger when removed from a chat (update_type: bot_removed)',
			},
			{
				name: 'Bot Started',
				value: 'bot_started',
				description: 'Trigger when a user starts the bot (update_type: bot_started)',
			},
			{
				name: 'Button Clicked',
				value: 'message_callback',
				description: 'Trigger on button click (update_type: message_callback)',
			},
			{
				name: 'Chat Title Changed',
				value: 'chat_title_changed',
				description: 'Trigger on chat title change (update_type: chat_title_changed)',
			},
			{
				name: 'Message Deleted',
				value: 'message_removed',
				description: 'Trigger on message delete (update_type: message_removed)',
			},
			{
				name: 'Message Edited',
				value: 'message_edited',
				description: 'Trigger on message edit (update_type: message_edited)',
			},
			{
				name: 'Message Received (Chat)',
				value: 'message_chat_created',
				description: 'Trigger on new group message (update_type: message_chat_created)',
			},
			{
				name: 'Message Received (Direct)',
				value: 'message_created',
				description: 'Trigger on new direct message (update_type: message_created)',
			},
			{
				name: 'User Joined Chat',
				value: 'user_added',
				description: 'Trigger when user added (update_type: user_added)',
			},
			{
				name: 'User Left Chat',
				value: 'user_removed',
				description: 'Trigger when user removed (update_type: user_removed)',
			},
		],
		required: true,
		default: ['message_created'],
		description: 'The trigger events',
	},
	{
		displayName: 'Polling Timeout',
		name: 'pollingTimeout',
		type: 'number',
		typeOptions: {
			minValue: 15,
			maxValue: 90,
		},
		default: 30,
		description:
			'Long-polling timeout (seconds). Server holds the connection up to this long if there are no updates. Max allowed by API is 90.',
	},
	{
		displayName: 'Batch Limit',
		name: 'batchLimit',
		type: 'number',
		typeOptions: {
			minValue: 10,
			maxValue: 1000,
		},
		default: 100,
		description: 'Maximum number of updates returned per polling request (1-1000)',
	},
	{
		displayName: 'Force Unsubscribe Webhooks on Activate',
		name: 'forceUnsubscribeWebhooks',
		type: 'boolean',
		default: false,
		description:
			'Whether to delete any existing webhook subscriptions on activation. MAX does not deliver updates via long polling while a webhook subscription is active.',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		options: [
			{
				displayName: 'Restrict to Chat IDs',
				name: 'chatIds',
				type: 'string',
				default: '',
				description: 'Only trigger for these chat IDs. Comma-separated.',
			},
			{
				displayName: 'Restrict to User IDs',
				name: 'userIds',
				type: 'string',
				default: '',
				description: 'Only trigger for these user IDs. Comma-separated.',
			},
		],
	},
];

interface PollingResponse {
	updates?: MaxWebhookEvent[];
	marker?: number;
}

/**
 * Sleep, поддерживающий мгновенный выход через AbortSignal. Promise
 * резолвится в обоих случаях (по таймеру или по abort) — caller сам
 * проверяет `isPolling` после await.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function getHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const e = error as Record<string, unknown>;
	const direct = e['httpCode'] ?? e['statusCode'] ?? e['status'];
	if (typeof direct === 'number') return direct;
	if (typeof direct === 'string') {
		const n = Number(direct);
		if (!Number.isNaN(n)) return n;
	}
	const response = e['response'];
	if (response && typeof response === 'object') {
		const r = response as Record<string, unknown>;
		const s = r['status'] ?? r['statusCode'];
		if (typeof s === 'number') return s;
	}
	return undefined;
}

export class MaxPollingTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Max Polling Trigger',
		name: 'maxPollingTrigger',
		icon: 'file:max.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=Events: {{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow on a Max messenger event via long polling',
		defaults: {
			name: 'Max Polling Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'maxApi',
				required: true,
			},
		],
		properties: MAX_POLLING_TRIGGER_PROPERTIES,
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = await this.getCredentials('maxApi');
		const baseUrl = ((credentials['baseUrl'] as string) || DEFAULT_BASE_URL).replace(/\/+$/, '');
		const accessToken = credentials['accessToken'] as string;

		const events = this.getNodeParameter('events') as MaxTriggerEvent[];
		const pollingTimeout = this.getNodeParameter('pollingTimeout') as number;
		const batchLimit = this.getNodeParameter('batchLimit') as number;
		const forceUnsubscribe = this.getNodeParameter('forceUnsubscribeWebhooks') as boolean;
		const additionalFields = this.getNodeParameter('additionalFields', {}) as IDataObject;

		// MAX не доставляет updates через long polling при активной webhook-подписке.
		await handleWebhookConflict(this, baseUrl, accessToken, forceUnsubscribe);

		const eventProcessor = new MaxEventProcessor();
		const abortController = new AbortController();
		let isPolling = true;
		let backoffStep = 0;

		const runCycle = async (): Promise<void> => {
			while (isPolling) {
				try {
					const globalState = this.getWorkflowStaticData('global') as Record<string, unknown>;
					const markerRaw = globalState[MARKER_STATIC_KEY];
					const marker = typeof markerRaw === 'number' ? markerRaw : undefined;

					const qs: IDataObject = {
						timeout: pollingTimeout,
						limit: batchLimit,
					};
					if (marker !== undefined) {
						qs['marker'] = marker;
					}

					const response = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/updates`,
						qs,
						headers: {
							Authorization: accessToken,
						},
						json: true,
						timeout: (pollingTimeout + 10) * 1000,
					})) as PollingResponse;

					backoffStep = 0;

					const updates = Array.isArray(response.updates) ? response.updates : [];
					if (updates.length > 0) {
						const dedupState = this.getWorkflowStaticData('node') as Record<string, unknown>;
						const items: IDataObject[] = [];

						for (const update of updates) {
							if (!update || typeof update !== 'object') continue;

							const updateType = update.update_type;
							if (!updateType || !events.includes(updateType as MaxTriggerEvent)) {
								continue;
							}

							if (!eventProcessor.passesAdditionalFilters(update, additionalFields, this.logger)) {
								continue;
							}

							if (MaxEventProcessor.checkDuplicate(update, dedupState, this.logger)) {
								continue;
							}

							const normalized = eventProcessor.processEventSpecificData(update, updateType);
							normalized.metadata.source = 'polling';
							items.push(normalized as unknown as IDataObject);
						}

						if (items.length > 0) {
							this.emit([this.helpers.returnJsonArray(items)]);
						}
					}

					if (typeof response.marker === 'number') {
						const sd = this.getWorkflowStaticData('global') as Record<string, unknown>;
						sd[MARKER_STATIC_KEY] = response.marker;
					}
				} catch (error) {
					if (!isPolling || abortController.signal.aborted) {
						break;
					}

					const status = getHttpStatus(error);
					if (status === 401) {
						this.logger.error(
							'Max Polling Trigger - 401 Unauthorized, останавливаю polling (проверьте accessToken)',
							{ error: String(error) },
						);
						isPolling = false;
						break;
					}

					const delay =
						POLLING_BACKOFF_DELAYS_MS[
							Math.min(backoffStep, POLLING_BACKOFF_DELAYS_MS.length - 1)
						] ?? POLLING_BACKOFF_DELAYS_MS[POLLING_BACKOFF_DELAYS_MS.length - 1]!;
					backoffStep += 1;
					this.logger.warn(
						`Max Polling Trigger - временная ошибка, backoff ${delay}ms (step ${backoffStep})`,
						{ error: String(error), status },
					);
					await abortableSleep(delay, abortController.signal);
				}
			}
		};

		// Фоновый запуск — не блокируем activate(). Любая необработанная
		// ошибка пишется в лог, но не валит workflow.
		void runCycle().catch((err) => {
			this.logger.error('Max Polling Trigger - polling cycle exited unexpectedly', {
				error: String(err),
			});
		});

		const closeFunction = async (): Promise<void> => {
			isPolling = false;
			abortController.abort();
		};

		return { closeFunction };
	}
}

/**
 * Если есть активные webhook-подписки — либо удаляем их (при
 * `forceUnsubscribe`), либо кидаем понятную ошибку с инструкцией.
 */
async function handleWebhookConflict(
	context: ITriggerFunctions,
	baseUrl: string,
	accessToken: string,
	forceUnsubscribe: boolean,
): Promise<void> {
	let response: MaxSubscriptionsResponse;
	try {
		response = (await context.helpers.httpRequest({
			method: 'GET',
			url: `${baseUrl}/subscriptions`,
			headers: { Authorization: accessToken },
			json: true,
		})) as MaxSubscriptionsResponse;
	} catch (error) {
		// Если /subscriptions недоступен по какой-то причине — продолжаем,
		// MAX сам вернёт ошибку на /updates если конфликт реально есть.
		context.logger.warn(
			'Max Polling Trigger - не удалось проверить webhook-подписки, продолжаю запуск',
			{ error: String(error) },
		);
		return;
	}

	const subscriptions = Array.isArray(response?.subscriptions) ? response.subscriptions : [];
	if (subscriptions.length === 0) {
		return;
	}

	if (!forceUnsubscribe) {
		throw new NodeOperationError(
			context.getNode(),
			'Long polling несовместим с активной webhook-подпиской. Деактивируйте все Max Trigger workflows или включите параметр "Force Unsubscribe Webhooks on Activate".',
			{
				description: `Найдено активных webhook-подписок: ${subscriptions.length}`,
			},
		);
	}

	for (const sub of subscriptions) {
		const url = sub?.url;
		if (typeof url !== 'string' || url.length === 0) continue;
		try {
			await context.helpers.httpRequest({
				method: 'DELETE',
				url: `${baseUrl}/subscriptions`,
				qs: { url },
				headers: { Authorization: accessToken },
				json: true,
			});
			context.logger.info('Max Polling Trigger - удалена webhook-подписка', { url });
		} catch (error) {
			context.logger.error('Max Polling Trigger - не удалось удалить webhook-подписку', {
				url,
				error: String(error),
			});
			throw new NodeOperationError(
				context.getNode(),
				`Не удалось удалить webhook-подписку ${url}: ${String(error)}`,
			);
		}
	}
}
