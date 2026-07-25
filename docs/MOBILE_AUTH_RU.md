# Авторизация мобильного приложения

Мобильное приложение MILA использует ту же базу пользователей, что и
веб-панель Agentic OS.

## API

- `POST /api/auth/mobile/register` принимает `name`, `email`, `password`.
- `POST /api/auth/mobile/login` принимает `email`, `password`.
- Оба маршрута возвращают подписанный `accessToken`, пользователя, роль и
  capabilities.
- `GET /api/auth/me` принимает этот token в
  `Authorization: Bearer <token>`.
- Личные задачи и заметки доступны через `/api/member/*`.

Мобильный token действует 30 дней. Он содержит `user_id` и `sessionVersion`,
но не пароль. Смена роли или отключение пользователя увеличивает
`sessionVersion`, поэтому старые мобильные token перестают работать.

## Голос

Основной token нельзя использовать как LiveKit credential. MILA передает его в
`POST /mila/v1/auth/agentic`; голосовой backend проверяет аккаунт через
`/api/auth/me` и выдает отдельную revocable voice session. Gemini API key,
LiveKit API key и Agentic OS Creator token не попадают на телефон.

## Изоляция

Личные файлы определяются сервером по `user_id`. Клиент не передает идентификатор
чужого пользователя и не может выбрать другой workspace. Creator и Admin
сохраняют операторскую веб-панель, а Member получает только личный интерфейс.
