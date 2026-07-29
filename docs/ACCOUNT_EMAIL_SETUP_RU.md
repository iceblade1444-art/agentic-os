# Email-подтверждение и восстановление аккаунта

Agentic OS поддерживает подтверждение новых аккаунтов и одноразовые ссылки
восстановления пароля через любой SMTP-сервис. Секреты задаются только в
серверном `/home/admilana/agentic-os/.env` и не попадают в GitHub или API.

## Настройка

### Корпоративная почта Milanapremium

Для production уже доступен `mail.milanapremium.uz` на портах `587` и `465`.
Если ящик `no-reply@milanapremium.uz` создан, запустите на сервере:

```bash
cd ~/agentic-os
bash scripts/configure-corporate-smtp.sh
```

Пароль вводится скрыто и не выводится в терминал. Мастер сначала проверяет
SMTP и отправляет тестовое письмо. Только после успешной проверки он включает
`EMAIL_VERIFICATION_REQUIRED=true` и перезапускает приложение. При ошибке
исходный `.env` восстанавливается автоматически.

Ниже оставлен вариант внешнего SMTP как резервный путь.

Если корпоративный SMTP недоступен, резервный вариант — Brevo: пользователям Agentic OS не нужны
свои Brevo-аккаунты, Google Cloud или SMTP-пароли. Один серверный SMTP-аккаунт
отправляет системные письма всем пользователям. Бесплатный тариф Brevo включает
до 300 писем в день.

В Brevo откройте `Settings → SMTP & API → SMTP`, создайте отдельный SMTP key
для Agentic OS и подтвердите адрес отправителя. Используйте именно SMTP key,
не пароль аккаунта и не API key.

Добавьте в серверный `.env`:

```dotenv
PUBLIC_URL=https://agent.milanapremium.uz
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-brevo-smtp-login
SMTP_PASSWORD=your-brevo-smtp-key
SMTP_FROM="Mila Agentic OS <verified-sender@milanapremium.uz>"
EMAIL_VERIFICATION_REQUIRED=true
```

Для SMTP на порту `465` обычно используются `SMTP_PORT=465` и
`SMTP_SECURE=true`. Для STARTTLS на порту `587` оставьте `SMTP_SECURE=false`.
Если хостинг блокирует `587`, Brevo также поддерживает `2525`; с production
Agentic OS оба порта уже проверены и доступны.

До включения обязательного подтверждения проверьте настройки внутри
контейнера:

```bash
docker compose run --rm --no-deps \
  -e SMTP_TEST_TO=your-address@example.com \
  agentic-os npm run smtp:verify
```

Команда проверяет соединение и аутентификацию, а при `SMTP_TEST_TO` отправляет
одно тестовое письмо. SMTP key в вывод не попадает.

После изменения выполните:

```bash
cd /home/admilana/agentic-os
docker compose up -d --build agentic-os
curl -fsS https://agent.milanapremium.uz/api/health
```

В `accountRecovery` должны появиться:

```json
{"required":true,"deliveryReady":true}
```

## Защита

- Токены подтверждения действуют 24 часа.
- Токены сброса пароля действуют 30 минут.
- Каждый токен одноразовый и хранится только как HMAC-хеш.
- Ответ восстановления одинаков для существующего и неизвестного email.
- После смены пароля все web/mobile-сессии пользователя отзываются.
- Старые аккаунты считаются подтверждёнными; требование применяется к новым.
