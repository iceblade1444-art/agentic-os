# Speech service

CPU-only speech backend for Agentic OS. It provides:

- multilingual speech-to-text through faster-whisper;
- low-latency Piper speech synthesis;
- higher-quality Qwen speech synthesis;
- consent-based voice cloning for supported languages.

Model weights are intentionally not committed. Configure their host directories
with `SPEECH_MODELS_DIR` and `QWEN_TTS_MODELS_DIR` in the root `.env`.

Expected Piper files:

```text
speech-models/
  piper/
    ru_RU-irina-medium.onnx
    ru_RU-irina-medium.onnx.json
    uz_UZ-milana-medium.onnx
    uz_UZ-milana-medium.onnx.json
```

Fine-tuned CTranslate2 Whisper directories may also be placed under
`speech-models/`. Missing language-specific weights fall back to a stock
multilingual Whisper model.
