function microphoneConstraints(deviceId = "") {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
  };
}

export async function listMilaMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  let permissionStream = null;
  if (!devices.some((device) => device.kind === "audioinput" && device.label)) {
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
      devices = await navigator.mediaDevices.enumerateDevices();
    } finally {
      for (const track of permissionStream?.getTracks() || []) track.stop();
    }
  }
  const seen = new Set();
  return devices.filter((device) => {
    if (device.kind !== "audioinput" || seen.has(device.deviceId)) return false;
    seen.add(device.deviceId);
    return true;
  }).map((device, index) => ({
    id: device.deviceId,
    label: device.label || `Microphone ${index + 1}`,
  }));
}

export async function testMilaMicrophone(deviceId, onLevel, durationMs = 3500) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId) });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("Audio testing is unavailable in this browser");
  }
  const context = new AudioContextClass({ latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let maximum = 0;
  const startedAt = performance.now();

  try {
    await context.resume();
    await new Promise((resolve) => {
      const sample = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let index = 0; index < samples.length; index += 4) sum += samples[index] * samples[index];
        const level = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length / 4)) * 4);
        maximum = Math.max(maximum, level);
        onLevel?.(level);
        if (performance.now() - startedAt >= durationMs) resolve();
        else requestAnimationFrame(sample);
      };
      sample();
    });
    return maximum;
  } finally {
    onLevel?.(0);
    try { source.disconnect(); } catch { /* disconnected */ }
    for (const track of stream.getTracks()) track.stop();
    if (context.state !== "closed") await context.close();
  }
}

