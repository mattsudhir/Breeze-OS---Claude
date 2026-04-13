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

// Verbose flag — flip on to get every recognition event in the console
// for debugging. Logs are gated behind `[voice]` so they're easy to grep.
const VOICE_DEBUG = true;
const vlog = (...args) => {
  if (VOICE_DEBUG) console.log('[voice]', ...args);
};

// Some browsers (desktop Edge, Firefox with Nightly flag on) expose
// SpeechRecognition but won't produce results unless the mic permission
// has been primed through getUserMedia first. Do a best-effort prime —
// if it fails, we still let recognition.start() run and report whatever
// error comes back.
async function primeMicPermission() {
  try {
    if (!navigator?.mediaDevices?.getUserMedia) {
      vlog('getUserMedia not available — skipping mic prime');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We don't actually need the stream — SpeechRecognition handles its
    // own capture. Releasing the tracks avoids keeping the mic light on.
    stream.getTracks().forEach((t) => t.stop());
    vlog('mic permission primed');
  } catch (err) {
    vlog('mic permission denied or unavailable:', err?.name || err?.message);
  }
}

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

  // Fire-and-forget mic prime. Doesn't block recognition.start() — on
  // Chrome it's redundant, on Edge it unsticks browsers that otherwise
  // ignore SpeechRecognition until the mic has been explicitly granted.
  primeMicPermission();

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  vlog('created recognition', {
    ua: navigator.userAgent,
    lang: recognition.lang,
    ctor: SpeechRecognition.name || '(webkit)',
  });

  let finalTranscript = '';
  // Desktop Edge (and some older Chromium builds) doesn't reliably set
  // result.isFinal when the user manually calls stop(). The transcript
  // lives in interim results but never gets committed. Track the most
  // recent interim text as a fallback so onend always has something to
  // hand back to the UI.
  let latestInterim = '';
  let didEnd = false;
  let sawAnyResult = false;

  recognition.onstart = () => vlog('onstart');
  recognition.onaudiostart = () => vlog('onaudiostart (mic capturing)');
  recognition.onsoundstart = () => vlog('onsoundstart');
  recognition.onspeechstart = () => vlog('onspeechstart');
  recognition.onspeechend = () => vlog('onspeechend');
  recognition.onsoundend = () => vlog('onsoundend');
  recognition.onaudioend = () => vlog('onaudioend');
  recognition.onnomatch = () => vlog('onnomatch');

  recognition.onresult = (event) => {
    sawAnyResult = true;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }
    vlog('onresult', { interim, final: finalTranscript });
    if (interim) {
      latestInterim = interim;
      onInterim?.(interim);
    }
  };

  // Pick whichever transcript actually has content. Final is authoritative
  // when the browser bothered to commit it; otherwise fall back to the
  // last interim we saw. Matches user expectation on Edge.
  const bestTranscript = () => {
    const finalTrim = finalTranscript.trim();
    if (finalTrim) return finalTrim;
    return latestInterim.trim();
  };

  recognition.onerror = (event) => {
    vlog('onerror', event.error, event.message);
    if (didEnd) return;
    didEnd = true;
    // `no-speech` and `aborted` are common and not really errors
    if (event.error === 'no-speech' || event.error === 'aborted') {
      onFinal?.(bestTranscript());
      return;
    }
    // `not-allowed` means the user (or OS privacy setting) denied the mic.
    // `service-not-allowed` on Edge usually means the Windows privacy setting
    // "Online speech recognition" is disabled in Settings → Privacy.
    // `network` means the browser couldn't reach its speech service (Edge
    // proxies through Microsoft; Chrome through Google).
    const friendly = {
      'not-allowed': 'Microphone access was blocked. Allow mic access in the address bar and try again.',
      'service-not-allowed': 'Speech recognition is disabled. On Windows: Settings → Privacy → Speech → turn on "Online speech recognition". Then reload.',
      'network': 'The browser couldn\'t reach its speech service. Check your connection and try again.',
      'audio-capture': 'No microphone found or it\'s in use by another app.',
      'language-not-supported': 'en-US speech recognition isn\'t available in this browser.',
    }[event.error] || `Recognition error: ${event.error}`;
    onError?.(new Error(friendly));
  };

  recognition.onend = () => {
    vlog('onend', {
      sawAnyResult,
      finalLen: finalTranscript.length,
      interimLen: latestInterim.length,
    });
    if (didEnd) return;
    didEnd = true;
    // If recognition never produced anything at all, bubble that up so
    // the UI can show a helpful nudge instead of silently sending "".
    if (!sawAnyResult && !finalTranscript && !latestInterim) {
      onError?.(new Error(
        'No speech was captured. Check that the microphone is working, ' +
        'the site has mic permission, and (on Windows) that "Online speech ' +
        'recognition" is enabled in Settings → Privacy → Speech.'
      ));
    } else {
      onFinal?.(bestTranscript());
    }
    if (currentRecognition === recognition) currentRecognition = null;
  };

  try {
    recognition.start();
    currentRecognition = recognition;
    vlog('start() called');
  } catch (err) {
    vlog('start() threw:', err?.message);
    onError?.(err);
  }

  return () => {
    try {
      recognition.stop();
      vlog('stop() called');
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
