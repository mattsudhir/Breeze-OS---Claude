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

    const rawContentType = req.headers['content-type'] || 'audio/webm';
    // Strip any codec suffix — "audio/webm;codecs=opus" → "audio/webm".
    // ElevenLabs Scribe parses the file by the actual bytes, but some
    // multipart implementations get confused by parameterised MIME types.
    const bareType = rawContentType.split(';')[0].trim();

    // Map to a sensible extension for the multipart filename. Scribe
    // detects format from content, but a matching extension keeps the
    // API happy on strict paths.
    const ext =
      bareType.includes('webm') ? 'webm'
        : bareType.includes('ogg') ? 'ogg'
        : bareType.includes('wav') ? 'wav'
        : bareType.includes('mpeg') || bareType.includes('mp3') ? 'mp3'
        : bareType.includes('mp4') || bareType.includes('m4a') ? 'm4a'
        : 'webm';

    console.log(`[stt] received ${audioBuffer.length} bytes, type=${rawContentType}, bareType=${bareType}, ext=${ext}`);

    // ElevenLabs Scribe expects multipart/form-data with the audio file
    // and a model_id field. Node's built-in FormData + Blob handle this.
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append(
      'file',
      new Blob([audioBuffer], { type: bareType }),
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

    const responseText = await elResponse.text();
    console.log(`[stt] ElevenLabs status=${elResponse.status}, body=${responseText.slice(0, 500)}`);

    if (!elResponse.ok) {
      console.error('[stt] ElevenLabs error:', elResponse.status, responseText);
      const isQuota =
        elResponse.status === 401 ||
        elResponse.status === 402 ||
        /quota/i.test(responseText);
      return res.status(elResponse.status).json({
        ok: false,
        error: `ElevenLabs ${elResponse.status}: ${responseText.slice(0, 400)}`,
        quota_exceeded: isQuota,
      });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[stt] Failed to parse ElevenLabs response as JSON:', parseErr);
      return res.status(500).json({
        ok: false,
        error: `Scribe returned non-JSON response: ${responseText.slice(0, 200)}`,
      });
    }

    // Scribe returns { text, language_code, language_probability, words[] }
    const text = (data.text || '').trim();

    console.log(`[stt] transcribed ${audioBuffer.length} bytes → "${text.slice(0, 100)}" (lang=${data.language_code})`);

    // If transcription came back empty, include the full Scribe response
    // in the error so the client can surface what's actually happening.
    if (!text) {
      return res.status(200).json({
        ok: true,
        text: '',
        language: data.language_code,
        debug: {
          audio_bytes: audioBuffer.length,
          content_type: rawContentType,
          scribe_raw: data,
        },
      });
    }

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
