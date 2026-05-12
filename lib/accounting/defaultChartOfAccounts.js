// Default chart of accounts for a new Breeze OS organization.
//
// ~120 accounts across 9 sections, designed for residential property
// management. Informed by analysis of Breeze Property Group's
// AppFolio chart (254 accounts) — see
// docs/accounting/appfolio-coa-analysis.md for the rationale behind
// each design choice.
//
// Shape of each entry (all keys optional except code/name/accountType/
// normalBalance):
//
//   code            text — unique per org. 4-digit numeric in the
//                   default template, but the schema column is text
//                   so customers can use any scheme.
//   name            text — human-readable display name.
//   accountType     'asset' | 'liability' | 'equity' | 'income' |
//                   'expense' (matches gl_account_type enum).
//   accountSubtype  free-form text taxonomy — eventually an enum once
//                   the vocabulary settles. Drives reporting,
//                   suggested by GL-posting service helpers.
//   normalBalance   'debit' | 'credit'. Derived from accountType but
//                   stored explicitly so posting code never has to
//                   re-derive (and to allow contra accounts to break
//                   the pattern, e.g. contra-income accounts have
//                   debit normal balance).
//   parentCode      code of parent account; null for roots. The
//                   seeder resolves this to parent_id at insert time.
//   isSystem        true for accounts the platform requires — Cash,
//                   Undeposited Funds, Suspense, AR, AP, Security
//                   Deposits Held, Prepaid Rent / Tenant Credits,
//                   Owner Funds Held, Credit Cards Payable, Retained
//                   Earnings (Current Year), Opening Balance Equity.
//                   isSystem rows can be renamed but never deleted.
//   notes           text — short rationale or operational hint.
//
// Trust-accounting fields (is_trust, trust_purpose) are intentionally
// NOT set here; they default to false / null per the schema and get
// flipped on per-account by the trust v2 onboarding flow.

export const DEFAULT_CHART_OF_ACCOUNTS = [
  // ── Assets (1000–1999) ──────────────────────────────────────────

  // Cash & equivalents — kept deliberately minimal. Per-bank-account
  // entries live as bank_accounts rows linked 1:1 via UNIQUE FK to
  // these GL accounts, NOT as separate GL accounts (see
  // architecture.md, commitment #2).
  { code: '1100', name: 'Cash - Operating', accountType: 'asset', accountSubtype: 'cash', normalBalance: 'debit', isSystem: true,
    notes: 'Canonical Cash GL paired 1:1 with the primary operating bank_account.' },
  { code: '1110', name: 'Undeposited Funds', accountType: 'asset', accountSubtype: 'cash', normalBalance: 'debit', isSystem: true,
    notes: 'Receipts post here first; the deposit posting then moves them to a Cash GL.' },
  { code: '1120', name: 'Settlement / Closing Clearing', accountType: 'asset', accountSubtype: 'cash', normalBalance: 'debit',
    notes: 'Real-estate closing settlement statements pass through here pending allocation.' },
  { code: '1130', name: 'Suspense - Unreconciled', accountType: 'asset', accountSubtype: 'cash', normalBalance: 'debit', isSystem: true,
    notes: 'Unmatched bank transactions and orphaned receipts park here pending human review.' },

  // Receivables.
  { code: '1200', name: 'Accounts Receivable', accountType: 'asset', accountSubtype: 'accounts_receivable', normalBalance: 'debit', isSystem: true,
    notes: 'Parent AR account. Per-tenant balances derive from journal_lines.tenant_id.' },
  { code: '1210', parentCode: '1200', name: 'AR - Rent', accountType: 'asset', accountSubtype: 'accounts_receivable', normalBalance: 'debit', isSystem: true },
  { code: '1220', parentCode: '1200', name: 'AR - Late Fees', accountType: 'asset', accountSubtype: 'accounts_receivable', normalBalance: 'debit' },
  { code: '1230', parentCode: '1200', name: 'AR - Utility Billbacks', accountType: 'asset', accountSubtype: 'accounts_receivable', normalBalance: 'debit' },
  { code: '1240', parentCode: '1200', name: 'AR - Other Charges', accountType: 'asset', accountSubtype: 'accounts_receivable', normalBalance: 'debit' },

  // Other current assets.
  { code: '1300', name: 'Prepaid Expenses', accountType: 'asset', accountSubtype: 'prepaid', normalBalance: 'debit' },
  { code: '1310', name: 'Earnest Money Deposits Held', accountType: 'asset', accountSubtype: 'prepaid', normalBalance: 'debit' },
  { code: '1400', name: 'Loans and Advances Due', accountType: 'asset', accountSubtype: 'receivable_other', normalBalance: 'debit' },

  // Fixed assets.
  { code: '1500', name: 'Land', accountType: 'asset', accountSubtype: 'fixed_asset', normalBalance: 'debit' },
  { code: '1600', name: 'Buildings', accountType: 'asset', accountSubtype: 'fixed_asset', normalBalance: 'debit',
    notes: 'Parent. Cost and accumulated depreciation live in sub-accounts.' },
  { code: '1610', parentCode: '1600', name: 'Buildings - Cost', accountType: 'asset', accountSubtype: 'fixed_asset', normalBalance: 'debit' },
  { code: '1620', parentCode: '1600', name: 'Buildings - Accumulated Depreciation', accountType: 'asset', accountSubtype: 'accumulated_depreciation', normalBalance: 'credit',
    notes: 'Contra-asset: credit normal balance reduces parent Building Cost on the balance sheet.' },
  { code: '1700', name: 'Other Property Assets', accountType: 'asset', accountSubtype: 'fixed_asset', normalBalance: 'debit' },
  { code: '1710', parentCode: '1700', name: 'Improvements - Cost', accountType: 'asset', accountSubtype: 'fixed_asset', normalBalance: 'debit' },
  { code: '1720', parentCode: '1700', name: 'Improvements - Accumulated Depreciation', accountType: 'asset', accountSubtype: 'accumulated_depreciation', normalBalance: 'credit' },
  { code: '1730', parentCode: '1700', name: 'Escrow Funds Held', accountType: 'asset', accountSubtype: 'prepaid', normalBalance: 'debit' },
  { code: '1740', parentCode: '1700', name: 'Mortgage Escrow - Tax / Insurance', accountType: 'asset', accountSubtype: 'prepaid', normalBalance: 'debit' },
  { code: '1750', parentCode: '1700', name: 'Intangible Assets', accountType: 'asset', accountSubtype: 'intangible_asset', normalBalance: 'debit' },
  { code: '1760', parentCode: '1700', name: 'Intangible Assets - Accumulated Amortization', accountType: 'asset', accountSubtype: 'accumulated_amortization', normalBalance: 'credit' },

  // ── Liabilities (2000–2999) ─────────────────────────────────────

  { code: '2000', name: 'Accounts Payable', accountType: 'liability', accountSubtype: 'accounts_payable', normalBalance: 'credit', isSystem: true,
    notes: 'Parent AP account. Per-vendor balances derive from journal_lines.vendor_id (Stage 5).' },
  { code: '2010', parentCode: '2000', name: 'AP - Trade Vendors', accountType: 'liability', accountSubtype: 'accounts_payable', normalBalance: 'credit', isSystem: true },
  { code: '2020', parentCode: '2000', name: 'AP - Owner Distributions Pending', accountType: 'liability', accountSubtype: 'accounts_payable', normalBalance: 'credit' },

  // Security deposits — trust-aware in v2 (each row will flip is_trust=true).
  { code: '2100', name: 'Security Deposits Held', accountType: 'liability', accountSubtype: 'security_deposits_held', normalBalance: 'credit', isSystem: true,
    notes: 'Parent. Trust-accounting v2 will flag this entire subtree is_trust=true.' },
  { code: '2110', parentCode: '2100', name: 'Tenant Security Deposits', accountType: 'liability', accountSubtype: 'security_deposits_held', normalBalance: 'credit', isSystem: true },
  { code: '2120', parentCode: '2100', name: 'Pet Deposits', accountType: 'liability', accountSubtype: 'security_deposits_held', normalBalance: 'credit' },
  { code: '2130', parentCode: '2100', name: 'Appliance Deposits', accountType: 'liability', accountSubtype: 'security_deposits_held', normalBalance: 'credit' },
  { code: '2140', parentCode: '2100', name: 'Holding Deposits', accountType: 'liability', accountSubtype: 'security_deposits_held', normalBalance: 'credit' },

  // Tenant credits — corrected from AppFolio's "Expense" classification.
  { code: '2200', name: 'Prepaid Rent / Tenant Credits', accountType: 'liability', accountSubtype: 'tenant_credit', normalBalance: 'credit', isSystem: true,
    notes: 'Money owed back to tenants — a liability, not an expense (AppFolio gets this wrong).' },
  { code: '2210', parentCode: '2200', name: 'Prepaid Rent', accountType: 'liability', accountSubtype: 'tenant_credit', normalBalance: 'credit' },
  { code: '2220', parentCode: '2200', name: 'Tenant Credit Balance', accountType: 'liability', accountSubtype: 'tenant_credit', normalBalance: 'credit' },

  // Owner funds held — trust-aware in v2 (third-party owner managment).
  { code: '2300', name: 'Owner Funds Held', accountType: 'liability', accountSubtype: 'owner_funds_held', normalBalance: 'credit', isSystem: true,
    notes: 'Funds belonging to third-party property owners. Trust v2 flips is_trust=true here.' },
  { code: '2310', parentCode: '2300', name: 'Owner Reserve Holdings', accountType: 'liability', accountSubtype: 'owner_funds_held', normalBalance: 'credit' },

  // Credit cards — native primitive, NOT pasted under Cash.
  { code: '2400', name: 'Credit Cards Payable', accountType: 'liability', accountSubtype: 'credit_card_payable', normalBalance: 'credit', isSystem: true,
    notes: 'Parent. Each credit card is a bank_account row of type credit_card linked 1:1 here or to a sub-account.' },
  { code: '2410', parentCode: '2400', name: 'Credit Card - Operating', accountType: 'liability', accountSubtype: 'credit_card_payable', normalBalance: 'credit', isSystem: true },

  // Mortgages and other long-term liabilities.
  { code: '2500', name: 'Mortgages Payable', accountType: 'liability', accountSubtype: 'mortgage_payable', normalBalance: 'credit' },
  { code: '2510', parentCode: '2500', name: 'Mortgage Principal', accountType: 'liability', accountSubtype: 'mortgage_payable', normalBalance: 'credit' },
  { code: '2520', parentCode: '2500', name: 'Mortgage Interest Accrual', accountType: 'liability', accountSubtype: 'mortgage_payable', normalBalance: 'credit' },
  { code: '2600', name: 'Notes Payable / Seller Financing', accountType: 'liability', accountSubtype: 'notes_payable', normalBalance: 'credit' },
  { code: '2700', name: 'Investor Capital Payable', accountType: 'liability', accountSubtype: 'investor_capital_payable', normalBalance: 'credit' },
  { code: '2800', name: 'Other Liabilities', accountType: 'liability', accountSubtype: 'other_liability', normalBalance: 'credit' },

  // ── Equity (3000–3999) ──────────────────────────────────────────

  { code: '3100', name: 'Owner Contributions', accountType: 'equity', accountSubtype: 'owner_equity', normalBalance: 'credit' },
  { code: '3200', name: 'Owner Distributions', accountType: 'equity', accountSubtype: 'owner_equity', normalBalance: 'debit',
    notes: 'Contra-equity: debit normal balance reduces total equity when owners pull funds.' },
  { code: '3300', name: 'Retained Earnings - Current Year', accountType: 'equity', accountSubtype: 'retained_earnings', normalBalance: 'credit', isSystem: true },
  { code: '3310', name: 'Retained Earnings - Prior Years', accountType: 'equity', accountSubtype: 'retained_earnings', normalBalance: 'credit' },
  { code: '3400', name: 'Conveyances on Sale', accountType: 'equity', accountSubtype: 'owner_equity', normalBalance: 'credit',
    notes: 'Used during property dispositions; mirrors AppFolio 3998 Conveyances on Sale.' },
  { code: '3900', name: 'Opening Balance Equity', accountType: 'equity', accountSubtype: 'opening_balance_equity', normalBalance: 'credit', isSystem: true,
    notes: 'Migration and org-bootstrap plug; all opening JEs land here, then offset to specific equity at year-end.' },

  // ── Income (4000–4999) ──────────────────────────────────────────

  // Rental income — preserves the AppFolio sub-tree pattern.
  { code: '4000', name: 'Rental Income', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit', isSystem: true,
    notes: 'Parent. Per-unit / per-lease detail derives from journal_lines.unit_id / lease_id.' },
  { code: '4010', parentCode: '4000', name: 'Rent - Long Term', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit', isSystem: true },
  { code: '4020', parentCode: '4000', name: 'Rent - Short Term', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit' },
  { code: '4030', parentCode: '4000', name: 'Rent - Section 8', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit' },
  { code: '4040', parentCode: '4000', name: 'Rent - Pet', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit' },
  { code: '4050', parentCode: '4000', name: 'Rent - Appliance', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit' },
  { code: '4060', parentCode: '4000', name: 'Rent - Parking / Storage', accountType: 'income', accountSubtype: 'rent_income', normalBalance: 'credit' },

  // Contra-income: rent adjustments that reduce gross potential rent.
  // Stored as income type but with debit normal balance — GL totals
  // collapse them under Income for reporting while preserving the
  // contra mechanic.
  { code: '4100', name: 'Rent Adjustments (Contra-Income)', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit',
    notes: 'Parent for adjustments that reduce gross potential rent. Debit normal because contra.' },
  { code: '4110', parentCode: '4100', name: 'Concessions', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit' },
  { code: '4111', parentCode: '4100', name: 'Concessions - Section 8 Abatement', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit' },
  { code: '4120', parentCode: '4100', name: 'Loss to Market', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit' },
  { code: '4130', parentCode: '4100', name: 'Vacancy Loss', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit' },
  { code: '4140', parentCode: '4100', name: 'Delinquency', accountType: 'income', accountSubtype: 'contra_income', normalBalance: 'debit' },

  // Other fee income.
  { code: '4200', name: 'Other Fee Income', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4210', parentCode: '4200', name: 'Late Fees', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4220', parentCode: '4200', name: 'NSF Fees', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4230', parentCode: '4200', name: 'Application Fees', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4240', parentCode: '4200', name: 'Month-to-Month Fees', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4250', parentCode: '4200', name: 'Pet Fees (Non-Refundable)', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4260', parentCode: '4200', name: 'Move-Out Fees', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4270', parentCode: '4200', name: 'Tax Passthrough', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4280', parentCode: '4200', name: 'Insurance Services Fee', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },

  { code: '4300', name: 'Utility Reimbursements', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4400', name: 'Management Fee Income', accountType: 'income', accountSubtype: 'management_income', normalBalance: 'credit' },
  { code: '4500', name: 'Deposit Forfeit', accountType: 'income', accountSubtype: 'fee_income', normalBalance: 'credit' },
  { code: '4600', name: 'Laundry / Vending Income', accountType: 'income', accountSubtype: 'misc_income', normalBalance: 'credit' },
  { code: '4700', name: 'Insurance Proceeds', accountType: 'income', accountSubtype: 'misc_income', normalBalance: 'credit' },
  { code: '4800', name: 'Interest Income', accountType: 'income', accountSubtype: 'interest_income', normalBalance: 'credit' },
  { code: '4900', name: 'Misc Income', accountType: 'income', accountSubtype: 'misc_income', normalBalance: 'credit' },

  // ── Operating Expenses (6000–6999) ──────────────────────────────

  { code: '6010', name: 'Advertising', accountType: 'expense', accountSubtype: 'advertising', normalBalance: 'debit' },

  { code: '6020', name: 'Auto and Travel', accountType: 'expense', accountSubtype: 'auto_travel', normalBalance: 'debit' },
  { code: '6021', parentCode: '6020', name: 'Mileage', accountType: 'expense', accountSubtype: 'auto_travel', normalBalance: 'debit' },
  { code: '6022', parentCode: '6020', name: 'Meals', accountType: 'expense', accountSubtype: 'auto_travel', normalBalance: 'debit' },
  { code: '6023', parentCode: '6020', name: 'Travel', accountType: 'expense', accountSubtype: 'auto_travel', normalBalance: 'debit' },

  { code: '6030', name: 'Cleaning and Maintenance', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6031', parentCode: '6030', name: 'Carpet Cleaning', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6032', parentCode: '6030', name: 'Janitorial', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6033', parentCode: '6030', name: 'Pool Cleaning', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6034', parentCode: '6030', name: 'Landscaping', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6035', parentCode: '6030', name: 'HOA Dues', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6036', parentCode: '6030', name: 'Pest Control', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6037', parentCode: '6030', name: 'Snow Removal', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6038', parentCode: '6030', name: 'General Maintenance Labor', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },
  { code: '6039', parentCode: '6030', name: 'Storage Space Rental', accountType: 'expense', accountSubtype: 'maintenance', normalBalance: 'debit' },

  { code: '6040', name: 'Legal and Professional', accountType: 'expense', accountSubtype: 'legal_professional', normalBalance: 'debit' },
  { code: '6041', parentCode: '6040', name: 'Accounting', accountType: 'expense', accountSubtype: 'legal_professional', normalBalance: 'debit' },
  { code: '6042', parentCode: '6040', name: 'Legal', accountType: 'expense', accountSubtype: 'legal_professional', normalBalance: 'debit' },
  { code: '6043', parentCode: '6040', name: 'Professional Services - Other', accountType: 'expense', accountSubtype: 'legal_professional', normalBalance: 'debit' },

  { code: '6050', name: 'Management Fees', accountType: 'expense', accountSubtype: 'management_fees', normalBalance: 'debit' },
  { code: '6051', parentCode: '6050', name: 'Property Management', accountType: 'expense', accountSubtype: 'management_fees', normalBalance: 'debit' },
  { code: '6052', parentCode: '6050', name: 'Asset Management', accountType: 'expense', accountSubtype: 'management_fees', normalBalance: 'debit' },
  { code: '6053', parentCode: '6050', name: 'Commissions / Placement Fees', accountType: 'expense', accountSubtype: 'management_fees', normalBalance: 'debit' },
  { code: '6054', parentCode: '6050', name: 'Office Payroll', accountType: 'expense', accountSubtype: 'payroll', normalBalance: 'debit' },
  { code: '6055', parentCode: '6050', name: 'Payroll Taxes and Fees', accountType: 'expense', accountSubtype: 'payroll', normalBalance: 'debit' },
  { code: '6056', parentCode: '6050', name: 'AirBNB Host Service Fee', accountType: 'expense', accountSubtype: 'management_fees', normalBalance: 'debit' },

  { code: '6070', name: 'Repairs', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6071', parentCode: '6070', name: 'Painting', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6072', parentCode: '6070', name: 'Plumbing', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6073', parentCode: '6070', name: 'Flooring', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6074', parentCode: '6070', name: 'HVAC', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6075', parentCode: '6070', name: 'Roofing', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6076', parentCode: '6070', name: 'Electrical', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6077', parentCode: '6070', name: 'Appliance Repairs', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6078', parentCode: '6070', name: 'Key / Lock Replacement', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6079', parentCode: '6070', name: 'General Repairs', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6080', parentCode: '6070', name: 'Inspections', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },
  { code: '6081', parentCode: '6070', name: 'Supplies', accountType: 'expense', accountSubtype: 'repairs', normalBalance: 'debit' },

  { code: '6100', name: 'Property Taxes', accountType: 'expense', accountSubtype: 'taxes', normalBalance: 'debit' },
  { code: '6110', parentCode: '6100', name: 'Property Tax', accountType: 'expense', accountSubtype: 'taxes', normalBalance: 'debit' },
  { code: '6120', parentCode: '6100', name: 'Short-Term Occupancy Tax', accountType: 'expense', accountSubtype: 'taxes', normalBalance: 'debit' },
  { code: '6130', parentCode: '6100', name: 'Rental Tax Authority', accountType: 'expense', accountSubtype: 'taxes', normalBalance: 'debit' },

  { code: '6150', name: 'Utilities', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6151', parentCode: '6150', name: 'Electricity', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6152', parentCode: '6150', name: 'Gas', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6153', parentCode: '6150', name: 'Water', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6154', parentCode: '6150', name: 'Sewer', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6155', parentCode: '6150', name: 'Garbage / Recycling', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6156', parentCode: '6150', name: 'Internet', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6157', parentCode: '6150', name: 'Telephone', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6158', parentCode: '6150', name: 'Security Service Fees', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit' },
  { code: '6159', parentCode: '6150', name: 'Utilities - Aggregated', accountType: 'expense', accountSubtype: 'utilities', normalBalance: 'debit',
    notes: 'Catch-all for billed-back / split utility allocations across multiple units.' },

  { code: '6200', name: 'Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6201', parentCode: '6200', name: 'Property Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6202', parentCode: '6200', name: 'Flood Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6203', parentCode: '6200', name: 'Earthquake Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6204', parentCode: '6200', name: 'Workers Comp Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6205', parentCode: '6200', name: 'Auto Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '6206', parentCode: '6200', name: 'GC Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },

  { code: '6300', name: 'Mortgage Interest', accountType: 'expense', accountSubtype: 'mortgage_interest', normalBalance: 'debit',
    notes: 'P&I expense portion of mortgage payment. Principal portion debits Mortgage Principal (2510), not this account.' },
  { code: '6400', name: 'Bank Fees', accountType: 'expense', accountSubtype: 'bank_fees', normalBalance: 'debit' },
  { code: '6500', name: 'Software / Tech', accountType: 'expense', accountSubtype: 'software', normalBalance: 'debit' },
  { code: '6600', name: 'Tenant Screening', accountType: 'expense', accountSubtype: 'screening', normalBalance: 'debit' },
  { code: '6700', name: 'Misc Operating Expense', accountType: 'expense', accountSubtype: 'misc_expense', normalBalance: 'debit' },

  // ── Capital Expenses (7000–7999) ────────────────────────────────

  { code: '7000', name: 'Capital Expenditures', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit',
    notes: 'CapEx that should be capitalized to fixed assets and depreciated, but is tracked here for cash-basis reporting.' },
  { code: '7010', parentCode: '7000', name: 'Appliances', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },
  { code: '7020', parentCode: '7000', name: 'Equipment / Tools', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },
  { code: '7030', parentCode: '7000', name: 'Remodel', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },
  { code: '7040', parentCode: '7000', name: 'Roof Replacement', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },
  { code: '7050', parentCode: '7000', name: 'Furniture', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },
  { code: '7060', parentCode: '7000', name: 'Short-Term Rental Furnishings', accountType: 'expense', accountSubtype: 'capital_expense', normalBalance: 'debit' },

  { code: '7100', name: 'Turnover Expense', accountType: 'expense', accountSubtype: 'turnover_expense', normalBalance: 'debit' },
  { code: '7110', parentCode: '7100', name: 'Turnover - General', accountType: 'expense', accountSubtype: 'turnover_expense', normalBalance: 'debit' },
  { code: '7120', parentCode: '7100', name: 'Turnover - Repositioning', accountType: 'expense', accountSubtype: 'turnover_expense', normalBalance: 'debit' },
  { code: '7130', parentCode: '7100', name: 'Turnover - New Units', accountType: 'expense', accountSubtype: 'turnover_expense', normalBalance: 'debit' },
  { code: '7140', parentCode: '7100', name: 'Turnover - Insurance', accountType: 'expense', accountSubtype: 'turnover_expense', normalBalance: 'debit' },

  // ── Overhead / Shared (8000–8999) ───────────────────────────────

  { code: '8000', name: 'Portfolio Overhead', accountType: 'expense', accountSubtype: 'overhead', normalBalance: 'debit' },
  { code: '8010', parentCode: '8000', name: 'Overhead - Payroll', accountType: 'expense', accountSubtype: 'payroll', normalBalance: 'debit' },
  { code: '8020', parentCode: '8000', name: 'Overhead - Software', accountType: 'expense', accountSubtype: 'software', normalBalance: 'debit' },
  { code: '8030', parentCode: '8000', name: 'Overhead - Processing Fees', accountType: 'expense', accountSubtype: 'overhead', normalBalance: 'debit' },

  { code: '8100', name: 'Acquisition Costs', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8110', parentCode: '8100', name: 'Lender Fees', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8120', parentCode: '8100', name: 'Title Fees', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8130', parentCode: '8100', name: 'Broker Fees', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8140', parentCode: '8100', name: 'Appraisal Fees', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8150', parentCode: '8100', name: 'Acquisition Fees', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8200', name: 'Refinancing Costs', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },
  { code: '8300', name: 'Property Disposition Costs', accountType: 'expense', accountSubtype: 'acquisition', normalBalance: 'debit' },

  // ── Other / Below-the-line (9000–9999) ──────────────────────────

  { code: '9000', name: 'Depreciation Expense', accountType: 'expense', accountSubtype: 'depreciation', normalBalance: 'debit' },
  { code: '9010', name: 'Amortization Expense', accountType: 'expense', accountSubtype: 'amortization', normalBalance: 'debit' },
  { code: '9100', name: 'Income Tax Expense', accountType: 'expense', accountSubtype: 'income_tax', normalBalance: 'debit' },
  { code: '9200', name: 'Mortgage Interest (below-the-line)', accountType: 'expense', accountSubtype: 'mortgage_interest', normalBalance: 'debit' },
  { code: '9300', name: 'Mortgage Servicing Fees', accountType: 'expense', accountSubtype: 'bank_fees', normalBalance: 'debit' },
  { code: '9400', name: 'Title Insurance', accountType: 'expense', accountSubtype: 'insurance', normalBalance: 'debit' },
  { code: '9500', name: 'Investor Distributions', accountType: 'expense', accountSubtype: 'other_expense', normalBalance: 'debit' },
  { code: '9600', name: 'Child Support / Garnishments', accountType: 'expense', accountSubtype: 'other_expense', normalBalance: 'debit' },
  { code: '9900', name: 'Forced Reconciliation', accountType: 'expense', accountSubtype: 'other_expense', normalBalance: 'debit',
    notes: 'Reserved plug account for forced-balance reconciliation entries — should rarely be used.' },
];
