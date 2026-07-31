# MILA push notifications

Agentic OS stores Inbox messages first and uses Firebase Cloud Messaging only
as a delivery signal. A failed push never removes or loses an Inbox item.

## Firebase project

1. Create or select a Firebase project.
2. Register Android app `app.milaai.mila`.
3. Enable Firebase Cloud Messaging API.
4. Create a service account with the Firebase Cloud Messaging API Admin role.
5. Save its JSON key outside Git as
   `/home/admilana/agentic-os/data/firebase-service-account.json`.

Server `.env`:

```env
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_SERVICE_ACCOUNT_FILE=./data/firebase-service-account.json
```

The JSON key must stay mode `0600` and must never be committed.

## Android build

Get the Android app identifiers from Firebase project settings and build:

```powershell
flutter build apk --release `
  --dart-define=MILA_FIREBASE_API_KEY=... `
  --dart-define=MILA_FIREBASE_PROJECT_ID=... `
  --dart-define=MILA_FIREBASE_MESSAGING_SENDER_ID=... `
  --dart-define=MILA_FIREBASE_ANDROID_APP_ID=...
```

These app identifiers are not server credentials. The private service-account
key remains on Agentic OS only.

## Runtime flow

1. MILA requests notification permission after account sign-in.
2. The installation token is registered under that Agentic OS user.
3. Hermes publishes an Inbox item through `/api/member/inbox/publish`.
4. Agentic OS persists the item and sends a push signal.
5. Opening the notification takes the user to chat and synchronizes Inbox.
6. Sign-out unregisters the installation before deleting the local session.
