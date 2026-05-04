# @mefodiytr/n8n-nodes-max

[![npm version](https://img.shields.io/npm/v/@mefodiytr/n8n-nodes-max?logo=npm)](https://www.npmjs.com/package/@mefodiytr/n8n-nodes-max)

## Это форк

Это расширенная версия [n8n-nodes-max](https://github.com/pfrankov/n8n-nodes-max) от Павла Франкова. Спасибо ему за отличную базу.

Что добавлено в 0.2.0:

- Дедупликация webhook-событий (защита от двойной доставки)
- Перевод логирования с `console.log` на n8n logger
- Pin / Unpin сообщений
- Forward сообщений между чатами
- Edit chat (название, иконка, описание)
- Send action (`typing_on` и др. индикаторы)

Что добавлено в 0.3.0:

- Новая нода `Max Polling Trigger` — long-polling-альтернатива webhook'у для сред без публичного HTTPS endpoint

Что планируется в 0.4.0+: members management, rate limit handling (429 + Retry-After), subscriptions / bot info ops.

---

Нода для интеграции мессенджера Max с платформой автоматизации n8n.

<img width="518" height="429" alt="image" src="https://github.com/user-attachments/assets/577165bb-510f-4523-b898-76ea94dc0f2b" />

## Установка

### Для self-hosted n8n

1. Установите пакет через npm в директории n8n:

```bash
npm install @mefodiytr/n8n-nodes-max
```

2. Перезапустите n8n для загрузки новой ноды

### Для n8n Cloud

1. Откройте настройки вашего workspace
2. Перейдите в раздел "Community nodes"
3. Нажмите "Install a community node"
4. Введите `@mefodiytr/n8n-nodes-max` и нажмите "Install"

### Альтернативный способ (переменная окружения)

Добавьте пакет в переменную окружения:

```bash
export N8N_CUSTOM_EXTENSIONS=@mefodiytr/n8n-nodes-max
```

**Полезные ссылки:**

- [Официальная документация по установке community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)
- [Руководство по self-hosted установке](https://docs.n8n.io/hosting/)

## Для разработки

- После `npm install` автоматически устанавливается Husky pre-commit hook.
- Перед коммитом запускается Prettier для staged исходников (`*.{ts,js,mjs,cjs,json,md,yml,yaml}`).

## Релиз

1. Подготовьте изменения и закоммитьте их обычным git-коммитом.
2. Выберите semver-тип релиза и создайте commit+tag командой `npm version patch`, `npm version minor` или `npm version major`.
3. Запушьте ветку и теги командой `git push origin master --follow-tags`.
4. GitHub Actions опубликует пакет в npm по пушу тега `v*.*.*`.

Для автопубликации в репозитории должен быть настроен секрет `NPM_TOKEN`.

## Возможности

### Сообщения

- Отправка текстовых сообщений с форматированием
- Автоматический fallback в plain text при ошибке Max API о неподдерживаемом Markdown
- Редактирование и удаление сообщений
- Для `Edit Message` нода отправляет `message_id` в query-параметре запроса `PUT /messages?message_id=...`
- В `Edit Message` опция `Clear Attachments` удаляет текущие вложения сообщения, включая inline-клавиатуру
- Отправка файлов (изображения, видео, аудио, документы)
- Для вложений в `Send Message` доступны три источника: `Binary Data`, `URL` и готовый `Token` MAX
- В `Send Message` текст не обязателен, если отправляются вложения
- Нода не ограничивает вложения по расширению файла: формат проверяется на стороне Max API
- Payload вложения зависит от типа файла: для `image` используются поля из JSON-ответа upload-шага (`token`/`photos`/`url`), для `file` используется `token` из upload-ответа, а для `video`/`audio` нода также поддерживает токен из `POST /uploads`, если upload endpoint возвращает `retval`
- Если у вас уже есть `payload.token` из Max API, выберите `Attachment Source = Token`: нода отправит вложение без повторного скачивания и upload
- Автоматический ретрай отправки с медиа-вложением при временной ошибке `attachment.not.ready`
- Явная валидация ID получателя: `0` отклоняется с подсказкой по полям из `Max Trigger`
- Интерактивные клавиатуры с кнопками
- **Pin / Unpin Message** — закрепление и открепление сообщения в групповом чате (`PUT/DELETE /chats/{chatId}/pin`); параметр `Notify Members` контролирует, рассылать ли уведомление участникам
- **Forward Message** — пересылка существующего сообщения в другой чат (`POST /messages?chat_id=` с body `{link: {type: forward, message_id}}`)

### Чаты

- Получение информации о чате
- Выход из групповых чатов
- **Edit Chat** — обновление title / description / icon (только для групповых чатов; иконка задаётся URL'ом, MAX скачивает её сам)
- **Send Action** — отправка индикаторов активности бота (`typing_on`, `sending_photo/video/audio/file`, `mark_seen`); парного `typing_off` в API нет — клиент сам гасит индикатор по таймауту, и иногда `typing_on` возвращает 200 OK без визуального индикатора (поведение клиента, не баг)

### Триггеры

В пакете две ноды-триггера. Выбор зависит от того, есть ли у n8n публичный HTTPS endpoint.

#### `Max Trigger` (webhook)

- Получение событий в реальном времени:
  - Новые сообщения в личных диалогах (`message_created`) и чатах (`message_chat_created`)
  - Нажатия на кнопки
  - События чатов
- Поддержка webhook URL с интернационализированными доменами (IDN/Punycode) для корректной TLS-валидации
- **Дедупликация webhook'ов**: при ретрае MAX или гонке при апдейте подписки workflow запускается ровно один раз. Ключ строится по `update_type` (см. ниже), состояние хранится в `getWorkflowStaticData('node')`, TTL 12 часов для известных типов и 60 секунд для неизвестных
- **Логирование**: события триггера и lifecycle подписки идут через `this.logger` (`debug`/`info`/`error`), а не `console.log` — удобно фильтровать через стандартные средства n8n

#### `Max Polling Trigger` (long-polling)

Альтернатива webhook'у для сред без публичного HTTPS endpoint (закрытые сети, локальный n8n без проброса наружу).

- Использует `GET /updates?marker=&timeout=&limit=` — соединение держится до 90 секунд, новые события приходят как только появляются
- Marker (курсор) хранится в `getWorkflowStaticData('global')['maxPollingMarker']` и переживает рестарт workflow
- Backoff на временных ошибках: `1 → 2 → 4 → 8 → 16 → 30` секунд, сбрасывается на первом успешном запросе
- На `401 Unauthorized` — останавливает polling и пишет error в лог (auto-restart бесполезен без новых credentials)
- Дедупликация по composite key (та же логика, что в webhook-триггере) — secondary safety net на случай потери marker'а при рестарте
- **Webhook и polling взаимоисключающие** (ограничение MAX API): при активной webhook-подписке polling вернёт 0 update'ов. Параметр `Force Unsubscribe Webhooks on Activate` управляет поведением при активации:
  - `false` (по умолчанию) — если подписки есть, нода падает с понятной ошибкой и инструкцией
  - `true` — нода удаляет все активные подписки перед стартом polling

##### Когда использовать polling vs webhook

| Условие                                               | Выбор                              |
| ----------------------------------------------------- | ---------------------------------- |
| n8n доступен по публичному HTTPS                      | Webhook (быстрее, меньше нагрузки) |
| n8n за NAT / в VPN / без публичного DNS               | **Polling**                        |
| Нужна работа в разработке без `ngrok` / туннелей      | **Polling**                        |
| Один воркспейс — несколько workflow на ту же подписку | Webhook                            |
| Latency критична (ms-уровень)                         | Webhook                            |

## Настройка

1. Создайте бота через @PrimeBot в Max мессенджере
2. Получите токен доступа
3. Добавьте токен в настройки ноды в n8n

## Быстрый старт

### Отправка сообщения

1. Добавьте ноду Max в workflow
2. Выберите операцию "Send Message"
3. Укажите ID получателя; при необходимости добавьте текст
4. Чтобы отправить только файл/медиа, оставьте `Message Text` пустым и добавьте вложение в `Additional Fields → Attachments`
5. Чтобы переиспользовать уже загруженный файл, выберите `Additional Fields → Attachments → Attachment Source = Token` и вставьте `File Token`
6. Запустите workflow

### Удаление inline-кнопок при редактировании

1. Выберите операцию `Edit Message`
2. Укажите `Message ID` и новый текст
3. Включите `Clear Attachments`, чтобы Max API получил `attachments: []` и удалил текущую inline-клавиатуру

### Получение сообщений (webhook)

1. Добавьте ноду Max Trigger
2. Настройте webhook
3. Выберите типы событий для отслеживания

### Получение сообщений (long-polling)

1. Добавьте ноду `Max Polling Trigger`
2. Выберите типы событий
3. При первой активации — если есть активные webhook-подписки, либо деактивируйте все `Max Trigger` workflows, либо включите `Force Unsubscribe Webhooks on Activate`

## Ресурсы

- [Документация Max Bot API](https://dev.max.ru/docs-api)
- [GitHub репозиторий](https://github.com/pfrankov/n8n-nodes-max)

## Лицензия

[MIT](LICENSE.md)
