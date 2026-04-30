# Вопросы к dev.max.ru/docs-api

Этот документ — список конкретных пунктов, по которым нужны
точные контракты из [dev.max.ru/docs-api](https://dev.max.ru/docs-api),
чтобы стартовать этап 3 без догадок.

По каждому вопросу:

- **Что подтвердить** — ровно тот факт, который нужно зафиксировать.
- **Зачем** — на что влияет в плане / какой код будет писаться.
- **Fallback** — что делаем если ответ из docs не подтверждается
  (или фичу нельзя сделать).

Источник истины — docs (AGENTS.md:20). Что записано в
`@maxhub/max-bot-api` (npm) или в коде форка — справочно, не
авторитетно.

## Сводка ответов (2026-04-30)

Заказчик ответил на все вопросы под 0.2.0. Ниже — короткие
итоги; полные ответы в каждом §.

| §   | Тема                   | Решение                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Дедуп `update_id`      | **Поля нет.** Композитный ключ per update_type, TTL 12ч / 60с. Реализовано в `fc02c9f`.                                                                                                                                           |
| 2   | Webhook ретраи MAX     | 10 попыток ×2.5 (60→150→375→…), 30s timeout, auto-unsubscribe 8ч → §12.2 IMPROVEMENT_PLAN, 0.4.0.                                                                                                                                 |
| 3   | Pin/Unpin              | `PUT /chats/{chatId}/pin` / `DELETE /chats/{chatId}/pin`. + `GET /chats/{chatId}/pin` опционально. Permission `pin_message`, только групп. чаты.                                                                                  |
| 4   | Forward                | Отдельного endpoint **нет**. `POST /messages?chat_id={target}` с body `{link: {type: forward, message_id}}`.                                                                                                                      |
| 5   | Copy                   | **Откладываем на 0.5.0** — нет атомарной операции.                                                                                                                                                                                |
| 6   | Edit chat              | `PATCH /chats/{chatId}` с `title`, `icon.url` (URL only, не upload), `notify`. `description` — попробуем. Permission `change_chat_info`, только групп. чаты.                                                                      |
| 7   | Send action            | `POST /chats/{chatId}/actions {action}`. Enum: `typing_on`, `sending_photo`, `sending_video`, `sending_audio`, `sending_file`, `mark_seen`. README-сноска: typing_on может не показываться визуально — поведение клиента, не баг. |
| 8   | Members                | Будет в 0.4.0, контракты сверим перед стартом.                                                                                                                                                                                    |
| 9   | Subscriptions explicit | Будет в 0.5.0.                                                                                                                                                                                                                    |
| 10  | Bot info               | Будет в 0.5.0.                                                                                                                                                                                                                    |
| 11  | Long-polling           | Будет в 0.3.0.                                                                                                                                                                                                                    |

**Дополнительные находки** (зафиксированы в IMPROVEMENT_PLAN.md
§12 «Технический долг»):

- Rate limit **30 RPS** на platform-api.max.ru → handling 429 +
  Retry-After (§12.1, → 0.4.0 перед members).
- Webhook retry policy + auto-unsubscribe (§12.2, → 0.4.0).
- `photo` тип удалён в API, везде `image` (§12.3, → 0.5.0).
- `console.log` в `GenericFunctions.ts` (§12.4, → 0.5.0).
- 14 `update_type` (сейчас в коде 11) (§12.5, → 0.5.0).
- `secret` header `X-Max-Bot-Api-Secret` (§12.6, → 0.5.0).

---

## 1. Дедупликация: гарантирует ли API уникальный `update_id`?

**Что подтвердить:**

- Поле `update_id` присутствует во **всех** типах update'ов
  (`message_created`, `message_callback`, `bot_added`,
  `chat_title_changed` и т.д. — всех 11).
- Уникальность: монотонно растущий или просто уникальный?
- Может ли API доставить один и тот же `update_id` дважды?
  (для webhook это часто бывает — ретраи по timeout).

**Зачем:** §1 плана — дедуп. Если поля нет на каком-то типе —
для него дедуп будет работать по другому ключу (например,
`message.body.mid` для message\_\*, `callback_id` для callback).

**Fallback:** если у части update'ов `update_id` нет — делаем
композитный ключ `(update_type, message_id|callback_id|timestamp)`.
Логика дедупа сложнее, но работает.

---

## 2. Webhook ретраи: при каких условиях MAX повторяет доставку?

**Что подтвердить:**

- Если наш endpoint вернул не-2xx — повторяет ли MAX?
- Сколько попыток, какие интервалы?
- Сколько секунд таймаут на ответ?

**Зачем:** §1 плана — нам нужно понимать, насколько актуальна
дедупликация (1 повтор / 5 / бесконечно).

**Fallback:** если ретраев нет — дедуп всё равно полезен на
случай двойной подписки (две инстанции workflow на одном
вебхуке) и race-conditions при апдейте подписки.

---

## 3. Pin / Unpin сообщений

**Что подтвердить:**

- Точные пути endpoints. Варианты: `PUT /chats/{chatId}/pin`
  с body `{message_id, notify}` или
  `POST /chats/{chatId}/pin/{messageId}`.
- Метод unpin — `DELETE /chats/{chatId}/pin` или с message_id?
- Поддерживается ли несколько закреплённых сообщений?
- Поле `notify` (рассылать ли уведомление о закреплении) —
  существует ли?

**Зачем:** §3 плана — две операции, точные пути влияют на
сигнатуру helper'ов в `GenericFunctions.ts`.

**Fallback:** если pin делается через `POST /chats/{chatId}/pin`
с body — переименовать query → body параметры в helper.
Если параметра `notify` нет — выкинуть из UI.

---

## 4. Forward message

**Что подтвердить:**

- Точный синтаксис. Гипотезы:
  - `POST /messages?chat_id=<target>&forward_message_id=<mid>` (query).
  - `POST /messages` с body `{forward: {chat_id, message_id}}`.
- Можно ли форвардить с/без подписи (`disable_notification`,
  `caption`)?
- Поддерживается ли target = `user_id` (личка) и `chat_id`
  (группа) одновременно?

**Зачем:** §4 плана. От этого зависит UI и helper.

**Fallback:** если только `chat_id` — UI без user_id. Если
форвард только query-шным id — без body.

---

## 5. Copy message — есть ли он?

**Что подтвердить:**

- Существует ли `copyMessage` в API (`POST /messages?copy_id=...`
  или подобное)?
- Если нет — есть ли другой способ повторить сообщение с
  переотправкой attachments (e.g. через переиспользование
  attachment.token)?

**Зачем:** в плане эта операция помечена как **гейт от docs**.

**Fallback:** если copy в API нет — операцию не делаем и удаляем
из плана (или реализуем через get + send в отдельной утилите,
но **только** если получится без двух retransfer'ов).

---

## 6. Edit chat (title / icon / description)

**Что подтвердить:**

- Метод и путь: `PATCH /chats/{chatId}` или `PUT /chats/{chatId}`?
- Какие поля редактируемы? Точно — `title`, `description`. Иконка:
  - `icon_url` (передаётся URL картинки), или
  - `icon` через двух-этапную загрузку (как у attachments)?
- Есть ли возрастные/иные ограничения на title/description (длина,
  допустимые символы)?

**Зачем:** §5 плана. От ответа зависит UI (текстовое поле
`iconUrl` vs binary upload) и валидация длин.

**Fallback:** если иконка только через upload — в первой версии
иконку **не реализуем**, делаем title+description, об иконке
пишем «coming soon».

---

## 7. Send action

**Что подтвердить:**

- Путь: `POST /chats/{chatId}/actions` или `POST /actions?chat_id=`?
- Какие конкретно `action`-значения поддержаны? Кандидаты:
  - `typing_on`
  - `sending_photo`, `sending_video`, `sending_audio`, `sending_file`
  - `mark_seen`
- Есть ли `typing_off` или typing сбрасывается само через timeout?
- Долго ли держится typing-indicator (5 сек обычно у Telegram)?

**Зачем:** §6 плана. Прямо влияет на enum в UI ноды.

**Fallback:** если поддержан только `typing_on` — сократить enum.
Если в UI пользователь хочет «typing 5 sec», и API сам сбрасывает —
ничего не делаем после вызова. Иначе — нужна отдельная операция
«stop typing».

---

## 8. Members management

### 8.1. Pagination для `getMembers` / `getAdmins`

**Что подтвердить:**

- Параметр пагинации — `marker`, `offset`, `cursor`?
- Поле курсора в ответе — где его искать (`marker`, `next_marker`,
  внутри `pagination`)?
- Лимит на `limit` (max page size).

**Зачем:** §8.1, §8.2. UI должен давать `limit` + `marker`.

**Fallback:** если пагинации нет — fetched всё одним запросом,
параметра `marker` в UI нет.

### 8.2. Batch для `removeMembers` / `addMembers`

**Что подтвердить:**

- Принимает ли API массив `user_ids` за один вызов или нужно
  по одному `userId`?
- Если по одному — стоит ли в helper'е делать loop с rate-limit?

**Зачем:** §8.3, §8.4. Влияет на семантику UI («один за раз» vs
«массив»).

**Fallback:** если только по одному — UI принимает один user_id,
для batch пользователь делает Loop в n8n.

### 8.3. set_admin permissions

**Что подтвердить:**

- Поддерживает ли `set_admin` fine-grained permissions
  (моги́ ли пользователю выдать только «pin messages», но не
  «add members»)?
- Какие конкретно permissions есть в docs?

**Зачем:** §8.5. Если есть permissions — UI с чек-боксами; нет —
просто toggle админ/не-админ.

**Fallback:** если permissions нет — UI без них; флаг
`is_admin: true/false`.

---

## 9. Subscriptions explicit ops

**Что подтвердить:**

- Возвращает ли `GET /subscriptions` массив или объект
  `{subscriptions: [...]}`?
- Какие поля есть в каждой подписке (url, update_types, secret,
  version, **created_at**)?
- При `DELETE /subscriptions?url=` — точное совпадение URL или
  допускается частичное?

**Зачем:** §9 плана. От shape ответа зависит mapping в node output.

**Fallback:** если поля created_at нет — не показываем в выводе.

---

## 10. Bot info — `set_my_info`

**Что подтвердить:**

- Метод: `PATCH /me` или `PUT /me`?
- Какие поля редактируемы?
  - `name` (имя бота, видное в чатах)
  - `description` (текст в карточке бота)
  - `username` (короткое имя — обычно зарезервировано)
  - `commands` (список / у Telegram это setMyCommands)
- Идемпотентен ли `set` (можно ли отправлять только меняющиеся
  поля)?

**Зачем:** §10 плана. UI ноды `setMyInfo` будет раскладывать
доступные поля.

**Fallback:** если `username` менять нельзя — выкинуть из UI.
Если `commands` через отдельный endpoint — отдельная операция
позже.

---

## 11. Long-polling: `GET /updates`

**Что подтвердить:**

- Все ли 11 типов update'ов отдаются через long-polling, или
  webhook-only?
- Есть ли разница в shape между webhook-update и polling-update
  (ключи, обёртки)?
- Можно ли держать одновременно webhook-подписку и polling? Если
  да — кому достаётся update?
- Максимальное значение `timeout` (мы планируем 30 сек, безопасно
  ли 60)?

**Зачем:** §7 плана. Полностью определяет, можно ли вообще
сделать polling-trigger как полноценную замену webhook.

**Fallback:** если polling отдаёт **не все** типы — в UI
polling-ноды показываем только поддержанные events с пометкой
«доступно только в webhook-trigger».

---

## Формат ответа

Можно отвечать прямо в этом файле — добавляйте под каждым
вопросом блок:

```markdown
**Ответ:** <текст>
**Источник:** <ссылка на конкретный раздел dev.max.ru/docs-api>
**Решение:** <что делаем>
```

Если по какому-то вопросу docs молчит — пишем «не подтверждено,
переходим в fallback» и фиксируем какой fallback взяли.
