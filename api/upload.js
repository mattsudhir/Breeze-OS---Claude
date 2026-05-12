// Vercel Serverless Function — chat attachment upload broker.
//
// We use Vercel Blob's client-direct-upload pattern: the browser hits
// us once to get a signed token, then uploads the file straight to
// Blob storage with that token. The bytes never pass through this
// function, which means we're not bound by Vercel's 4.5MB request
// body cap and can ingest a full iPhone photo without trouble.
//
// Flow (driven by `upload()` from @vercel/blob/client on the frontend):
//   1. Client calls /api/upload with body { type: 'blob.generate-client-token', ... }
//   2. handleUpload validates and signs a token scoped to one upload
//   3. Client uploads directly to blob.vercel-storage.com using the token
//   4. Client calls /api/upload again with { type: 'blob.upload-completed', ... }
//      so we can record the upload (currently a no-op, hook for audit later)
//
// Environment variables:
//   BLOB_READ_WRITE_TOKEN  – auto-injected by Vercel when the project is
//                            connected to a Blob store (Settings → Storage)

import { handleUpload } from '@vercel/blob/client';

// Cap accepted content types so the agent always receives something it
// can pass through to AppFolio's charge attachment endpoint. JPEG/PNG/HEIC
// covers phone-camera photos, PDF covers vendor invoices.
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
];

// 30MB matches AppFolio's documented per-attachment limit. We enforce
// here so users learn early when a file is too big.
const MAX_BYTES = 30 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error:
        'BLOB_READ_WRITE_TOKEN is not configured. In Vercel → Storage, ' +
        'create a Blob store and connect it to this project. The token ' +
        'is injected automatically.',
    });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname /*, clientPayload */) => {
        // Auth hook. Today the chat surface is open inside Breeze OS,
        // so we don't gate by user yet — once we have authenticated
        // sessions we'll check req for the user identity here.
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          // Force public access — AppFolio's attachment fetcher needs
          // to be able to GET the URL without auth.
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ pathname }),
        };
      },
      onUploadCompleted: async ({ blob /*, tokenPayload */ }) => {
        // Hook for audit logging, virus scanning, etc. Currently a
        // no-op — the URL is in the response and the agent picks it
        // up from the user's chat message.
        console.log('[upload] blob completed:', blob.url);
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    // handleUpload throws specific errors with helpful messages
    // (token expired, file too large, content type not allowed, etc.)
    console.error('[upload] handleUpload failed:', err);
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
}
