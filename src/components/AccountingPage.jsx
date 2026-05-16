// Accounting workspace. Tabbed view over the Stage 1-3 backend.
//
// Tabs:
//   Chart of Accounts  — live, reads /api/admin/list-gl-accounts
//   Journal Entries    — placeholder (next iteration)
//   Receivables        — placeholder
//   Receipts           — placeholder
//   Deposits           — placeholder
//   Bank Accounts      — placeholder
//   Reports            — placeholder (Stage 7)
//
// The admin endpoint is gated by BREEZE_ADMIN_TOKEN. The page asks
// for the token on first load, stashes it in sessionStorage (NOT
// localStorage — short-lived for safety), and reuses it for every
// subsequent fetch. Clearing the browser tab clears the token.

SEE_FILE_BELOW_PLACEHOLDER