# Umnico Diagnostic Bot

Локальный диагностический бот для Umnico на Node.js + Playwright.

В текущей версии бот работает только в `dryRun` режиме:
- сканирует список новых диалогов
- анализирует превью
- при необходимости открывает диалог
- читает последние сообщения
- считает score релевантности
- пишет решение в консоль и `logs/log.txt`
- никогда не нажимает `#messaging-accept-dialog`

## Структура проекта

```text
package.json
README.md
config/config.json
data/seen.json
logs/log.txt
src/main.js
src/state.js
src/selectors.js
src/scanner.js
src/filter.js
src/chatReader.js
src/logger.js
src/storage.js
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
- `acceptButtonDetected`
- scoring breakdown

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
4. После этого дочитывает последние сообщения и считает final score.
5. Выставляет одно из решений:
   - `ACCEPT_CANDIDATE`
   - `OPEN_CHECK`
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
- временное отсутствие селектора логируется, но не валит весь цикл
- ошибка на одном чате не останавливает следующий

## Диагностический pipeline

1. Раз в `pollIntervalMs` считываются все `a.deals-row`.
2. Из каждой строки извлекаются `href`, `userName`, `previewText`, `sourcePreview`, `timeText`.
3. Уже обработанные `href` из `data/seen.json` пропускаются.
4. Считается preliminary score.
5. При необходимости бот открывает диалог.
6. После открытия ждёт `.im-history`.
7. Считывает последние сообщения по `.im-message__text`.
8. Считывает источник по `.im-source-item`.
9. Считает final score.
10. Пишет решение в статусную консоль и в `logs/log.txt`.
11. Добавляет `dealId` в `data/seen.json`.

## Проверка синтаксиса

```bash
npm run check
```
