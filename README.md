# Umnico Diagnostic Bot

Локальный диагностический бот для Umnico на Node.js + Playwright.

В текущей версии бот работает только в `dryRun` режиме:
- сканирует список новых диалогов
- анализирует превью
- при необходимости открывает диалог
- читает последние сообщения
- сначала проверяет ownership rule по последнему исходящему сообщению менеджера
- считает score релевантности только если ownership rule разрешает обычный scoring pipeline
- отправляет часть слабых `SKIP`-чатов в `watchlist` для повторной оценки по cooldown
- пишет решение в консоль и `logs/log.txt`
- никогда не нажимает `#messaging-accept-dialog`

## Структура проекта

```text
package.json
README.md
config/config.json
data/seen.json
data/watchlist.json
logs/log.txt
src/main.js
src/state.js
src/selectors.js
src/scanner.js
src/filter.js
src/chatReader.js
src/logger.js
src/storage.js
src/watchlist.js
src/controls.js
src/utils.js
```

## Установка

1. Установить Node.js 18+.
2. Установить зависимости:

```bash
npm install
```

3. Если Chromium для Playwright ещё не установлен:

```bash
npx playwright install chromium
```

## Запуск

```bash
npm start
```

После запуска бот откроет Chromium в `headful` режиме с persistent profile из `data/browser-profile`.

## Первый вход в Umnico

1. Запустить `npm start`.
2. В открывшемся браузере вручную залогиниться в Umnico.
3. Открыть вкладку `Новые` вручную.
4. Вернуться в терминал.
5. Нажать `s`, чтобы запустить диагностическое сканирование.

Профиль браузера сохраняется между запусками, поэтому повторный логин обычно не нужен.

## Hotkeys

- `s` = start
- `p` = pause
- `r` = resume
- `t` = stop
- `q` = quit

## Что логируется

`logs/log.txt` хранит JSON-lines записи двух типов:
- `kind: "event"` для служебных предупреждений и состояния
- `kind: "decision"` для результата по каждому обработанному диалогу

Для `decision` пишутся:
- `timestamp`
- `dealId`
- `userName`
- `previewText`
- `sourcePreview`
- `sourceOpenChat`
- `lastMessages`
- `preliminaryScore`
- `finalScore`
- `decision`
- `ownershipDecision`
- `ownershipReason`
- `lastOutgoingManagerMessage`
- `scoringBypassed`
- `acceptButtonDetected`
- `watchlistStatus`
- `watchReason`
- `recheckAfterSeconds`
- `retryCount`
- scoring breakdown

## Ownership rules

В `config/config.json` есть блок `ownershipRules`:

```json
{
  "ownershipRules": {
    "enabled": true,
    "timezone": "Asia/Tbilisi",
    "dayBoundaryTime": "10:00",
    "currentUserName": "Your Name",
    "assistantNames": ["Assistant 1", "Assistant 2"]
  }
}
```

- `currentUserName`: имя текущего менеджера. Если последнее исходящее сообщение после boundary принадлежит этому имени, чат получает `ALLOW_FORCE_SELF`.
- `assistantNames`: список менеджеров, чьи чаты после boundary не блокируются ownership rule и продолжают обычный scoring pipeline.
- `dayBoundaryTime`: локальное время в таймзоне `ownershipRules.timezone`, после которого ownership rule начинает блокировать чужие активные чаты.

Результаты ownership rule:
- `ALLOW_NORMAL`: ownership rule не запрещает чат, поэтому включается обычный scoring pipeline.
- `ALLOW_FORCE_SELF`: последнее исходящее сообщение после boundary принадлежит `currentUserName`, поэтому чат помечается как мой и scoring bypassed.
- `BLOCK_BY_OWNER_RULE`: последнее исходящее сообщение после boundary принадлежит другому менеджеру, поэтому scoring bypassed и чат блокируется.

## Watchlist

В `config/config.json` есть блок:

```json
{
  "watchlist": {
    "enabled": true,
    "cooldownSeconds": 90,
    "ttlMinutes": 180,
    "maxRetries": 8
  }
}
```

- `watchlist` хранится отдельно в `data/watchlist.json`.
- `seen.json` содержит финально обработанные чаты.
- `watchlist.json` содержит слабые, но потенциально перспективные `SKIP`-чаты, которые надо пересмотреть позже.
- чат из `watchlist` повторно проверяется только если изменился `previewText`, изменился `timeText` или прошёл `cooldownSeconds`.
- если `expiresAt` истёк или превышен `maxRetries`, чат переводится в обычный финальный `SKIP`, удаляется из `watchlist` и попадает в `seen.json`.

Типичные `WATCH_RECHECK`-кейсы:
- `hello`
- `hi`
- `good afternoon`
- `добрый день`
- `??`
- `can i call`
- `available?`
- `price?`

## Как работает scoring

Scoring построен на сумме весов из `config/config.json`:
- `includeKeywords`: положительные ключевые слова и фразы
- `excludeKeywords`: отрицательные ключевые слова и фразы
- `sourceWeights`: веса по источнику

Пороги:
- `strongNegativeThreshold`
- `openCheckThreshold`
- `acceptCandidateThreshold`

Логика:
1. Сначала считается preliminary score по `previewText + sourcePreview`.
2. Если score сильно отрицательный и есть явные негативные ключи, бот ставит `SKIP_STRONG_NEGATIVE` без открытия чата.
3. Если чат выглядит потенциально релевантным или превью слишком короткое/неоднозначное, бот открывает чат.
4. После открытия бот строит stack-based `messageTimeline` из Umnico DOM.
5. Сначала применяется ownership rule по последнему исходящему сообщению менеджера.
6. Если ownership result = `ALLOW_NORMAL`, только тогда считается final score.
7. Выставляется одно из решений:
   - `FORCE_ACCEPT_SELF_CHAT`
   - `BLOCK_BY_OWNER_RULE`
   - `ACCEPT_CANDIDATE`
   - `OPEN_CHECK`
   - `WATCH_RECHECK`
   - `SKIP`
   - `SKIP_STRONG_NEGATIVE`

## Как менять веса

Открыть `config/config.json` и редактировать:

```json
{
  "includeKeywords": {
    "rent": 3,
    "booking": 2
  },
  "excludeKeywords": {
    "refund": -6,
    "vacancy": -5
  },
  "sourceWeights": {
    "whatsapp business api": 3,
    "telegram": 0
  }
}
```

Чем выше положительный вес, тем сильнее сигнал в пользу потенциального принятия.
Чем ниже отрицательный вес, тем сильнее сигнал в пользу пропуска.

## Важные ограничения текущей версии

- `dryRun` по умолчанию включён
- кнопка `#messaging-accept-dialog` только детектится, но не нажимается
- OCR не используется
- координатные клики не используются
- чтение идёт только через DOM Playwright и заданные селекторы
- `seen.json` автоматически не очищается
- `watchlist.json` автоматически создаётся и очищается только по TTL / retry policy
- временное отсутствие селектора логируется, но не валит весь цикл
- ошибка на одном чате не останавливает следующий

## Диагностический pipeline

1. Раз в `pollIntervalMs` считываются все `a.deals-row`.
2. Из каждой строки извлекаются `href`, `userName`, `previewText`, `sourcePreview`, `timeText`.
3. Уже обработанные `href` из `data/seen.json` пропускаются сразу.
4. Для `watchlist`-чатов сначала проверяется expiration policy, затем cooldown/change policy.
5. Если `watchlist`-чат не изменился и cooldown ещё не прошёл, он не переобрабатывается в этом цикле.
6. Считается preliminary score.
7. При необходимости бот открывает диалог.
8. После открытия ждёт `.im-history`.
9. Строит `messageTimeline` по `.im-stack` и определяет `incoming/outgoing` только по классу stack.
10. Считывает источник по `.im-source-item`.
11. Проверяет ownership rule по последнему `outgoing` сообщению менеджера.
12. Если ownership result = `ALLOW_NORMAL`, считает final score; если `ALLOW_FORCE_SELF` или `BLOCK_BY_OWNER_RULE`, scoring bypassed.
13. Если итоговый `SKIP` попадает под watchlist-heuristics, бот пишет `WATCH_RECHECK` и обновляет `data/watchlist.json`.
14. Иначе пишет финальное решение в статусную консоль и в `logs/log.txt`.
15. Финальные решения попадают в `data/seen.json`, а `WATCH_RECHECK` туда не добавляется.

## Проверка синтаксиса

```bash
npm run check
```
