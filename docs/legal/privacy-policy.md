# Privacy Policy — Breeze OS

> ⚠️ **DRAFT FOR LEGAL REVIEW.** This document is intentionally
> written in plain English by a non-lawyer to give counsel a clean
> starting point. Every section needs review against the
> jurisdictions Breeze operates in (Florida, then nationwide) and
> against current CCPA / state privacy laws. Square-bracketed
> `[placeholders]` are facts only you can confirm. Do NOT publish
> until reviewed.

**Effective date:** [DATE WHEN PUBLISHED]
**Last updated:** [DATE]

## 1. Who we are

Breeze OS ("Breeze," "we," "us," or "our") is a property management
and accounting platform operated by [LEGAL ENTITY NAME], a
[STATE OF INCORPORATION] [LLC / corporation], with its principal
place of business at [BUSINESS ADDRESS].

This Privacy Policy explains what personal information we collect
when you use Breeze OS, how we use it, who we share it with, and
the choices you have.

By using Breeze OS, you agree to this Privacy Policy.

## 2. What information we collect

### 2.1 Information you provide directly

- **Account information**: name, email, phone, password
  (cryptographically hashed; never stored in plain text).
- **Organization information**: business name, address, contact
  details for the property manager or owner using Breeze.
- **Property and tenant information that you enter or import**:
  property addresses, unit details, tenant names and contact
  information, lease terms, rent amounts, maintenance tickets,
  notes.
- **Payment information**: when you set up rent processing or
  vendor payments, the routing/account details necessary to send
  or receive funds (handled via our payment processor, not stored
  in our database).

### 2.2 Information we collect automatically

- **Usage data**: pages viewed, features used, timestamps, IP
  address, browser type, device identifiers.
- **Diagnostic data**: error logs and performance metrics. We
  redact sensitive payloads (account tokens, passwords, full
  account numbers) before storing.

### 2.3 Information we collect from third parties

- **From your bank, via Plaid**: when you choose to connect a bank
  account using Plaid Link, Plaid provides us with the account
  name, account type, last four digits of the account number,
  current balance, and transaction history (date, amount,
  description, merchant name). We never receive or store full bank
  account numbers, online banking credentials, or your bank
  password. See Section 5 for the Plaid disclosure.
- **From your property management system, via integration
  (currently AppFolio)**: property, unit, lease, tenant, and
  maintenance ticket records that you authorize us to import. We
  only access data for organizations you administer.

## 3. How we use information

We use the information described in Section 2 to:

- **Provide the Service**: render dashboards, sync property and
  financial data between your PMS and your bank, reconcile
  transactions, generate reports, send notifications.
- **Maintain and improve the Service**: diagnose bugs, plan
  capacity, design new features.
- **Communicate with you**: respond to support requests, send
  service-related notices (security alerts, billing, downtime).
- **Comply with legal obligations**: tax reporting, anti-money-
  laundering controls, lawful requests from authorities.
- **Detect and prevent fraud or abuse**.

We do **not** sell personal information. We do **not** use
personal information to train AI models for purposes unrelated to
operating the Service for the customer who provided it.

## 4. Who we share information with

We share personal information only with the parties listed below,
and only as needed to operate the Service.

- **Plaid Inc.** — for bank account linking and transaction sync.
  Plaid's privacy policy applies to data Plaid collects from you
  directly: https://plaid.com/legal/#consumers
- **AppFolio Inc.** (or any other PMS you integrate with) — to
  read property/tenant/lease/work-order data on your behalf using
  credentials you provide. We act on your authorization.
- **Vercel Inc.** — our hosting provider; receives all incoming
  request data necessary to route traffic. Vercel does not access
  application data.
- **[POSTGRES PROVIDER, e.g. "Neon Inc."]** — managed Postgres
  database for storing the operational data described in
  Section 2.
- **[PAYMENT PROCESSOR, e.g. "Stripe Inc." / "[Bill.com Inc.]"]** —
  to process incoming and outgoing payments on your behalf.
- **AI service providers (Anthropic PBC and others)** — for
  AI-assisted features (chat, summarization). Customer data passed
  to these providers is processed under their respective data
  processing agreements; we minimize the data sent and never send
  bank account numbers, passwords, or other secrets.
- **Service providers we use to operate the business** —
  customer support tools, monitoring, transactional email,
  analytics. Each is bound by contract to use the data only to
  provide their service to us.
- **Law enforcement, regulators, or other parties when required by
  law** — in response to a valid legal process, or when we have a
  good-faith belief that disclosure is necessary to protect our
  rights, your safety, or the safety of others.
- **In a business transaction** — if Breeze is involved in a
  merger, acquisition, or sale of assets, personal information may
  be transferred to the acquiring party, subject to this Privacy
  Policy.

## 5. Plaid disclosure (required)

> Breeze OS uses Plaid Inc. ("Plaid") to gather end users' data
> from financial institutions. By using our service, you grant
> Breeze OS and Plaid the right, power, and authority to act on
> your behalf to access and transmit your personal and financial
> information from the relevant financial institution. You agree
> to your personal and financial information being transferred,
> stored, and processed by Plaid in accordance with the
> [Plaid End User Privacy Policy](https://plaid.com/legal/#consumers).

We use Plaid's `transactions` product. We do **not** request the
`auth`, `identity`, `assets`, `income`, `investments`, or
`liabilities` products. This means we receive transaction data and
the last four digits of your account number; we do not receive
full account numbers, your online banking credentials, or your
Social Security Number.

## 6. How we protect information

- **Encryption in transit**: all traffic between your browser, our
  servers, and our integration partners is encrypted via TLS 1.2
  or higher.
- **Encryption at rest**: secrets (bank access tokens, API keys)
  are encrypted with AES-256-GCM before being written to our
  database. Other personal data is protected by our hosting
  provider's encryption-at-rest controls.
- **Access controls**: production system access is limited to
  authorized engineers and requires multi-factor authentication.
- **Audit logging**: administrative actions and errors are
  recorded for security review.

No system is perfectly secure. If we become aware of a breach
affecting your personal information, we will notify you in
accordance with applicable law.

## 7. How long we keep information

- **Account and organization data**: while your account is active
  and for [RETENTION PERIOD, e.g. "12 months"] after closure to
  meet legal, accounting, and dispute-resolution needs.
- **Bank transaction data synced from Plaid**: while the linked
  account is active, plus 7 years for accounting record retention.
- **Diagnostic logs**: 30 days, then aggregated.
- **Cryptographic secrets**: deleted immediately on disconnect /
  account closure.

You may request deletion of your personal information at any
time (see Section 9), subject to legal retention requirements.

## 8. International transfers

Our service is operated from the United States. If you access
Breeze OS from outside the U.S., you consent to the transfer of
your information to the U.S., which may have different data
protection laws than your jurisdiction.

## 9. Your rights and choices

Depending on where you live, you may have rights to:

- **Access** the personal information we hold about you.
- **Correct** inaccurate or incomplete information.
- **Delete** your personal information.
- **Object to** or **restrict** certain processing.
- **Receive a portable copy** of your information.
- **Withdraw consent** for Plaid-based bank linking at any time,
  by disconnecting the bank from Breeze's settings. Disconnecting
  stops new transaction sync immediately; historical data we
  already synced will be retained per Section 7.

To exercise these rights, email [PRIVACY EMAIL, e.g. "privacy@..."].
We respond within 30 days, or sooner if required by law.

California residents have rights under the CCPA / CPRA, including
the right not to be discriminated against for exercising those
rights. We do not sell personal information.

## 10. Children's privacy

Breeze OS is not directed to children under 16. We do not
knowingly collect personal information from children. If you
believe a child has provided us with personal information, contact
us at [PRIVACY EMAIL] and we will delete it.

## 11. Changes to this Privacy Policy

We may update this Privacy Policy from time to time. When we make
material changes, we will notify account administrators by email
and update the "Last updated" date above. Continued use of the
Service after the effective date of the update constitutes
acceptance.

## 12. Contact

Questions about this Privacy Policy:
[PRIVACY EMAIL, e.g. "privacy@breezepropertygroup.com"]
[BUSINESS ADDRESS]
