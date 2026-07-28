# PostgreSQL в Agentic OS

## Текущее состояние

PostgreSQL подключается как закрытый Docker-сервис без опубликованного порта.
На первом этапе JSON остаётся источником истины, а схема
`agentic_os_shadow` получает транзакционную копию:

- аккаунтов и хешей паролей;
- web/mobile-сессий;
- личных задач и заметок;
- onboarding-профилей и контекста workspace;
- зашифрованных MFA-записей;
- одноразовых токенов подтверждения email и сброса пароля.

MFA-секреты не расшифровываются. Пароли не преобразуются и не выводятся.
Исходные JSON-файлы мигратор не изменяет и не удаляет.

После запуска приложения встроенный shadow-sync транзакционно обновляет копию
каждые 30 секунд. Параллельные запуски не допускаются, а advisory lock защищает
от одновременного ручного `db:migrate`. Недоступность PostgreSQL отображается в
`/api/health`, но не останавливает JSON-авторизацию и личные workspace.

Каждая атомарная запись в мигрируемый JSON дополнительно создаёт событие в
`data/postgres-shadow-outbox.jsonl`. В событии есть только UUID, время и
относительное имя файла — содержимое аккаунта, email, токены и хеши туда не
попадают. Через 500 мс после изменения запускается транзакционная синхронизация.
Пачка удаляется из outbox только после успешного commit и parity check.

## Подготовка

В production `.env` один раз задаются:

```dotenv
POSTGRES_DB=agentic_os
POSTGRES_USER=agentic_os
POSTGRES_PASSWORD=<случайная hex-строка не короче 32 байт>
POSTGRES_SHADOW_SYNC_ENABLED=true
POSTGRES_SHADOW_SYNC_INTERVAL_MS=30000
POSTGRES_SHADOW_SYNC_DEBOUNCE_MS=500
```

Пароль нельзя добавлять в Git. PostgreSQL доступен только контейнерам
`docker-compose.yml`.

## Проверка и миграция

```bash
# Проверить источники без подключения к базе
docker compose exec -T agentic-os npm run db:dry-run

# Транзакционно пересоздать shadow-копию и проверить количество записей
docker compose exec -T agentic-os npm run db:migrate

# Повторная сверка без записи
docker compose exec -T agentic-os npm run db:verify
```

Миграция блокируется advisory lock и выполняется одной транзакцией. При любой
ошибке PostgreSQL делает rollback. Неизвестный файл личного workspace считается
orphan и останавливает миграцию вместо тихой потери данных.

## Резервные копии

Штатный `agentic-os-backup.service` добавляет `postgres.dump` формата
`pg_dump --format=custom`. Restore drill выполняет `pg_restore --list`, то есть
проверяет структуру дампа, не меняя живую базу.

## Условия переключения

JSON можно перестать считать основной базой только после того, как:

1. повторные `db:migrate` и `db:verify` дают полную parity;
2. production web/mobile smoke-test проходит на PostgreSQL adapter;
3. создан и проверен свежий `postgres.dump`;
4. есть отдельный флаг отката на JSON;
5. минимум один релиз shadow-репликации отработал без расхождений.

До выполнения этих условий удалять JSON-файлы запрещено.

## Наблюдение

`GET /api/health` содержит bounded-блок `database`:

- `status: ready` — последняя транзакционная синхронизация успешна;
- `status: syncing` — синхронизация выполняется;
- `status: error` — PostgreSQL временно недоступен или parity нарушена;
- `lastSuccessAt`, `lastDurationMs`, `counts` — время и размер последней копии.
- `outbox.pending` — сколько изменений ещё ожидают подтверждённого SQL commit.

Строка подключения и пароль в API и логах не выводятся. Перед переключением
источника истины shadow-sync должен отработать минимум один релиз без ошибок.

Если PostgreSQL временно недоступен, JSON продолжает работать, outbox сохраняет
события, а периодический цикл повторяет доставку. Для отката достаточно задать
`POSTGRES_SHADOW_SYNC_ENABLED=false` и перезапустить приложение; JSON не требует
обратной миграции.
