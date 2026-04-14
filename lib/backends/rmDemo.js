// Rent Manager sample15 sandbox backend.
//
// This is the original chat data source — what the chat has always
// hit before PR 9 introduced the 3-way backend toggle. The logic
// here was lifted verbatim from lib/breezeAgent.js so the RM path
// is unchanged; it just lives behind the backend interface now.

import { rmCall } from '../rmClient.js';

export const name = 'rm-demo';
export const displayName = 'RM Demo';
export const description =
  'Read-only sandbox (sample15.api.rentmanager.com). Has tenants, ' +
  'leases, balances, and work orders that the Breeze production ' +
  'database does not track yet. Useful for demos.';

export const systemPromptAddendum =
  'Data source: Rent Manager sample15 sandbox. This environment has ' +
  'tenants, leases, balances, properties, units, and work orders. ' +
  'Properties and tenants here are demo data, NOT real Breeze portfolio data.';

export async function getTools() {
  return TOOLS;
}

const TOOLS = [
  {
    name: 'search_tenants',
    description:
      'Find tenants by name. Use this as a lookup step when the user asks about a specific person — ' +
      'it returns only id, display_id, name, and status. ' +
      'IMPORTANT: This tool does NOT return email, phone, lease, or balance. To get contact info or any ' +
      "other detail about a specific tenant, ALWAYS call get_tenant_details with the id from this list. " +
      "Never answer questions about a tenant's email, phone, lease, or balance using only search_tenants results.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Partial or full name to search for. Leave empty to list all tenants.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_tenant_details',
    description:
      'Get the full record for a single tenant by their TenantID, including lease info, ' +
      'open charges/balance, addresses, and emergency contacts. Use this after search_tenants ' +
      'when the user wants more detail on one specific tenant.',
    input_schema: {
      type: 'object',
      properties: {
        tenant_id: { type: 'integer', description: 'TenantID from search_tenants results' },
      },
      required: ['tenant_id'],
    },
  },
  {
    name: 'list_properties',
    description: 'List all properties managed in Rent Manager. Returns name, city, state, type, and id for each.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_units',
    description:
      'List rental units. Optionally filter by property. Returns unit name, status (occupied/vacant), ' +
      'bedrooms, bathrooms, square feet, and market rent.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: {
          type: 'integer',
          description: 'Optional PropertyID to filter units by. Omit to get all units.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_work_orders',
    description:
      'List maintenance work orders / service requests. Returns summary, priority, status, category, ' +
      'and the related unit/property. Use for questions about maintenance, repairs, or open issues. ' +
      'Supports filtering by status, minimum priority, category, and free-text search. The response ' +
      'includes counts so you can answer "how many" questions without iterating through the full list.',
    input_schema: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description: '"open" for incomplete tickets, "completed" for done, "all" for everything. Default: all.',
          enum: ['open', 'completed', 'all'],
        },
        min_priority: {
          type: 'string',
          description:
            'Minimum priority to include. "urgent" = only urgent/emergency; "high" = high and urgent; ' +
            '"medium" = medium, high, and urgent; "low" = everything. Default: low.',
          enum: ['urgent', 'high', 'medium', 'low'],
        },
        category: {
          type: 'string',
          description:
            'Exact category/trade to filter by. Use this only when the user names a trade like ' +
            '"plumbing", "electrical", "HVAC", "appliance", "pest". ' +
            'For everything else (e.g. "mold", "leak", "gas smell", "paint"), prefer search_text.',
        },
        search_text: {
          type: 'string',
          description:
            'Free-text keyword that is matched against the ticket summary, description, AND category. ' +
            'Use this for questions like "mold tickets", "gas smell", "kitchen issues", "leaky faucet". ' +
            'Prefer this over category unless the user explicitly named a trade.',
        },
      },
      required: [],
    },
  },
];

export async function executeTool(name, input) {
  try {
    switch (name) {
      case 'search_tenants': {
        const res = await rmCall('/Tenants');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch tenants: ${res.status}` };
        }
        const q = (input.query || '').toLowerCase().trim();
        let tenants = res.data.map((t) => ({
          id: t.TenantID,
          display_id: t.TenantDisplayID || `t${t.TenantID}`,
          name:
            [t.FirstName, t.LastName].filter(Boolean).join(' ') || `Tenant ${t.TenantID}`,
          status: t.Status || '',
        }));
        if (q) {
          tenants = tenants.filter((t) => t.name.toLowerCase().includes(q));
        }
        return {
          count: tenants.length,
          tenants: tenants.slice(0, 20),
          note: 'Contact info not included. Call get_tenant_details for email, phone, lease, or balance.',
        };
      }

      case 'get_tenant_details': {
        const id = input.tenant_id;
        const res = await rmCall(
          `/Tenants/${id}?embeds=Addresses,Leases,Contacts,OpenCharges,PhoneNumbers`,
        );
        if (!res.ok) return { error: `Could not fetch tenant ${id}: ${res.status}` };
        const t = Array.isArray(res.data) ? res.data[0] : res.data;
        return mapTenantFull(t);
      }

      case 'list_properties': {
        const res = await rmCall('/Properties');
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch properties: ${res.status}` };
        }
        return {
          count: res.data.length,
          properties: res.data.map((p) => ({
            id: p.PropertyID,
            name: p.Name || p.ShortName,
            city: p.City,
            state: p.State,
            type: p.PropertyType,
          })),
        };
      }

      case 'list_units': {
        const path = input.property_id
          ? `/Units?filters=PropertyID,eq,${input.property_id}`
          : '/Units';
        const res = await rmCall(path);
        if (!res.ok || !Array.isArray(res.data)) {
          return { error: `Could not fetch units: ${res.status}` };
        }
        return {
          count: res.data.length,
          units: res.data.slice(0, 40).map((u) => ({
            id: u.UnitID,
            property_id: u.PropertyID,
            name: u.Name,
            status: u.Status,
            bedrooms: u.Bedrooms,
            bathrooms: u.Bathrooms,
            sqft: u.SquareFeet || u.SQFT,
            market_rent: u.MarketRent,
          })),
        };
      }

      case 'list_work_orders': {
        const [woRes, catRes, priRes] = await Promise.all([
          rmCall('/ServiceManagerIssues'),
          rmCall('/ServiceManagerCategories'),
          rmCall('/ServiceManagerPriorities'),
        ]);
        if (!woRes.ok || !Array.isArray(woRes.data)) {
          return {
            error: `Could not fetch work orders (HTTP ${woRes.status}): ${
              typeof woRes.data === 'string' ? woRes.data : JSON.stringify(woRes.data)
            }`,
          };
        }

        const catMap = {};
        if (catRes.ok && Array.isArray(catRes.data)) {
          for (const c of catRes.data) {
            const id = c.ServiceManagerCategoryID || c.CategoryID || c.ID;
            const nm = c.Name || c.CategoryName || '';
            if (id) catMap[id] = nm;
          }
        }

        const priMap = {};
        if (priRes.ok && Array.isArray(priRes.data)) {
          for (const p of priRes.data) {
            const id = p.ServiceManagerPriorityID || p.PriorityID || p.ID;
            const nm = p.Name || p.PriorityName || '';
            if (id) priMap[id] = nm;
          }
        }

        const rankPriority = (p) => {
          const pl = (p || '').toLowerCase();
          if (pl.includes('emerg') || pl.includes('urgent')) return 4;
          if (pl.includes('high')) return 3;
          if (pl.includes('med') || pl.includes('normal')) return 2;
          if (pl.includes('low')) return 1;
          return 2;
        };
        const isOpen = (o) => !o.is_closed;

        let orders = woRes.data.map((w) => {
          const catId = w.CategoryID || w.ServiceManagerCategoryID;
          const priId = w.PriorityID;
          const categoryName = catMap[catId] || w.CategoryName || '';
          const priorityName = priMap[priId] || w.Priority || w.PriorityName || '';
          return {
            id: w.ServiceManagerIssueID || w.IssueID,
            summary: w.Title || w.Summary || w.Description || '',
            status: w.StatusName || w.Status || '',
            is_closed: w.IsClosed === true,
            priority: priorityName,
            category: categoryName,
            property_id: w.PropertyID,
            unit_id: w.UnitID,
            created: w.CreateDate || w.DateCreated,
          };
        });

        const totalCount = orders.length;

        if (input.status_filter === 'open') {
          orders = orders.filter(isOpen);
        } else if (input.status_filter === 'completed') {
          orders = orders.filter((o) => !isOpen(o));
        }

        if (input.min_priority) {
          const threshold = rankPriority(input.min_priority);
          orders = orders.filter((o) => rankPriority(o.priority) >= threshold);
        }

        if (input.category) {
          const q = input.category.toLowerCase();
          orders = orders.filter((o) => (o.category || '').toLowerCase().includes(q));
        }

        if (input.search_text) {
          const q = input.search_text.toLowerCase();
          orders = orders.filter((o) =>
            (o.summary || '').toLowerCase().includes(q) ||
            (o.category || '').toLowerCase().includes(q),
          );
        }

        orders.sort((a, b) => {
          const diff = rankPriority(b.priority) - rankPriority(a.priority);
          if (diff !== 0) return diff;
          return new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime();
        });

        const priority_counts = {
          urgent: orders.filter((o) => rankPriority(o.priority) === 4).length,
          high: orders.filter((o) => rankPriority(o.priority) === 3).length,
          medium: orders.filter((o) => rankPriority(o.priority) === 2).length,
          low: orders.filter((o) => rankPriority(o.priority) === 1).length,
        };

        return {
          total_work_orders_in_system: totalCount,
          filtered_count: orders.length,
          priority_counts,
          filters_applied: {
            status: input.status_filter || 'all',
            min_priority: input.min_priority || 'low',
            category: input.category || 'any',
          },
          sample: orders.slice(0, 15),
        };
      }

      default:
        return { error: `rm-demo backend: unknown tool "${name}"` };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function mapTenantFull(t) {
  if (!t) return { error: 'Tenant not found' };
  const leases = Array.isArray(t.Leases) ? t.Leases : [];
  const currentLease =
    leases.find((l) => !l.MoveOutDate && !l.EndDate) || leases[0] || null;
  const openCharges = Array.isArray(t.OpenCharges) ? t.OpenCharges : [];
  const balance = openCharges.reduce(
    (sum, c) => sum + (Number(c.Amount) || 0) - (Number(c.AmountPaid) || 0),
    0,
  );
  const addresses = Array.isArray(t.Addresses) ? t.Addresses : [];
  return {
    id: t.TenantID,
    display_id: t.TenantDisplayID,
    name: [t.FirstName, t.LastName].filter(Boolean).join(' '),
    email: t.Email || '',
    home_phone: t.Phone || '',
    cell_phone: t.CellPhone || '',
    work_phone: t.WorkPhone || '',
    status: t.Status || '',
    comment: t.Comment || '',
    address: addresses[0]
      ? [addresses[0].Street, addresses[0].City, addresses[0].State, addresses[0].PostalCode]
          .filter(Boolean)
          .join(', ')
      : null,
    current_lease: currentLease
      ? {
          start_date: currentLease.StartDate,
          end_date: currentLease.EndDate || currentLease.MoveOutDate,
          rent: currentLease.Rent || currentLease.RentAmount,
          deposit: currentLease.SecurityDeposit,
          property_id: currentLease.PropertyID,
          unit_id: currentLease.UnitID,
        }
      : null,
    balance,
    open_charge_count: openCharges.length,
    emergency_contacts: (Array.isArray(t.Contacts) ? t.Contacts : []).map((c) => ({
      name: [c.FirstName, c.LastName].filter(Boolean).join(' '),
      relationship: c.Relationship,
      email: c.Email,
      phone: c.Phone,
    })),
  };
}
