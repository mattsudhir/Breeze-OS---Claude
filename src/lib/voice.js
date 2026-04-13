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
let currentMediaRecorder = null;
let currentMediaStream = null;
let elevenLabsDisabled = false; // set to true after a quota/auth failure so we stop retrying

// ── Feature detection ────────────────────────────────────────────

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

// Detect Edge (Chromium-based, "Edg/" in UA) and Firefox/Safari. On these
// browsers the built-in SpeechRecognition is either absent or routes
// through a speech service that's unreliable, so we skip straight to the
// server-side /api/stt path (ElevenLabs Scribe).
function isEdgeBrowser() {
  if (typeof navigator === 'undefined') return false;
  return / Edg\//.test(navigator.userAgent);
}

const MediaRecorderSupported =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  !!navigator?.mediaDevices?.getUserMedia;

export function isListeningSupported() {
  // Server-side fallback works in any modern browser with MediaRecorder,
  // so we're "supported" whenever either path is available.
  return !!SpeechRecognition || MediaRecorderSupported;
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

// ── Server-side listening (MediaRecorder + /api/stt) ──────────────
//
// Captures audio from the mic with MediaRecorder, uploads the blob to
// /api/stt (which proxies to ElevenLabs Scribe), and returns the
// transcript via onFinal. No interim results — Scribe is batch-only.
// Used on Edge (where native SpeechRecognition is flaky) and as the
// only option on Firefox/Safari.
export function startListeningServerSide({ onInterim, onFinal, onError } = {}) {
  if (!MediaRecorderSupported) {
    onError?.(new Error('Microphone capture not supported in this browser'));
    return () => {};
  }

  stopListening(); // cancel any in-flight native recognition

  let didStop = false;
  let stream = null;
  let recorder = null;
  const chunks = [];

  vlog('server-side listening: requesting mic');

  // The onInterim signal on the server-side path — there's no real
  // interim transcript, so we just tell the UI "we're capturing" once.
  onInterim?.('(listening...)');

  // Kick off the async mic-grab + recording flow. We return a stop
  // handle synchronously so the UI can cancel even if getUserMedia is
  // still pending.
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      currentMediaStream = stream;

      // Pick a MIME type the browser supports AND /api/stt can handle.
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mime = mimeCandidates.find((m) =>
        window.MediaRecorder.isTypeSupported(m),
      ) || 'audio/webm';

      vlog('server-side listening: MediaRecorder mime =', mime);

      recorder = new MediaRecorder(stream, { mimeType: mime });
      currentMediaRecorder = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
          vlog('server-side: data chunk', { size: e.data.size, chunksCount: chunks.length });
        }
      };

      recorder.onerror = (e) => {
        vlog('server-side MediaRecorder error', e);
        cleanup();
        onError?.(new Error('Microphone recording failed. Check permissions.'));
      };

      recorder.onstop = async () => {
        // Compute blob stats before cleanup (cleanup doesn't touch chunks,
        // but being explicit helps with debugging).
        const totalBytes = chunks.reduce((sum, c) => sum + (c.size || 0), 0);
        vlog('server-side listening: recorder stopped', {
          chunks: chunks.length,
          totalBytes,
          didStop,
        });
        cleanup();

        if (chunks.length === 0 || totalBytes === 0) {
          onError?.(new Error('No audio was captured. Check that your microphone is working and try again.'));
          return;
        }

        const blob = new Blob(chunks, { type: mime });
        vlog('server-side: blob built', { size: blob.size, type: blob.type });

        try {
          const res = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'Content-Type': mime },
            body: blob,
          });
          const data = await res.json();
          vlog('server-side /api/stt response', { status: res.status, ok: data.ok, text: data.text });

          if (!res.ok || !data.ok) {
            onError?.(new Error(data.error || `STT failed: HTTP ${res.status}`));
            return;
          }

          const text = (data.text || '').trim();
          if (!text) {
            onError?.(new Error("Couldn't transcribe that. Try speaking a bit louder or closer to the mic."));
            return;
          }
          onFinal?.(text);
        } catch (err) {
          vlog('server-side /api/stt threw', err);
          onError?.(new Error(`Transcription request failed: ${err.message}`));
        }
      };

      // Start with a 250ms timeslice so ondataavailable fires continuously
      // instead of only when stop() is called. This way even very short
      // recordings produce real audio chunks, and we don't lose buffered
      // data if the recorder is interrupted.
      recorder.start(250);
      vlog('server-side listening: recording started with 250ms timeslice');
    } catch (err) {
      vlog('server-side getUserMedia failed', err);
      cleanup();
      const friendly =
        err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Click the lock icon in the address bar and allow mic access, then try again.'
          : err.name === 'NotFoundError'
          ? 'No microphone was found. Plug one in and try again.'
          : `Could not access microphone: ${err.message}`;
      onError?.(new Error(friendly));
    }
  })();

  function cleanup() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    currentMediaStream = null;
    currentMediaRecorder = null;
  }

  // Return a stop handle the UI can call when the user taps stop.
  return () => {
    if (didStop) return;
    didStop = true;
    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        // Mic-grab may still be pending. Make sure we release the stream
        // and surface a graceful failure.
        cleanup();
        onError?.(new Error('Recording stopped before it started. Try again.'));
      }
    } catch (err) {
      cleanup();
      onError?.(new Error(`Failed to stop recording: ${err.message}`));
    }
  };
}

// Starts listening. Calls onInterim with partial transcripts as they arrive,
// onFinal once with the final transcript, and onError on any failure.
// Returns a stop function that halts listening immediately.
//
// Routing:
//   - Edge (Chromium-Edge) → server-side (native SpeechRecognition is broken)
//   - No SpeechRecognition   → server-side (Firefox/Safari)
//   - Otherwise             → browser-native (Chrome/Android Chrome)
export function startListening(handlers = {}) {
  const forceServerSide = isEdgeBrowser() || !SpeechRecognition;
  if (forceServerSide) {
    vlog('routing to server-side listener', {
      edge: isEdgeBrowser(),
      hasSpeechRecognition: !!SpeechRecognition,
    });
    return startListeningServerSide(handlers);
  }
  return startListeningNative(handlers);
}

function startListeningNative({ onInterim, onFinal, onError } = {}) {
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
  if (currentMediaRecorder) {
    try {
      if (currentMediaRecorder.state !== 'inactive') currentMediaRecorder.stop();
    } catch {
      // ignore
    }
    currentMediaRecorder = null;
  }
  if (currentMediaStream) {
    try {
      currentMediaStream.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    currentMediaStream = null;
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
