# Mila Learnings

This file is Mila's local self-learning journal.

New lessons should be appended after each meaningful project run.

## 2026-06-26 - NOVA Voice Reference Imported

- Found the old local Milana/NOVA assistant in `C:\Users\User\Documents\Milana agent\Agent.py` and the LiveKit Android voice UI in `C:\Users\User\Documents\agent-starter-android\app\src\main\java\io\livekit\android\example\voiceassistant`.
- Adopted the same pattern for Mila: LiveKit/Gemini realtime target, Callirrhoe voice, call-style visualizer, microphone state, transcript log, and conversation memory writeback.
- Current working mode is browser fallback: Web Speech Recognition + speech synthesis + AgentOS `/api/voice-session`.
- Gemini Live health is ready. Native LiveKit realtime needs `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` before it can become the active transport.
- Keep Mila as the only visible dashboard agent. Internal agents may be created only as project helpers under Mila's orchestration.

## 2026-06-26 - Correct AGENT NOVA Native Voice Transport

- The real `C:\AGENT NOVA` voice assistant uses Gemini Live native-audio over WebSocket, not LiveKit.
- Imported the core contract into AgentOS: browser PCM s16le 16 kHz mic frames -> `/ws/mila/voice` -> Gemini Live native audio -> PCM s16le 24 kHz playback frames.
- Added the local WebSocket route, Gemini Live native-audio session, transcript events, action bridge hooks, and frontend `MilaNativeVoiceClient`.
- `google-genai` is installed in the local Python environment and `/api/mila/voice-agent` reports `native_audio_ready=true`.
- WebSocket smoke test returned `ready` with voice `Leda` and model `models/gemini-2.5-flash-native-audio-preview-12-2025`.
- SpeechRecognition is now only fallback thinking; primary Mila voice behavior should use the NOVA native-audio WebSocket.
