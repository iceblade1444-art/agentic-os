# Voice Adapter

## Purpose

The voice adapter is the safe first step toward Jarvis-style control.

It does **not** directly execute arbitrary voice commands. Instead it routes recognized text through the deterministic AgentOS command bridge:

```text
recognized text -> voice_command.py -> POST /api/command -> AgentOS action -> response text -> optional TTS hook
```

## Script

```text
scripts/voice_command.py
```

## Examples

### Live dashboard API

```bash
python scripts/voice_command.py --text "создай goal Voice demo"
```

### Offline/mock parser

```bash
python scripts/voice_command.py --text "покажи digest" --mock-server
```

### Read recognized text from file

```bash
python scripts/voice_command.py --input-file voice/input.txt
```

### Optional TTS hook

Any local command can be used as a TTS hook if it accepts text and output path placeholders:

```bash
python scripts/voice_command.py \
  --text "покажи digest" \
  --tts-command "my-tts-command {text} {output}" \
  --tts-output voice/response.mp3
```

## Output files

```text
voice/last_command.txt
voice/last_response.txt
voice/last_result.json
```

## Supported command intents

```text
создай goal ...
создай цель ...
create goal ...
покажи digest
создай approval <action> <summary>
экспортируй в kanban <project-slug>
```

## Provider wrapper

```bash
python scripts/push_to_talk.py --mock-text "создай goal Demo" --mock-server --once
python scripts/push_to_talk.py --provider gemini_live --status
```

Gemini Live provider boundary:

```text
voice/providers/gemini_live.py
```

Local override example:

```text
config/voice.local.example.json
```

## Next step

Connect a real STT/Gemini Live transport that writes recognized text into this script or calls `/api/command` directly.
