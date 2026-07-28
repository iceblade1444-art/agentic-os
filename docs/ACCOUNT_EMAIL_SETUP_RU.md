# Email-подтверждение и восстановление аккаунта

Agentic OS поддерживает подтверждение новых аккаунтов и одноразовые ссылки
восстановления пароля через любой SMTP-сервис. Секреты задаются только в
серверном `/home/admilana/agentic-os/.env` и не попадают в GitHub или API.

## Настройка

Добавьте в серверный `.env`:

```dotenv
PUBLIC_URL=https://agent.milanapremium.uz
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM="Mila Agentic OS <no-reply@example.com>"
EMAIL_VERIFICATION_REQUIRED=true
```

Для SMTP на порту `465` обычно используются `SMTP_PORT=465` и
`SMTP_SECURE=true`. Для STARTTLS на порту `587` оставьте `SMTP_SECURE=false`.
Точные значения выдаёт выбранный почтовый сервис.

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
