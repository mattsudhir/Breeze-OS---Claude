// AppFolio webhook helpers — JWS signature verification + topic
// → followable-entity mapping.
//
// AppFolio signs every webhook with a detached JWS in the
// X-JWS-Signature header (format: <header>..<signature>, two dots
// because the payload section is empty in compact-detached form).
// The signing key rotates and is published as a JWKS at
// https://api.appfolio.com/.well-known/jwks.json keyed on `kid`.
//
// We use jose's flattenedVerify which natively handles RFC 7797
// (b64:false unencoded payload) per AppFolio's signed protected
// header. That means the raw HTTP body is passed verbatim — we
// don't base64-encode it ourselves before verification, jose +
// the protected header sort that out.

import { flattenedVerify, createRemoteJWKSet } from 'jose';

const JWKS_URL = 'https://api.appfolio.com/.well-known/jwks.json';

// Singleton — jose caches keys by kid and refreshes on rotation,
// so one JWKS handle for the lifetime of a serverless instance is
// the right pattern (no extra cold-start fetch per webhook).
let jwksCache = null;
function getJwks() {
  if (!jwksCache) jwksCache = createRemoteJWKSet(new URL(JWKS_URL));
  return jwksCache;
}

/**
 * Verify the X-JWS-Signature on a webhook delivery.
 *
 * @param {Buffer|string} rawBody  — exact bytes of the HTTP body
 * @param {string} jwsHeader       — X-JWS-Signature header value
 * @returns {Promise<{ verified: true, protectedHeader }>}
 * @throws on missing/invalid signature or verification failure
 */
export async function verifyWebhookSignature(rawBody, jwsHeader) {
  if (!jwsHeader || typeof jwsHeader !== 'string') {
    throw new Error('Missing X-JWS-Signature header');
  }
  // Detached compact form: <protected>..<signature>
  const parts = jwsHeader.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid X-JWS-Signature format — expected three "." separated parts, got ${parts.length}.`,
    );
  }
  const [protectedHeader, , signature] = parts;
  if (!protectedHeader || !signature) {
    throw new Error('X-JWS-Signature header missing protected or signature segment');
  }

  // jose's flattenedVerify takes the parts split out and respects
  // the b64 critical header in the protected section, so we pass
  // the raw payload (Buffer or string) and let jose do the right
  // thing per RFC 7797.
  const payload =
    typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;

  const result = await flattenedVerify(
    { protected: protectedHeader, payload, signature },
    getJwks(),
  );
  return { verified: true, protectedHeader: result.protectedHeader };
}

// AppFolio webhook topic → our follows entity_type. Only topics we
// actually let users follow are mapped; others are recognised
// (logged) but not fanned out for v1.
//
// See lib/notifications.js ENTITY_TYPES for the canonical list.
export const TOPIC_TO_ENTITY_TYPE = {
  tenants: 'tenant',
  properties: 'property',
  units: 'unit',
  work_orders: 'work_order',
  charges: 'charge',
  leases: 'lease',
  leads: 'lead',
};

// Format the human-readable verb of a webhook event for the
// notification title. AppFolio sends 'create' / 'update' / 'destroy'
// plus a few topic-specific kinds (e.g. inventory_details_created).
export function describeEventType(eventType) {
  if (!eventType) return 'changed';
  const t = eventType.toLowerCase();
  if (t === 'create' || t.endsWith('_created')) return 'created';
  if (t === 'update' || t.endsWith('_updated')) return 'updated';
  if (t === 'destroy' || t.endsWith('_destroyed')) return 'deleted';
  return t;
}

// Build a default notification title from the topic + event type
// when we don't have a fetched resource label yet. Phase 2 will
// enrich these by calling list_X tools to get the actual name.
//
//   tenants + create → "Tenant created"
//   work_orders + update → "Work order updated"
export function defaultTitle(topic, eventType) {
  const entityType = TOPIC_TO_ENTITY_TYPE[topic] || topic;
  const noun = entityType.replace(/_/g, ' ');
  const noun_capitalised = noun.charAt(0).toUpperCase() + noun.slice(1);
  return `${noun_capitalised} ${describeEventType(eventType)}`;
}
