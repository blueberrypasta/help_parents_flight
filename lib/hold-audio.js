/**
 * 대기 오디오 생성기
 *
 * 검색 중 Twilio Media Stream에 직접 보낼 수 있는
 * g711 ulaw 오디오를 프로그래밍으로 생성
 */

// ─── Linear PCM → μ-law 변환 ───
function linearToUlaw(sample) {
  const BIAS = 0x84;
  const MAX = 32635;
  const sign = (sample >> 8) & 0x80;

  if (sign !== 0) sample = -sample;
  if (sample > MAX) sample = MAX;
  sample += BIAS;

  let exponent = 7;
  let mask = 0x4000;
  while ((sample & mask) === 0 && exponent > 0) {
    exponent--;
    mask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulawByte;
}

// ─── 사인파 톤 생성 (g711 ulaw, 8kHz) ───
function generateTone(frequency, durationMs, volume = 0.15) {
  const sampleRate = 8000;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // 페이드 인/아웃 (클릭 방지)
    const fadeLen = Math.min(numSamples * 0.1, 200);
    let envelope = 1;
    if (i < fadeLen) envelope = i / fadeLen;
    if (i > numSamples - fadeLen) envelope = (numSamples - i) / fadeLen;

    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope;
    buffer[i] = linearToUlaw(Math.floor(sample * 32767));
  }

  return buffer;
}

// ─── 무음 생성 ───
function generateSilence(durationMs) {
  const sampleRate = 8000;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(numSamples);
  // ulaw 무음 = 0xFF
  buffer.fill(0xff);
  return buffer;
}

// ─── 부드러운 대기 멜로디 생성 ───
// "도-미-솔" 같은 부드러운 3음 차임 + 무음, 반복 가능
function generateHoldChime() {
  const notes = [
    { freq: 523.25, dur: 200 }, // 도 (C5)
    { freq: 0, dur: 100 },      // 쉼
    { freq: 659.25, dur: 200 }, // 미 (E5)
    { freq: 0, dur: 100 },      // 쉼
    { freq: 783.99, dur: 300 }, // 솔 (G5)
  ];

  const buffers = notes.map((n) =>
    n.freq === 0 ? generateSilence(n.dur) : generateTone(n.freq, n.dur, 0.1)
  );

  return Buffer.concat(buffers);
}

// ─── 부드러운 "통통" 대기음 (1.5초 간격 반복용) ───
function generateWaitingBeep() {
  // 부드러운 "뚱" 소리 (두 음 겹침)
  const tone1 = generateTone(880, 120, 0.08);  // A5, 아주 작게
  const silence = generateSilence(1380);         // 1.38초 무음
  return Buffer.concat([tone1, silence]);
}

/**
 * Twilio Media Stream에 대기 오디오 전송 시작
 *
 * @returns {{ stop: () => void }} - stop()을 호출하면 대기음 중지
 */
export function startHoldAudio(twilioSocket, streamSid) {
  if (!streamSid) return { stop: () => {} };

  // 1. 먼저 차임 멜로디 한 번 재생
  const chime = generateHoldChime();
  sendAudioToTwilio(twilioSocket, streamSid, chime);

  // 2. 이후 1.5초마다 부드러운 대기음 반복
  const beep = generateWaitingBeep();
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    sendAudioToTwilio(twilioSocket, streamSid, beep);
  }, 1500);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

// ─── ulaw 오디오를 Twilio Media Stream으로 전송 ───
function sendAudioToTwilio(twilioSocket, streamSid, audioBuffer) {
  // Twilio Media Stream은 한 번에 최대 ~20ms (160 samples) 청크로 받는 게 이상적
  // 하지만 더 큰 청크도 지원됨
  const CHUNK_SIZE = 640; // 80ms분의 오디오

  for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
    const chunk = audioBuffer.subarray(i, Math.min(i + CHUNK_SIZE, audioBuffer.length));
    try {
      twilioSocket.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: chunk.toString("base64"),
          },
        })
      );
    } catch (e) {
      // 소켓 닫혔으면 무시
      break;
    }
  }
}
