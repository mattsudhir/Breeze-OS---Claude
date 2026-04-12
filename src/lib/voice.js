// Voice utilities — thin wrapper around the Web Speech API.
//
// This module is the abstraction layer for speech recognition (listen) and
// speech synthesis (speak). Swapping to a server-side provider (Whisper,
// ElevenLabs) later should only require changing this file, not the UI code
// that imports it.

let currentRecognition = null;
let currentUtterance = null;

// ── Feature detection ────────────────────────────────────────────

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function isListeningSupported() {
  return !!SpeechRecognition;
}

export function isSpeakingSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
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

// Pick a reasonable default voice — prefer en-US, prefer "Google" or "Samantha"
// (common high-quality voices on Chrome/Safari) if available.
function pickVoice() {
  if (!isSpeakingSupported()) return null;
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

export function speak(text, { onEnd } = {}) {
  if (!isSpeakingSupported() || !text) {
    onEnd?.();
    return;
  }

  // Cancel anything currently speaking
  cancelSpeech();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
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

export function cancelSpeech() {
  if (!isSpeakingSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}
