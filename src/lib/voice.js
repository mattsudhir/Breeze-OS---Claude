// Voice utilities — thin wrapper around the Web Speech API.
//
// This module is the abstraction layer for speech recognition (listen) and
// speech synthesis (speak). Swapping to a server-side provider (Whisper,
// ElevenLabs) later should only require changing this file, not the UI code
// that imports it.

let currentRecognition = null;
let currentUtterance = null;
let currentAudio = null;
let currentAudioUrl = null;
let elevenLabsDisabled = false; // set to true after a quota/auth failure so we stop retrying

// ── Feature detection ────────────────────────────────────────────

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function isListeningSupported() {
  return !!SpeechRecognition;
}

export function isSpeakingSupported() {
  // ElevenLabs works in any browser with fetch + Audio; Web Speech is a fallback
  return (
    typeof window !== 'undefined' &&
    typeof fetch !== 'undefined' &&
    typeof Audio !== 'undefined'
  );
}

// ── Speech recognition (listen) ──────────────────────────────────

// Starts listening. Calls onInterim with partial transcripts as they arrive,
// onFinal once with the final transcript, and onError on any failure.
// Returns a stop function that halts listening immediately.
export function startListening({ onInterim, onFinal, onError } = {}) {
  if (!SpeechRecognition) {
    onError?.(new Error('Speech recognition not supported in this browser'));
    return () => {};
  }

  // Stop any currently-running recognition
  stopListening();

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  let finalTranscript = '';
  let didEnd = false;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) onInterim?.(interim);
  };

  recognition.onerror = (event) => {
    if (didEnd) return;
    didEnd = true;
    // `no-speech` and `aborted` are common and not really errors
    if (event.error === 'no-speech' || event.error === 'aborted') {
      onFinal?.(finalTranscript.trim());
    } else {
      onError?.(new Error(event.error || 'Recognition error'));
    }
  };

  recognition.onend = () => {
    if (didEnd) return;
    didEnd = true;
    onFinal?.(finalTranscript.trim());
    if (currentRecognition === recognition) currentRecognition = null;
  };

  try {
    recognition.start();
    currentRecognition = recognition;
  } catch (err) {
    onError?.(err);
  }

  return () => {
    try {
      recognition.stop();
    } catch {
      // already stopped
    }
  };
}

export function stopListening() {
  if (currentRecognition) {
    try {
      currentRecognition.stop();
    } catch {
      // ignore
    }
    currentRecognition = null;
  }
}

// ── Speech synthesis (speak) ─────────────────────────────────────
//
// Primary: ElevenLabs via /api/tts (high quality, costs quota).
// Fallback: Web Speech API (robotic but free, works offline).
// If ElevenLabs returns a quota/auth error once, we remember and skip
// it for the rest of the session to avoid repeated failures.

// Pick a reasonable Web Speech voice — used only when ElevenLabs can't serve.
function pickWebSpeechVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const enVoices = voices.filter((v) => v.lang && v.lang.startsWith('en'));
  const pool = enVoices.length ? enVoices : voices;

  const preferred = pool.find(
    (v) =>
      /Samantha|Google US English|Microsoft Aria|Microsoft Jenny|Natural/i.test(v.name),
  );
  return preferred || pool[0];
}

function speakWithWebSpeech(text, onEnd) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickWebSpeechVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  utterance.onend = () => {
    if (currentUtterance === utterance) currentUtterance = null;
    onEnd?.();
  };
  utterance.onerror = () => {
    if (currentUtterance === utterance) currentUtterance = null;
    onEnd?.();
  };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

async function speakWithElevenLabs(text, onEnd) {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    // Disable for the rest of the session on quota / auth errors
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // ignore
    }
    if (response.status === 401 || response.status === 402 || payload?.quota_exceeded) {
      elevenLabsDisabled = true;
      console.warn('ElevenLabs disabled for session:', payload?.error || response.status);
    }
    throw new Error(payload?.error || `TTS failed: ${response.status}`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentAudioUrl = url;

  audio.onended = () => {
    if (currentAudioUrl === url) {
      URL.revokeObjectURL(url);
      currentAudioUrl = null;
    }
    if (currentAudio === audio) currentAudio = null;
    onEnd?.();
  };
  audio.onerror = () => {
    if (currentAudioUrl === url) {
      URL.revokeObjectURL(url);
      currentAudioUrl = null;
    }
    if (currentAudio === audio) currentAudio = null;
    onEnd?.();
  };

  try {
    await audio.play();
  } catch (err) {
    // Autoplay policy or other playback issue
    if (currentAudioUrl === url) {
      URL.revokeObjectURL(url);
      currentAudioUrl = null;
    }
    if (currentAudio === audio) currentAudio = null;
    throw err;
  }
}

export async function speak(text, { onEnd } = {}) {
  if (!text) {
    onEnd?.();
    return;
  }

  // Cancel anything currently speaking
  cancelSpeech();

  // Try ElevenLabs first unless we've already learned it's unavailable
  if (!elevenLabsDisabled) {
    try {
      await speakWithElevenLabs(text, onEnd);
      return;
    } catch (err) {
      console.warn('ElevenLabs TTS failed, falling back to Web Speech:', err.message);
      // fall through to Web Speech
    }
  }

  speakWithWebSpeech(text, onEnd);
}

export function cancelSpeech() {
  // Cancel ElevenLabs audio playback
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {
      // ignore
    }
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }

  // Cancel Web Speech synthesis
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  currentUtterance = null;
}
