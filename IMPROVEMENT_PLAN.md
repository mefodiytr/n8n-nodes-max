# План улучшений n8n-nodes-max

Дата: 2026-04-30. На основе `INVESTIGATION.md` (этап 1) и приоритетов
заказчика. Source of truth по API — [dev.max.ru/docs-api](https://dev.max.ru/docs-api).
Открытые вопросы по контрактам — в `API_QUESTIONS.md`.

Каждая задача = один коммит (AGENTS.md:122). Тесты добавляются в
существующие файлы по типу (AGENTS.md:115-119), пороги coverage
не понижаются (AGENTS.md:114).

Условные обозначения трудозатрат: **S** = до 1 дня, **M** = 1–3 дня,
**L** = неделя+.

## Очерёдность реализации

```
Релиз 0.2.0 — стабильность + базовые message/chat-операции
  1. Дедуп update_id              [S] high (фундамент)
  2. console.log → this.logger    [S] high (перед новыми фичами)
  3. Pin / Unpin                  [S]+[S] high
  4. Forward message              [S]   high
  5. Edit chat                    [S]   high
  6. Send action (typing)         [S]   high

Релиз 0.3.0 — альтернативный способ принимать события
  7. Long-polling Trigger node    [M]   high

Релиз 0.4.0 — модерация чатов
  8. Members management ×6        [S]×6 high

Релиз 0.5.0 — служебные операции и уборка
  9. Subscriptions explicit ops   [S]   medium
 10. Bot info get/set             [S]   medium
 11. Keyboard helpers refactor    [S]   low

Релиз 1.0.0 — публикация под @mefodiy scope
 12. README + публикация          [S]   (см. §Releases)
```

Между шагами 6→7 и 8→9 — естественные точки smoke-теста на
вашем `withpostgres-n8n-1`.

## 1. Дедупликация `update_id` (high)

**Зачем:** в `MaxEventProcessor` сейчас нет хранилища — при двойной
доставке (или ретрае на стороне MAX) workflow запускается дважды.
Это уязвимость к дублям, не «уборка».

**Что:**

- В `nodes/Max/MaxEventProcessor.ts` добавить in-memory LRU
  (Map с очередью ключей, capacity = 200) — быстрый O(1) lookup
  для горячего пути.
- Persistent fallback через `getWorkflowStaticData('node')` —
  массив последних N=200 `update_id` с timestamp. Записывается
  при каждом новом update, читается при старте триггера.
- TTL: 24 часа (старые `update_id` чистятся при чтении).
- Если `update_id` уже виден → не вызываем `emit`, но логируем
  через `this.logger.debug`.
- Edge-case: если у update'а нет `update_id` (теоретически
  возможно — сверить по docs) — пропускаем дедуп, предупреждение
  в лог.

**Файлы:** `MaxEventProcessor.ts` + новый
`tests/MaxEventProcessor.dedup.test.ts` (или extension существующего).

**Acceptance:**

- Тест: дважды подряд приходит update с одним `update_id` →
  emit вызывается **ровно один раз**.
- Тест: рестарт-симуляция (новый instance с тем же
  staticData) — старые `update_id` всё ещё блокируются.
- Тест: разные `update_id` подряд — оба пропускаются.
- Покрытие в `MaxEventProcessor.test.ts` суммарно не падает.

## 2. `console.log` → `this.logger` (high)

**Зачем:** в `MaxWebhookManager.ts` (строки 43, 53, 57, 86, 97,
101, 116, 119, 138, 151, 153, 159) и `MaxEventProcessor.ts`
(строки 85, 89, 96, 100, 109, 119, 200, 236) логирование идёт
через `console.log` напрямую — неудобно фильтровать в n8n
production.

**Что:**

- Заменить `console.log` на `this.logger.{debug|info|warn|error}`
  где доступен n8n-context (внутри методов нод).
- Где `this` недоступен (модульный scope) — оставить с пометкой
  `// no this.logger here`.
- Уровень подобрать осмысленно: `info` для lifecycle (subscribe
  ok), `warn` для пропусков, `error` для падений, `debug` для
  per-event detail.

**Acceptance:**

- `git grep -n "console\." nodes/Max/Max*.ts` возвращает только
  то что осталось обоснованно (с пояснением).
- Тесты не ломаются (логирование мокать не нужно).

**Делается одним коммитом перед фичами**, чтобы новый код сразу
писался правильно.

## 3. Pin / Unpin сообщений (high)

API: см. `API_QUESTIONS.md` §3.

### 3.1. `message/pinMessage` `[S]`

- В `Max.node.ts` resource `message`, operation `pinMessage`.
- Параметры: `chatId` (required), `messageId` (required), `notify`
  (boolean, default true).
- Helper в `GenericFunctions.ts`.
- Тесты: `Max.node.test.ts` + `GenericFunctions.test.ts`.

### 3.2. `message/unpinMessage` `[S]`

- Параметры: `chatId`, `messageId`.

**Acceptance:** оба endpoint вызываются с правильным path/method/body;
тест на 4xx (отсутствие messageId).

## 4. Forward message (high)

API: см. `API_QUESTIONS.md` §4.

### 4.1. `message/forwardMessage` `[S]`

- Параметры: `from_chat_id`, `message_id`, target (`chatId` или
  `userId`), `disable_notification` (опц.).
- Helper.
- Тесты на shape + разные target'ы.

`Copy message` (был §3.2 в старом плане) — **гейт от подтверждения
docs**. Если `POST /messages?copy_id=...` или аналог не поддержан —
отдельной операции делать не будем (см. `API_QUESTIONS.md` §5).

## 5. Edit chat (high)

API: см. `API_QUESTIONS.md` §6.

### 5.1. `chat/editChat` `[S]`

- Параметры: `chatId`, `title` (опц.), `description` (опц.),
  `iconUrl` (опц.). Валидация: хотя бы одно поле задано.
- Тело запроса собирается только из заданных полей (без
  `undefined`).
- Helper.
- Тесты: каждое поле отдельно + комбинация.

## 6. Send Action / typing (high)

API: см. `API_QUESTIONS.md` §7.

### 6.1. `chat/sendAction` `[S]`

- Параметры: `chatId`, `action` (enum из docs).
- Helper.
- Тесты: shape, валидация unknown action.

---

**Чекпоинт перед релизом 0.2.0:** smoke-test полного набора в
`withpostgres-n8n-1` (см. §Releases ниже).

---

## 7. Long-polling Trigger (high)

**Зачем:** webhook требует публичный HTTPS. В закрытых средах
(внутренние n8n без проброса наружу) альтернатива — long-polling.
Референс — [bergi9/n8n-nodes-telegram-polling](https://github.com/bergi9/n8n-nodes-telegram-polling).

### 7.1. Новая нода `MaxPollingTrigger` `[M]`

**Что:**

- `nodes/Max/MaxPollingTrigger.node.ts`.
- В `package.json:46-49` добавить третий entry point:
  `dist/nodes/Max/MaxPollingTrigger.node.js`.
- Lifecycle: workflow active → запуск фонового цикла через
  `triggerFunctions.helpers.returnJsonArray`.
- Курсор `marker` хранится в `getWorkflowStaticData('node')`.
- Endpoint `GET /updates?marker=&timeout=30`.
- Backoff на 429/5xx: `1 → 2 → 4 → 8 → 16 → 30` секунд.
- Тот же `MaxEventProcessor` для нормализации — общий с
  webhook-вариантом (включая дедуп из §1).
- В UI: те же 11 событий что в webhook-trigger, без webhook-полей.
- При деактивации — graceful stop (флаг + `await` текущего цикла).

**Acceptance:**

- Тесты на старт/стоп (mock `httpRequest`).
- Курсор переживает рестарт workflow (через staticData).
- Backoff корректно растёт на ошибках, сбрасывается при успехе.
- Один и тот же `MaxEventProcessor` парсит и polling-, и
  webhook-update'ы (общая дедупликация).

### 7.2. Документация `[S]`

- README — раздел «Когда использовать polling vs webhook»
  (требования к сети, latency, нюансы).
- `AGENTS.md` — упомянуть существование второй ноды.

---

**Чекпоинт перед релизом 0.3.0:** smoke-test polling-триггера +
проверка что webhook-триггер (старая нода) не сломан.

---

## 8. Members management (high)

Новый resource `member` с шестью операциями. Все API-пути и нюансы —
в `API_QUESTIONS.md` §8.

| Операция            | Файл                                 | Параметры                          | Заметка                           |
| ------------------- | ------------------------------------ | ---------------------------------- | --------------------------------- |
| 8.1 `getMembers`    | `Max.node.ts`, `GenericFunctions.ts` | `chatId`, `limit`, `marker`        | Пагинация — см. вопрос §8.1       |
| 8.2 `getAdmins`     | то же                                | `chatId`, `limit?`, `marker?`      | Может не требовать пагинации      |
| 8.3 `addMembers`    | то же                                | `chatId`, `userIds[]`              | Body `{user_ids: [...]}`          |
| 8.4 `removeMembers` | то же                                | `chatId`, `userId` или `userIds[]` | Зависит от поддержки batch        |
| 8.5 `setAdmin`      | то же                                | `chatId`, `userId`, `permissions?` | Зависит от поддержки fine-grained |
| 8.6 `removeAdmin`   | то же                                | `chatId`, `userId`                 | —                                 |

**Acceptance каждой:** UI-параметры, helper, тест на shape запроса,
тест на парсинг ответа. **Один коммит = одна операция.**

## 9. Subscriptions explicit ops (medium)

Сейчас `subscribe`/`unsubscribe` вызываются автоматически
webhook-триггером. Иногда нужно из workflow вручную: посмотреть
активные, удалить осиротевшую подписку.

### 9.1. Resource `subscription` `[S]`

- Operations: `list` (`GET /subscriptions`),
  `delete` (`DELETE /subscriptions?url=`).
- Helpers — переиспользуем существующие из `MaxWebhookManager.ts:187-261`
  (вынести в `GenericFunctions.ts` если потребуется).
- Тесты, README.

## 10. Bot info get/set (medium)

API: `GET /me` (используется в credential test, точно работает),
`PATCH /me` или `PUT /me` — см. `API_QUESTIONS.md` §10.

### 10.1. Resource `bot` + `getMyInfo` / `setMyInfo` `[S]`

- `getMyInfo` — без параметров, возвращает текущую инфу бота.
- `setMyInfo` — `name`, `description`, `username` (опц.) — какие
  поля редактируемы по docs.

## 11. Keyboard helpers refactor (low)

Косметика, делается в конце цикла когда фичи стабилизированы.

### 11.1. Объединить `processKeyboardFromAdditionalFields` и

`processKeyboardFromParameters` `[S]`

- В `GenericFunctions.ts:1981-2034` и `2046-2089` — почти
  идентичная логика. Извлечь общий
  `buildKeyboardAttachment(rows: KeyboardRow[])`.
- Тонкие обёртки парсят свою UI-форму → вызывают builder.
- Регресс-тесты в `GenericFunctions.test.ts`.

### 11.2. Привести валидацию `request_contact` /

`request_geo_location` к лимиту `MAX_LIMITED_TYPE_BUTTONS_PER_ROW = 3`
`[S]`

- Сверить с docs-api, какие типы попадают под лимит «3 в ряду».
- Тест на ошибку при нарушении.

## 12. Технический долг — находки этапа 1+2

Зафиксировано на основе ответов заказчика по `API_QUESTIONS.md`.
Не блокирует 0.2.0, попадёт в более поздние релизы.

### 12.1. Rate limit 30 RPS на platform-api.max.ru `[M]` — high → 0.4.0

При batch-операциях (members management, массовая рассылка) MAX
вернёт **429 Too Many Requests** с `Retry-After`. Сейчас helper'ы
просто пробросят ошибку.

**Что:**

- `apiRequestWithRetry(endpoint, options)` — обёртка над
  существующими httpRequest. Уважает `Retry-After` (секунды или
  HTTP date), повторяет до N раз с суммарным бюджетом ≤ 30s.
- 5xx — экспоненциальный backoff (1s → 2s → 4s, до 3 попыток).

**Acceptance:** регресс в `GenericFunctions.test.ts` — mock 429 +
Retry-After=1, helper делает паузу и повторяет; mock трёх 500 →
helper ждёт 1s/2s/4s.

Сделать **до 0.4.0** (members management) — там batch особенно
подвержен rate-limit'у.

### 12.2. Webhook retry policy MAX `[S]` — medium → 0.4.0

MAX повторяет webhook **10 раз** ×2.5 (60→150→375→…), таймаут на
ответ — 30s, после 10 неудач — `auto-unsubscribe` через 8 часов.

**Что:**

- README: упомянуть, что endpoint должен возвращать 2xx за 30s.
- `MaxWebhookManager`: при старте workflow проверять — есть ли
  ещё наша подписка. Если нет (auto-unsubscribe сработал) —
  перерегистрировать. Сейчас `checkExists` есть, но логика на
  start не вызывается между запусками — добавить.

### 12.3. `photo` тип удалён в MAX API → везде `image` `[S]` — low → 0.5.0

В MAX API тип вложения `photo` deprecated, актуально `image`.
Найти `'photo'` в `GenericFunctions.ts` / `Max.node.ts`, заменить.
Возможно нужна миграция старых workflow (если параметр `type`
был сохранён как 'photo' — конвертировать на лету, deprecation-
лог).

### 12.4. `console.log` в `GenericFunctions.ts` `[S]` — low → 0.5.0

В 0.2.0 заменены console.log в `MaxWebhookManager` и
`MaxEventProcessor`. В `GenericFunctions.ts` осталось — отдельным
коммитом в уборочном 0.5.0, по тому же шаблону (this.logger
прокидывается параметром в helpers, default = silent).

### 12.5. Полный список 14 `update_type` в `MaxTriggerConfig` — medium → 0.5.0

Сейчас 11 событий в `MAX_TRIGGER_EVENTS`. По уточнению заказчика
их в API **14**. Добавить недостающие (что именно — выяснить
точно по docs до старта 0.5.0). Связано с §9 (Subscriptions
explicit ops) — там же `update_types` перечислены.

### 12.6. `secret` header `X-Max-Bot-Api-Secret` `[S]` — medium → 0.5.0

В подписках MAX поддерживает поле `secret` (передаётся в
header). Сейчас `MaxWebhookManager.getSubscriptionPayload`
кладёт его в body. Проверить как именно MAX ожидает — body или
header (по докам — должен быть header в запросе webhook'а к нам
для верификации). Связано с §9.

## Releases

Релизные коммиты создаются строго через `npm version
patch|minor|major` (AGENTS.md:124-128). Тег пушится через
`git push origin master --follow-tags`. npm-публикацию делает
GitHub Action на тег `v*.*.*`.

### 0.2.0 — стабильность + базовые message/chat-операции

**Содержит:** §1 (дедуп), §2 (logger), §3 (pin/unpin),
§4 (forward), §5 (edit chat), §6 (send action).

**Кому важно:** тем у кого webhook ретраится по сетевым причинам;
тем кому нужны pin/forward/edit_chat/typing-indicator.

**Что проверить после обновления:**

- Webhook-триггер всё ещё стартует и принимает события.
- Существующие workflows с send/edit/delete/answer не сломаны.
- Дедуп: в логах при двойной доставке появляется
  `update_id <id> already processed, skip`.

### 0.3.0 — Long-polling Trigger

**Содержит:** §7.

**Кому важно:** тем у кого нет публичного HTTPS endpoint для
вебхука (closed networks, локальный n8n без проброса).

**Что проверить:** оба триггера в одном n8n не конфликтуют;
курсор переживает рестарт workflow.

### 0.4.0 — Members management

**Содержит:** §8 (6 операций).

**Кому важно:** тем кто строит модерацию чатов / онбординг через
n8n.

**Что проверить:** `getMembers` пагинация работает; `addMembers`
не падает на пустом массиве; `setAdmin` правильно меняет роли.

### 0.5.0 — служебные операции и уборка

**Содержит:** §9 (subscriptions), §10 (bot info), §11 (keyboard
refactor).

**Кому важно:** разработчикам нод и тем кому нужен фигурный
менеджмент подписок.

**Что проверить:** ничего из старого функционала не сломалось.
Регресс-тесты по клавиатурам прошли.

### 1.0.0 — публикация под `@mefodiy` scope

**Что:**

- В `package.json:2` — `"name": "@mefodiy/n8n-nodes-max"`
  (обновлено в одном коммите вместе с README/CHANGELOG).
- npm scope создаётся отдельно через `npm login --scope=@mefodiy`
  (одноразовая операция вне репозитория).
- В `package.json` добавить `"publishConfig": {"access":
"public"}` — иначе scoped по умолчанию приватный.
- GitHub Actions workflow для публикации (если ещё нет — добавить
  стандартный для scoped public package).
- `NPM_TOKEN` secret должен иметь права на scope `@mefodiy`
  (создаётся в npmjs.com → Settings → Access Tokens).
- README — секция «Установка»: `npm install @mefodiy/n8n-nodes-max`.

**Acceptance:** `npm publish --dry-run` локально проходит;
после `git push origin master --follow-tags` пакет появляется на
[npmjs.com/package/@mefodiy/n8n-nodes-max](https://www.npmjs.com/package/@mefodiy/n8n-nodes-max).

---

## Что НЕ делается в этом плане

- Refactoring всего `Max.node.ts` под declarative routing — без
  явного payoff (AGENTS.md:91).
- Раскладка node parameters заново — точечные правки только в
  рамках конкретных операций.
- Mini Apps inline-кнопки — `open_app` уже поддержан.

## Подтверждение перед стартом

Перед запуском этапа 3 нужны ответы на `API_QUESTIONS.md`. Любой
неподтверждённый пункт остаётся в плане как «ожидает уточнения»
и не реализуется (AGENTS.md:148-151).

---

После вашего апрува — начинаю **этап 3** в порядке релизов
0.2.0 → 0.3.0 → … До апрува — **СТОП**.
