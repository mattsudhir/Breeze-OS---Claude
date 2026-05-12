// POST /api/admin/plaid-exchange-public-token?secret=<TOKEN>
// body: { public_token, metadata: { institution: { name }, accounts: [{ id, name, mask, type, subtype }] } }
//
// Final step of the Plaid Link flow. Exchanges the one-time
// public_token for a long-lived access_token, fetches the accounts
// behind the linked Item, and creates a bank_account row per
// account if one doesn't already exist for the org. The
// access_token is encrypted via AES-256-GCM (BREEZE_ENCRYPTION_KEY)
// before being stored. The same item_id is stored on every account
// that came in via the same Link session.
//
// If a bank_account already exists for a given Plaid account_id,
// it's updated (re-link case). New bank_accounts are inserted as
// standalone GL accounts under code "P-<short-id>" so the COA
// browser surfaces them; the user can later edit the GL code or
// re-classify.

import { and, eq } from 'drizzle-orm';
import {
  withAdminHandler,
  getDefaultOrgId,
  parseBody,
} from '../../lib/adminHelpers.js';
import { getDb, schema } from '../../lib/db/index.js';
import {
  exchangePublicToken,
  getAccounts,
  isPlaidConfigured,
} from '../../lib/backends/plaid.js';
import { encryptText, isEncryptionConfigured } from '../../lib/encryption.js';
import { applyDefaultTagsForAccount } from '../../lib/accounting/applyDefaultGlAccountTags.js';

function plaidTypeToBankAccountType(plaidType, plaidSubtype) {
  if (plaidType === 'credit') return 'credit_card';
  if (plaidType === 'investment') return 'investment';
  if (plaidSubtype === 'money market') return 'money_market';
  if (plaidSubtype === 'savings') return 'savings';
  return 'checking';
}

function plaidTypeToGlClassification(plaidType) {
  if (plaidType === 'credit') {
    return {
      accountType: 'liability',
      accountSubtype: 'credit_card_payable',
      normalBalance: 'credit',
    };
  }
  return {
    accountType: 'asset',
    accountSubtype: 'cash',
    normalBalance: 'debit',
  };
}

export default withAdminHandler(async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!isPlaidConfigured()) {
    return res.status(503).json({ ok: false, error: 'Plaid not configured.' });
  }
  if (!isEncryptionConfigured()) {
    return res.status(503).json({
      ok: false,
      error:
        'BREEZE_ENCRYPTION_KEY not configured. Generate 32 bytes of hex and add to Vercel env vars before linking Plaid.',
    });
  }

  const body = parseBody(req);
  const publicToken = body.public_token;
  if (!publicToken) {
    return res.status(400).json({ ok: false, error: 'public_token required' });
  }

  const organizationId = await getDefaultOrgId();
  const db = getDb();

  let exchanged;
  try {
    exchanged = await exchangePublicToken(publicToken);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `exchange failed: ${err.message}` });
  }
  const { access_token: accessToken, item_id: itemId } = exchanged;

  let plaidAccounts;
  try {
    plaidAccounts = await getAccounts(accessToken);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `accounts fetch failed: ${err.message}` });
  }

  const encryptedToken = encryptText(accessToken);

  const result = await db.transaction(async (tx) => {
    const created = [];
    const updated = [];

    for (const acct of plaidAccounts) {
      // Already linked to a bank_account in this org?
      const [existing] = await tx
        .select({ id: schema.bankAccounts.id, glAccountId: schema.bankAccounts.glAccountId })
        .from(schema.bankAccounts)
        .where(
          and(
            eq(schema.bankAccounts.organizationId, organizationId),
            eq(schema.bankAccounts.plaidAccountId, acct.account_id),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(schema.bankAccounts)
          .set({
            plaidItemId: itemId,
            plaidAccessTokenEncrypted: encryptedToken,
            plaidStatus: 'linked',
            accountLast4: acct.mask || null,
            currentBalanceCents:
              acct.balances?.current != null
                ? Math.round(acct.balances.current * 100)
                : null,
            balanceAsOf: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.bankAccounts.id, existing.id));
        updated.push({ bank_account_id: existing.id, plaid_account_id: acct.account_id });
        continue;
      }

      // No existing bank_account — create a new GL + bank_account
      // pair. The GL gets code "P-<8 chars of plaid_account_id>" so
      // it's distinguishable in the chart of accounts.
      const classification = plaidTypeToGlClassification(acct.type);
      const glCode = `P-${acct.account_id.slice(0, 8).toUpperCase()}`;
      const glName = acct.official_name || acct.name || `Plaid ${acct.account_id.slice(0, 6)}`;

      const [gl] = await tx
        .insert(schema.glAccounts)
        .values({
          organizationId,
          code: glCode,
          name: glName,
          accountType: classification.accountType,
          accountSubtype: classification.accountSubtype,
          normalBalance: classification.normalBalance,
          isActive: true,
          isSystem: false,
          isBank: false, // trigger will flip to true on bank_account insert
          currency: 'USD',
          notes: `Auto-created during Plaid link of item ${itemId}.`,
        })
        .returning({
          id: schema.glAccounts.id,
          code: schema.glAccounts.code,
          name: schema.glAccounts.name,
        });

      await applyDefaultTagsForAccount(tx, gl.id, {
        code: glCode,
        name: glName,
        accountType: classification.accountType,
        accountSubtype: classification.accountSubtype,
      });

      const [bank] = await tx
        .insert(schema.bankAccounts)
        .values({
          organizationId,
          glAccountId: gl.id,
          displayName: glName,
          institutionName: body.metadata?.institution?.name || null,
          accountType: plaidTypeToBankAccountType(acct.type, acct.subtype),
          accountLast4: acct.mask || null,
          currentBalanceCents:
            acct.balances?.current != null
              ? Math.round(acct.balances.current * 100)
              : null,
          balanceAsOf: new Date(),
          plaidItemId: itemId,
          plaidAccountId: acct.account_id,
          plaidStatus: 'linked',
          plaidAccessTokenEncrypted: encryptedToken,
          notes: `Linked via Plaid at ${new Date().toISOString()}.`,
        })
        .returning({ id: schema.bankAccounts.id });

      created.push({
        bank_account_id: bank.id,
        gl_account_id: gl.id,
        gl_code: gl.code,
        plaid_account_id: acct.account_id,
        display_name: glName,
      });
    }

    return { created, updated };
  });

  return res.status(200).json({
    ok: true,
    item_id: itemId,
    plaid_accounts_seen: plaidAccounts.length,
    created_count: result.created.length,
    updated_count: result.updated.length,
    created: result.created,
    updated: result.updated,
  });
});
