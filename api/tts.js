// Vercel Serverless Function — ElevenLabs text-to-speech proxy.
//
// Environment variables:
//   ELEVENLABS_API_KEY   – required
//   ELEVENLABS_VOICE_ID  – optional, defaults to Sarah
//
// Takes { text, voiceId? } and returns audio/mpeg binary.

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';    // fast, high quality
const MAX_TEXT_LENGTH = 2000; // guardrail to avoid burning quota on runaway inputs

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ELEVENLABS_API_KEY not configured in Vercel env vars',
    });
  }

  try {
    const { text, voiceId } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text (string) required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({
        error: `text too long (${text.length} chars, max ${MAX_TEXT_LENGTH})`,
      });
    }

    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

    const elResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: DEFAULT_MODEL_ID,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!elResponse.ok) {
      const errText = await elResponse.text();
      console.error('ElevenLabs error:', elResponse.status, errText);
      // Surface quota errors clearly so the frontend can fall back
      const isQuota =
        elResponse.status === 401 ||
        elResponse.status === 402 ||
        /quota/i.test(errText);
      return res.status(elResponse.status).json({
        error: `ElevenLabs ${elResponse.status}: ${errText}`,
        quota_exceeded: isQuota,
      });
    }

    const arrayBuffer = await elResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('TTS handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
