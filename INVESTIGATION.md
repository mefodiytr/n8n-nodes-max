# Исследование форка n8n-nodes-max

Дата: 2026-04-30. Версия в репо: `0.1.21`.

Источник истины по API — [dev.max.ru/docs-api](https://dev.max.ru/docs-api).
Этот документ описывает **то, что реально реализовано в форке**, и
сравнивает с поверхностью официального API.

Соглашение по ссылкам: `path/to/file.ts:NN` (строки).

## 1.1 Структура и стиль

### Тип маршрутизации

**Programmatic execute()**, без declarative routing. Главный
обработчик — большой switch по `resource` × `operation` в
`nodes/Max/Max.node.ts:912-1303`. Все операции дальше делегируют в
helpers из `GenericFunctions.ts`.

```
resource ∈ {message, chat}
operation message  ∈ {sendMessage, editMessage, deleteMessage, answerCallbackQuery}
operation chat     ∈ {getChatInfo, leaveChat}
```

### Версии (`package.json`)

| Поле                  | Значение                                                        |
| --------------------- | --------------------------------------------------------------- |
| `engines.node`        | `>=20.15` (`package.json:18`)                                   |
| `n8n-workflow`        | `*` (peer dep, `package.json:69-70`)                            |
| TypeScript            | `^5.9.3` (`package.json:64`)                                    |
| `@maxhub/max-bot-api` | `^0.2.2` — единственная runtime-зависимость (`package.json:67`) |
| Jest / ts-jest        | `^30.3.0` / `^29.4.9`                                           |
| ESLint                | `^9.39.4` + `eslint-plugin-n8n-nodes-base`                      |

`@n8n/node-cli` **не используется** — вместо него `tsc + gulp` для
сборки иконок и линт через `eslint-plugin-n8n-nodes-base`.

### Где лежат типы MAX API

- `nodes/Max/IEvent.ts` — основные интерфейсы webhook-событий:
  `IMaxUser`, `IMaxChat`, `IMaxMessage`, `IMaxCallback`. Покрывают
  входные структуры триггера.
- Типы для **отправки** (тело POST/PUT) сосредоточены в
  `GenericFunctions.ts` локально внутри функций — отдельного
  `types.ts` для исходящих контрактов нет.

### Тесты и пороги покрытия

`jest.config.js:31-37` enforced thresholds:

| Метрика    | Порог  |
| ---------- | ------ |
| branches   | 88.54% |
| functions  | 98.78% |
| lines      | 92.89% |
| statements | 92.71% |

Тесты лежат в `nodes/Max/tests/` и `credentials/tests/` —
детальный список в §1.7.

## 1.2 Карта 17 узлов (UI)

В UI ноды отображаются 6 действий и 11 событий. **Это операции
внутри двух нод** (`Max` и `Max Trigger`), а не 17 отдельных нод.

### 6 Actions (`nodes/Max/Max.node.ts`)

| UI                      | resource/operation            | Файл:строки                                   | MAX endpoint                              | Описание                                                                           |
| ----------------------- | ----------------------------- | --------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Send a message          | `message/sendMessage`         | UI: `Max.node.ts:93-117`; execute: `912-1083` | `POST /messages?user_id=` или `?chat_id=` | Текст ≤4000, attachments (binary/url/token), inline-клавиатура                     |
| Edit a message          | `message/editMessage`         | UI: `99-117`; execute: `1084-1139`            | `PUT /messages?message_id=`               | Меняет text + attachments + клавиатуру; `Clear Attachments` шлёт `attachments: []` |
| Delete a message        | `message/deleteMessage`       | UI: `105-108`; execute: `1140-1164`           | `DELETE /messages?message_id=`            | Удаление сообщения, отправленного ботом                                            |
| Answer a callback query | `message/answerCallbackQuery` | UI: `111-115`; execute: `1165-1195`           | `POST /answers?callback_id=`              | Уведомление по нажатию inline-кнопки (toast / popup)                               |
| Get chat info           | `chat/getChatInfo`            | UI: `872-875`; execute: `1204-1237`           | `GET /chats/{chatId}`                     | Метаданные чата                                                                    |
| Leave a chat            | `chat/leaveChat`              | UI: `877-880`; execute: `1238-1271`           | `DELETE /chats/{chatId}/members/me`       | Бот выходит из чата                                                                |

### 11 Triggers (`nodes/Max/MaxTriggerConfig.ts`)

Реестр событий и `update_type` для подписки в
`MAX_TRIGGER_EVENTS` (`MaxTriggerConfig.ts:7-19`).

| UI                        | `update_type`          | Файл:строки | Описание                           |
| ------------------------- | ---------------------- | ----------- | ---------------------------------- |
| Bot Added To Chat         | `bot_added`            | `34`        | Бота добавили в чат                |
| Bot Removed From Chat     | `bot_removed`          | `39`        | Бота удалили из чата               |
| Bot Started               | `bot_started`          | `44`        | Пользователь нажал «Старт» в личке |
| Button Clicked            | `message_callback`     | `49`        | Нажатие inline-кнопки              |
| Chat Title Changed        | `chat_title_changed`   | `54`        | Название чата изменили             |
| Message Deleted           | `message_removed`      | `59`        | Сообщение удалено                  |
| Message Edited            | `message_edited`       | `64`        | Сообщение отредактировано          |
| Message Received (Chat)   | `message_chat_created` | `69`        | Сообщение в групповом чате         |
| Message Received (Direct) | `message_created`      | `74`        | Личное сообщение                   |
| User Joined Chat          | `user_added`           | `79`        | Пользователь зашёл в чат           |
| User Left Chat            | `user_removed`         | `84`        | Пользователь вышел                 |

## 1.3 Inline-клавиатуры

Поддерживается **6 типов кнопок**, многорядная разметка, клавиатура
доступна и при Send, и при Edit Message.

### Поддерживаемые типы

| Тип                    | Где собирается                  | Назначение                                           |
| ---------------------- | ------------------------------- | ---------------------------------------------------- |
| `callback`             | `GenericFunctions.ts:1893-1895` | Отправляет payload боту → событие `message_callback` |
| `link` (open URL)      | `GenericFunctions.ts:1897-1899` | Открывает ссылку                                     |
| `request_contact`      | `Max.node.ts:442-450`           | Запрос контакта пользователя                         |
| `request_geo_location` | `Max.node.ts:447-450`           | Запрос геолокации                                    |
| `chat`                 | `Max.node.ts:427-505`           | Создать/перейти в чат из кнопки                      |
| `open_app`             | `Max.node.ts:437-440`           | Открыть Mini App                                     |

### Многорядная разметка

`buttons` — двумерный массив: `buttons[row][col]`. Лимиты в
`KEYBOARD_LIMITS` (`GenericFunctions.ts:1567-1578`):

| Параметр                           | Значение                               |
| ---------------------------------- | -------------------------------------- |
| `MAX_ROWS`                         | 30                                     |
| `MAX_BUTTONS_PER_ROW`              | 7                                      |
| `MAX_LIMITED_TYPE_BUTTONS_PER_ROW` | 3 (для `link/chat/open_app/request_*`) |
| `MAX_BUTTON_TEXT`                  | 128 символов                           |

Валидатор: `validateKeyboardLayout` (`GenericFunctions.ts:1804-1868`),
`validateKeyboardButton` (`1617-1620` — text length).

### Edit Message

Полная конфигурация inline keyboard для editMessage —
`Max.node.ts:615-802`. Те же 6 типов кнопок и валидация.

### Где формируется `attachments[type=inline_keyboard]`

- Из `additionalFields`: `processKeyboardFromAdditionalFields`
  (`GenericFunctions.ts:2046-2089`).
- Из `parameters`: `processKeyboardFromParameters`
  (`GenericFunctions.ts:1981-2034`). Эти две функции почти
  идентичны — кандидат на объединение (см. §1.6).
- Финальный шейп: `formatInlineKeyboard` (`1943-1950`) — добавляет
  `{type: "inline_keyboard", payload: { buttons }}` в `attachments`.

## 1.4 Trigger через webhook

### Subscribe / Unsubscribe

`nodes/Max/MaxWebhookManager.ts`:

- **`POST /subscriptions`** — `createSubscription` (`230-238`).
  Тело запроса формируется в `getSubscriptionPayload` (`208-228`):
  ```json
  {
    "url": "<webhook_url, punycode>",
    "update_types": ["bot_started", "message_created", ...],
    "secret":  "<X-Max-Bot-Api-Secret>",   // optional
    "version": "0.0.1"                     // optional
  }
  ```
- **`DELETE /subscriptions?url=...`** — `deleteSubscription`
  (`244-261`). Вызывается из `delete()` (`132-162`) — это
  стандартный n8n-хук на деактивацию workflow.
- **`GET /subscriptions`** — `getSubscriptions` (`187-201`),
  используется в `checkExists` чтобы понимать создавать или нет.

### URL и punycode

URL вебхука нормализуется в Punycode/ASCII перед отправкой —
`toPunycodeUrl` (`MaxWebhookManager.ts:9-17`) через `URL` +
`domainToASCII()`. Сделано чтобы избежать TLS-проблем у IDN-доменов
(см. AGENTS.md:49).

### Дедупликация `update_id`

**НЕ реализована.** В `MaxEventProcessor.ts` нет хранилища
обработанных `update_id` — ни in-memory, ни через
`getWorkflowStaticData`, ни через БД. При двойной доставке (или
ретрае на стороне MAX) триггер сработает дважды. Это известный
риск в n8n community-нодах для мессенджеров и кандидат на
исправление (см. IMPROVEMENT_PLAN.md).

Что делает `MaxEventProcessor`:

- Валидация структуры события под `update_type`
  (`MaxEventProcessor.ts:259-429`).
- Нормализация в `normalizedData` для удобной работы дальше
  по workflow.
- Per-event фильтры (от кого, в каком чате и т.п.).

## 1.5 MAX Bot API vs нода

Сравнение с разделами [dev.max.ru/docs-api](https://dev.max.ru/docs-api).
Колонка «Приоритет» — наша оценка ценности для типового workflow
автоматизации в n8n.

### Messages

| Метод           | Реализовано? | Файл:строки                                            | Приоритет | Заметка                                          |
| --------------- | ------------ | ------------------------------------------------------ | --------- | ------------------------------------------------ |
| send            | ✅           | `Max.node.ts:922-1083`; `GenericFunctions.ts:343-443`  | —         | Текст / attachments / клавиатура                 |
| edit            | ✅           | `Max.node.ts:1084-1139`; `GenericFunctions.ts:460-568` | —         | `message_id` в query (см. AGENTS.md:56)          |
| delete          | ✅           | `Max.node.ts:1140-1164`; `GenericFunctions.ts:583-615` | —         | DELETE /messages                                 |
| answer_callback | ✅           | `Max.node.ts:1165-1195`; `GenericFunctions.ts:631-680` | —         | POST /answers                                    |
| **pin**         | ❌           | —                                                      | **high**  | Часто нужен в инцидент-флоу и онбордингах        |
| **unpin**       | ❌           | —                                                      | **high**  | Парный с pin                                     |
| **forward**     | ❌           | —                                                      | **high**  | Перенаправлять важные сообщения в каналы/команды |
| **copy**        | ❌           | —                                                      | medium    | Реже нужен; зависит от поддержки в API           |

### Chats

| Метод           | Реализовано? | Файл:строки                                              | Приоритет | Заметка                           |
| --------------- | ------------ | -------------------------------------------------------- | --------- | --------------------------------- |
| get_chat        | ✅           | `Max.node.ts:1204-1237`; `GenericFunctions.ts:1722-1754` | —         | GET /chats/{chatId}               |
| leave_chat      | ✅           | `Max.node.ts:1238-1271`; `GenericFunctions.ts:1768-1793` | —         | DELETE /chats/{chatId}/members/me |
| **edit_chat**   | ❌           | —                                                        | **high**  | Title / icon / description        |
| **send_action** | ❌           | —                                                        | **high**  | typing-indicator → лучший UX      |

### Members

Полностью отсутствует. Все шесть операций — приоритет **high** для
сценариев модерации/онбординга:

| Метод          | Реализовано? | Приоритет |
| -------------- | ------------ | --------- |
| get_members    | ❌           | high      |
| get_admins     | ❌           | high      |
| add_members    | ❌           | high      |
| remove_members | ❌           | high      |
| set_admin      | ❌           | high      |
| remove_admin   | ❌           | high      |

### Subscriptions

| Метод                                    | Реализовано? | Файл:строки                    | Приоритет | Заметка                                  |
| ---------------------------------------- | ------------ | ------------------------------ | --------- | ---------------------------------------- |
| subscribe                                | ✅ внутренне | `MaxWebhookManager.ts:230-238` | —         | Триггер сам подписывается                |
| unsubscribe                              | ✅ внутренне | `MaxWebhookManager.ts:244-261` | —         | На деактивации workflow                  |
| get_subscriptions                        | ✅ внутренне | `MaxWebhookManager.ts:187-201` | —         | Используется для checkExists             |
| **Явные операции** для пользователя ноды | ❌           | —                              | medium    | Полезны для отладки и ручного управления |

### Bot

| Метод       | Реализовано? | Приоритет | Заметка                   |
| ----------- | ------------ | --------- | ------------------------- |
| get_my_info | ❌           | medium    | Healthcheck               |
| set_my_info | ❌           | medium    | Имя / описание / username |

### Uploads

| Метод         | Реализовано? | Файл:строки                     | Заметка                               |
| ------------- | ------------ | ------------------------------- | ------------------------------------- |
| photo (image) | ✅           | `GenericFunctions.ts:1258-1369` | Двух-этап `POST /uploads` → multipart |
| video         | ✅           | `1258-1369`                     | Двух-этап                             |
| audio         | ✅           | `1258-1369`                     | Двух-этап                             |
| file          | ✅           | `1258-1369`                     | Двух-этап                             |

Двух-этапная загрузка работает по contracts из AGENTS.md:50-51:
для `image` ответ имеет `token/url/photos`, для `file` — `token`,
для `video/audio` — два варианта (`token` или `retval` после
multipart). Retry на `attachment.not.ready` —
`GenericFunctions.ts:425-434`, задержки
`ATTACHMENT_READY_RETRY_DELAYS_MS = [700, 1500, 3000]`
(`GenericFunctions.ts:16`).

## 1.6 Качество кода

### Дублирование

- `processKeyboardFromAdditionalFields` (`GenericFunctions.ts:2046-2089`)
  vs `processKeyboardFromParameters` (`1981-2034`) — почти
  одинаковая логика разбора клавиатуры под две UI-формы.
- `validateInputParameters` (`983-1039`) и `validateAndFormatText`
  (`693-734`) пересекаются по проверкам text/format.
- Лимит 4000 проверяется и в `validateAndFormatText:695-696`, и
  внутри `validateInputParameters`.

### Magic strings

- Базовый URL: `DEFAULT_MAX_BASE_URL` — `GenericFunctions.ts:15`.
- Список событий триггера: `MAX_TRIGGER_EVENTS`
  (`MaxTriggerConfig.ts:7-19`) — литералы централизованы, ок.
- Лимиты: `FILE_SIZE_LIMITS` (`GenericFunctions.ts:1118-1123`),
  `KEYBOARD_LIMITS` (`1567-1578`) — собраны в константах, ок.
- Endpoint-строки в `apiRequest` разбросаны по местам вызовов —
  отдельных констант для путей нет (`/messages`, `/chats/...`,
  `/answers`, `/subscriptions`, `/uploads`).

### Error handling

- Категоризация: `categorizeMaxError`
  (`GenericFunctions.ts:772-840`) + `createUserFriendlyErrorMessage`,
  `handleMaxApiError`. Покрыты 429, 5xx, network errors.
- Retry на `attachment.not.ready` /
  `errors.process.attachment.file.not.processed` —
  `isAttachmentNotReadyError` (`137-144`), задержки
  `[700, 1500, 3000]` ms (`16`).
- Markdown fallback: при ошибке парсинга markdown в send/edit
  ретрай как plain text (см. AGENTS.md:55).

### Лимит 4000 символов

Enforced в `validateAndFormatText` (`GenericFunctions.ts:695-696`).
Описание лимита — в UI-параметре (`Max.node.ts:187`).

### Логирование

`console.log` используется в:

- `MaxWebhookManager.ts`: строки `43, 53, 57, 86, 97, 101, 116, 119, 138, 151, 153, 159`.
- `MaxEventProcessor.ts`: строки `85, 89, 96, 100, 109, 119, 200, 236`.

`this.logger` (рекомендованный в n8n) **не используется**.

## 1.7 Тестовое покрытие

Файлы в `nodes/Max/tests/` и `credentials/tests/`:

| Файл                         | Размер  | Что проверяется                                                                                                       |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `GenericFunctions.test.ts`   | 81 KiB  | Текст/формат, валидация клавиатур, формирование inline_keyboard, send/edit/delete/answer, attachments, error handling |
| `MaxEventProcessor.test.ts`  | 69 KiB  | Все 11 типов событий: `processEventSpecificData`, `passesAdditionalFilters`, `validateEventPayload`, нормализация     |
| `Max.node.test.ts`           | 22 KiB  | `execute()` под все 6 действий, валидация параметров                                                                  |
| `MaxWebhookManager.test.ts`  | 14 KiB  | `checkExists`/`create`/`delete`, payload подписки, punycode URL                                                       |
| `ErrorHandling.test.ts`      | 8.7 KiB | `categorizeMaxError`, `createUserFriendlyErrorMessage`, retry                                                         |
| `MaxTriggerConfig.test.ts`   | 4.9 KiB | Конфиг событий, валидация                                                                                             |
| `MaxTrigger.node.test.ts`    | 3.6 KiB | webhook-lifecycle на стороне ноды                                                                                     |
| `MaxApi.credentials.test.ts` | —       | credential test (`GET /me`)                                                                                           |

Coverage thresholds из `jest.config.js:31-37` — `branches 88.54 /
functions 98.78 / lines 92.89 / statements 92.71`. По AGENTS.md:114
понижать пороги нельзя.

## Сводно

**Сильные стороны:**

- Все 6 базовых message/chat-операций покрыты.
- 11 webhook-событий с детальной валидацией и нормализацией.
- Загрузка вложений двух-этапная, с retry на `attachment.not.ready`.
- 6 типов inline-кнопок и валидация лимитов.
- Punycode-нормализация URL вебхука.
- Тесты ~92% lines + строгие thresholds.

**Существенные пробелы (по приоритетам):**

| High                        | Medium                     | Low                       |
| --------------------------- | -------------------------- | ------------------------- |
| pin/unpin                   | Subscriptions explicit ops | copy message              |
| forward                     | Bot info get/set           | console.log → this.logger |
| edit_chat (title/icon/desc) | dedup `update_id`          | дедуп helpers keyboard    |
| send_action (typing)        |                            |                           |
| Members management ×6       |                            |                           |

Эти пробелы и составят план улучшений в `IMPROVEMENT_PLAN.md`.
