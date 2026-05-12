// Bill.com backend — vendor payment scheduling.
//
// Bill.com's API is REST-ish with session tokens (no Authorization
// header — every call sends sessionId in the form body). Authenticate
// once, cache the sessionId for the cold-start lifetime of the
// serverless instance.
//
// Env vars:
//   BILL_COM_API_URL       e.g. 'https://api-sandbox.bill.com/api/v2'
//                          (or production: 'https://api.bill.com/api/v2')
//   BILL_COM_DEV_KEY       Bill.com developer key (from their dashboard)
//   BILL_COM_USER_NAME     Bill.com login email
//   BILL_COM_PASSWORD      Bill.com login password
//   BILL_COM_ORG_ID        Bill.com organization id (their tenant)
//
// Reference: https://developer.bill.com/docs

const DEFAULT_API_URL = 'https://api-sandbox.bill.com/api/v2';

export function isBillComConfigured() {
  return Boolean(
    process.env.BILL_COM_DEV_KEY &&
    process.env.BILL_COM_USER_NAME &&
    process.env.BILL_COM_PASSWORD &&
    process.env.BILL_COM_ORG_ID,
  );
}

let cachedSession = null; // { sessionId, expiresAt }

function apiBase() {
  return process.env.BILL_COM_API_URL || DEFAULT_API_URL;
}

async function post(path, fields) {
  const url = `${apiBase()}${path}`;
  const form = new URLSearchParams(fields);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Bill.com ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.response_status !== 0) {
    const err = json.response_data?.error_message || JSON.stringify(json).slice(0, 200);
    throw new Error(`Bill.com ${path} error: ${err}`);
  }
  return json.response_data;
}

async function login() {
  if (cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession.sessionId;
  if (!isBillComConfigured()) throw new Error('Bill.com not configured');
  const data = await post('/Login.json', {
    devKey: process.env.BILL_COM_DEV_KEY,
    userName: process.env.BILL_COM_USER_NAME,
    password: process.env.BILL_COM_PASSWORD,
    orgId: process.env.BILL_COM_ORG_ID,
  });
  cachedSession = {
    sessionId: data.sessionId,
    // Sessions live ~35 min; cache for 30 to be safe.
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  return cachedSession.sessionId;
}

async function authenticated(path, fields) {
  const sessionId = await login();
  return post(path, {
    sessionId,
    devKey: process.env.BILL_COM_DEV_KEY,
    ...fields,
  });
}

/**
 * Schedule an outbound vendor payment via Bill.com.
 *
 * Bill.com calls these "vendor payments" — you specify the vendor id
 * (their internal id, mapped from our vendors.bill_com_vendor_id),
 * the amount, the bank account to draw from (their id), and one or
 * more bill ids if you want to allocate. We pass only the metadata
 * here; the caller is responsible for resolving our internal ids to
 * Bill.com ids.
 *
 * @param {object} params
 * @param {string} params.billComVendorId     vendor's Bill.com id
 * @param {string} params.billComBankAccountId  bank account on Bill.com
 * @param {number} params.amountCents
 * @param {string} params.paymentDate         YYYY-MM-DD
 * @param {string} [params.processDate]       YYYY-MM-DD (when Bill.com runs the ACH)
 * @param {string} [params.deliveryMethod]    'ACH' | 'Check' | 'Card'
 * @param {string} [params.memo]
 * @returns {Promise<{ billComPaymentId: string, status: string, raw: object }>}
 */
export async function schedulePayment(params) {
  const {
    billComVendorId,
    billComBankAccountId,
    amountCents,
    paymentDate,
    processDate,
    deliveryMethod = 'ACH',
    memo,
  } = params;
  if (!billComVendorId) throw new Error('schedulePayment: billComVendorId required');
  if (!billComBankAccountId) throw new Error('schedulePayment: billComBankAccountId required');
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('schedulePayment: amountCents must be a positive integer');
  }
  if (!paymentDate) throw new Error('schedulePayment: paymentDate required');

  // Bill.com expects dollar amounts as strings with 2 decimal places.
  const amount = (amountCents / 100).toFixed(2);

  // Bill.com's "PayBill" operation creates a SentPay record.
  const data = await authenticated('/Crud/Create/SentPay.json', {
    data: JSON.stringify({
      obj: {
        entity: 'SentPay',
        vendorId: billComVendorId,
        amount,
        processDate: processDate || paymentDate,
        bankAccountId: billComBankAccountId,
        toPrintCheck: deliveryMethod === 'Check' ? '1' : '0',
        description: memo || '',
      },
    }),
  });

  return {
    billComPaymentId: data.id,
    status: data.paymentStatus || 'Scheduled',
    raw: data,
  };
}

/**
 * Fetch a payment by Bill.com id — used by the status sync.
 */
export async function getPayment(billComPaymentId) {
  if (!billComPaymentId) throw new Error('getPayment: id required');
  const data = await authenticated('/Crud/Read/SentPay.json', {
    data: JSON.stringify({ id: billComPaymentId }),
  });
  return data;
}

/**
 * List recent payments (for the reconciliation poll).
 */
export async function listRecentPayments(opts = {}) {
  const { maxResults = 100, sinceDate } = opts;
  const filters = [];
  if (sinceDate) filters.push({ field: 'createdTime', op: '>', value: sinceDate });
  const data = await authenticated('/List/SentPay.json', {
    data: JSON.stringify({
      start: 0,
      max: maxResults,
      filters,
      sort: [{ field: 'createdTime', asc: '0' }],
    }),
  });
  return data || [];
}
