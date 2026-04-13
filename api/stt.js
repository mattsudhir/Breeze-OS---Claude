// Vercel Serverless Function — ElevenLabs Scribe speech-to-text proxy.
//
// Browser-native speech recognition (webkitSpeechRecognition) works fine
// on Chrome and Android Chrome but is unreliable on desktop Edge (network
// errors reaching Microsoft's speech service) and absent on Firefox/Safari.
// This endpoint is the server-side fallback: the client captures audio via
// MediaRecorder, POSTs the blob here, and we proxy to ElevenLabs Scribe
// using the same API key we already use for TTS.
//
// Request: POST with Content-Type: audio/webm (or audio/wav, audio/ogg,
// audio/mpeg, etc.) and the raw audio bytes in the body.
// Response: { ok: true, text: "the transcript" } or { ok: false, error }.
//
// Environment variables:
//   ELEVENLABS_API_KEY – required, same key used by /api/tts

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB — plenty for a voice note

export const config = {
  api: {
    // Disable body parsing so we can stream the raw audio bytes straight
    // through. The default JSON parser would otherwise corrupt the binary.
    bodyParser: false,
  },
};

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        reject(new Error(`audio body too large (> ${MAX_AUDIO_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'ELEVENLABS_API_KEY not configured in Vercel env vars',
    });
  }

  try {
    const audioBuffer = await readRawBody(req);
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty audio body' });
    }

    const contentType = req.headers['content-type'] || 'audio/webm';
    // Map the browser's MIME to a sensible file extension for ElevenLabs.
    // Scribe is format-aware so as long as the extension matches the actual
    // encoding it'll accept it.
    const ext =
      contentType.includes('webm') ? 'webm'
        : contentType.includes('ogg') ? 'ogg'
        : contentType.includes('wav') ? 'wav'
        : contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3'
        : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a'
        : 'webm';

    // ElevenLabs Scribe expects multipart/form-data with the audio file
    // and a model_id field. Node's built-in FormData + Blob handle this.
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append(
      'file',
      new Blob([audioBuffer], { type: contentType }),
      `recording.${ext}`,
    );

    const elResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        // Do NOT set Content-Type manually; fetch + FormData set the
        // correct multipart boundary automatically.
      },
      body: form,
    });

    if (!elResponse.ok) {
      const errText = await elResponse.text();
      console.error('[stt] ElevenLabs error:', elResponse.status, errText);
      const isQuota =
        elResponse.status === 401 ||
        elResponse.status === 402 ||
        /quota/i.test(errText);
      return res.status(elResponse.status).json({
        ok: false,
        error: `ElevenLabs ${elResponse.status}: ${errText.slice(0, 400)}`,
        quota_exceeded: isQuota,
      });
    }

    const data = await elResponse.json();
    // Scribe returns { text, language_code, language_probability, words[] }
    const text = (data.text || '').trim();

    console.log(`[stt] transcribed ${audioBuffer.length} bytes → "${text.slice(0, 80)}"`);

    return res.status(200).json({
      ok: true,
      text,
      language: data.language_code,
    });
  } catch (err) {
    console.error('[stt] handler error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Unknown error' });
  }
}
