import { useState } from 'react';
import {
  HelpCircle, Search, BookOpen, Video, MessageSquare, Mail,
  FileText, Zap, Phone, ExternalLink, ChevronRight,
} from 'lucide-react';

const CATEGORIES = [
  {
    icon: BookOpen,
    color: '#0077B6',
    title: 'Getting Started',
    articles: [
      'Welcome to Breeze Property OS',
      'Connecting Rent Manager',
      'Setting up your team',
      'Your first week with Breeze',
    ],
  },
  {
    icon: Zap,
    color: '#E65100',
    title: 'Using Breeze AI',
    articles: [
      'Asking natural-language questions',
      'How the chat pulls live data',
      'Making outbound AI calls',
      'Sending team notifications via chat',
      'Show Me deep-links explained',
    ],
  },
  {
    icon: FileText,
    color: '#2E7D32',
    title: 'Properties & Tenants',
    articles: [
      'Viewing and editing tenant records',
      'Managing lease lifecycles',
      'Tracking work orders',
      'Understanding balance calculations',
    ],
  },
  {
    icon: Phone,
    color: '#6A1B9A',
    title: 'Voice & Communications',
    articles: [
      'Configuring Vapi and ElevenLabs',
      'Customizing the AI caller persona',
      'Reviewing call transcripts',
      'Zoho Cliq integration guide',
    ],
  },
];

const FAQS = [
  {
    q: 'How often does data sync from Rent Manager?',
    a: 'Breeze pulls live from Rent Manager on every request — there is no cache between the app and RM for reads. For writes (like editing a tenant), changes are posted immediately and Breeze refetches the record to confirm.',
  },
  {
    q: 'Can the AI caller leave voicemails?',
    a: 'Yes. If the outbound call goes to voicemail, the AI introduces itself as whoever you configured as BREEZE_CALLER_NAME from BREEZE_COMPANY_NAME, delivers a brief professional message, and hangs up automatically.',
  },
  {
    q: 'What happens if Rent Manager goes down?',
    a: "Breeze tries to re-authenticate automatically on 401 errors. If the outage persists, the chat and pages will surface a 'Tool error' message verbatim so you can see exactly what RM returned. The rest of the app (Tasks, Workflows, Settings) keeps working.",
  },
  {
    q: 'Is my data encrypted?',
    a: 'Yes. All traffic to Breeze, Rent Manager, Anthropic, Vapi, and Zoho flows over TLS. Credentials are stored as environment variables in Vercel and never exposed to the browser.',
  },
  {
    q: 'Can I export my data?',
    a: 'All data lives in Rent Manager, which has its own export tools. For Breeze-specific things like call transcripts and chat history, export is available under Settings → Organization → Data Export (coming in the next release).',
  },
  {
    q: 'How do I add a new team member?',
    a: 'Go to Settings → Team → Invite Member. Enter their email and pick a role (Owner, Admin, Manager, or Maintenance). They\'ll get an invitation email with a sign-up link.',
  },
];

export default function HelpPage() {
  const [search, setSearch] = useState('');

  const filteredFaqs = FAQS.filter((f) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q);
  });

  return (
    <div className="properties-page">
      <div className="tenant-detail-topbar">
        <div className="property-detail-header" style={{ flex: 1 }}>
          <div className="wo-detail-icon" style={{ background: '#0077B615', color: '#0077B6' }}>
            <HelpCircle size={28} />
          </div>
          <div style={{ flex: 1 }}>
            <h2>Help & Documentation</h2>
            <p className="property-detail-address">
              Search the knowledge base, browse guides, or reach out to our team
            </p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="dashboard-search" style={{ marginBottom: '16px' }}>
        <Search size={18} />
        <input
          type="text"
          placeholder="Search help articles, FAQs, and guides..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Contact cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '12px',
        marginBottom: '16px',
      }}>
        <ContactCard
          icon={MessageSquare}
          color="#0077B6"
          title="Live Chat"
          desc="Available Mon–Fri, 9am–6pm EST"
          cta="Start a chat"
        />
        <ContactCard
          icon={Mail}
          color="#2E7D32"
          title="Email Support"
          desc="support@breezepropertygroup.com"
          cta="Send an email"
        />
        <ContactCard
          icon={Video}
          color="#6A1B9A"
          title="Book a Call"
          desc="30-min session with an onboarding specialist"
          cta="Schedule now"
        />
        <ContactCard
          icon={BookOpen}
          color="#E65100"
          title="Video Tutorials"
          desc="Watch 5-minute walkthroughs of every feature"
          cta="Browse library"
        />
      </div>

      {/* Category grid */}
      <div className="dashboard-card">
        <div className="card-header">
          <h3><BookOpen size={18} /> Browse by Topic</h3>
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '12px',
          padding: '8px 0',
        }}>
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            return (
              <div key={cat.title} style={{
                padding: '14px',
                border: '1px solid #E9ECEF',
                borderRadius: '10px',
                background: '#FFF',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div className="tenant-avatar" style={{ background: `${cat.color}15`, color: cat.color, width: 34, height: 34 }}>
                    <Icon size={18} />
                  </div>
                  <h4 style={{ margin: 0, fontSize: 15 }}>{cat.title}</h4>
                </div>
                <div>
                  {cat.articles.map((a) => (
                    <button key={a} style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '8px 4px',
                      fontSize: 13,
                      color: '#495057',
                      textAlign: 'left',
                      borderBottom: '1px solid #F8F9FA',
                    }}>
                      <span>{a}</span>
                      <ChevronRight size={14} color="#ADB5BD" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* FAQs */}
      <div className="dashboard-card">
        <div className="card-header">
          <h3><HelpCircle size={18} /> Frequently Asked Questions</h3>
        </div>
        <div>
          {filteredFaqs.map((faq, i) => (
            <details key={i} style={{
              padding: '14px 4px',
              borderBottom: '1px solid #F1F3F5',
            }}>
              <summary style={{
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                listStyle: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                {faq.q}
                <ChevronRight size={16} color="#ADB5BD" />
              </summary>
              <p style={{
                marginTop: 10,
                fontSize: 13,
                color: '#495057',
                lineHeight: 1.6,
              }}>
                {faq.a}
              </p>
            </details>
          ))}
          {filteredFaqs.length === 0 && (
            <div className="empty-state">
              <Search size={32} />
              <p>No results for "{search}"</p>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="dashboard-card">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Still stuck?</div>
            <div style={{ fontSize: 12, color: '#6C757D', marginTop: 2 }}>
              Our support team responds within 2 business hours during the week.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary">
              <FileText size={14} /> Release Notes
            </button>
            <button className="btn-primary tenant-edit-btn">
              <ExternalLink size={14} /> Contact Support
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactCard({ icon: Icon, color, title, desc, cta }) {
  return (
    <div className="dashboard-card" style={{ padding: '16px' }}>
      <div className="tenant-avatar" style={{ background: `${color}15`, color, width: 40, height: 40, marginBottom: 10 }}>
        <Icon size={20} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: '#6C757D', marginBottom: 12 }}>{desc}</div>
      <button style={{
        fontSize: 13,
        fontWeight: 600,
        color,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}>
        {cta} <ChevronRight size={14} />
      </button>
    </div>
  );
}
