// Mail Slapper — the comms layer of Breeze OS.
//
// Three sub-surfaces:
//   - Snail Mail        physical mail in & out: scan inbound, mail
//                       outbound (lease violation notices, eviction
//                       filings, owner statements on demand)
//   - Registered Agent  the regulated mail address every LLC has to
//                       maintain. We become the agent so the
//                       landlord doesn't have to staff a PO box.
//   - Email             outbound owner statements, tenant rent
//                       reminders, lease notices — all under your
//                       custom domain
//
// All three are stubbed in this PR — the menu and copy are live so
// the UI shows our direction, but each surface has a clear "Coming
// soon" call-to-action and a mocked preview of what it'll do.

import {
  Mail, Stamp, Scale, AtSign, ArrowRight, Inbox, Send,
  ShieldCheck, AlertCircle, Sparkles, Clock,
} from 'lucide-react';

export default function MailSlapperPage({ activeView, onNavigate }) {
  if (activeView === 'mail-snail') return <SnailMailPage />;
  if (activeView === 'mail-registered-agent') return <RegisteredAgentPage />;
  if (activeView === 'mail-email') return <EmailPage />;
  return <HubPage onNavigate={onNavigate} />;
}

// ── Hub ─────────────────────────────────────────────────────────

function HubPage({ onNavigate }) {
  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <Header
        icon={Mail}
        title="Mail Slapper"
        subtitle="Every channel a landlord deals with — physical mail, registered-agent service, and email — handled in one place, so you stop staffing a PO box and stop manually emailing every owner."
        accent="#6A1B9A"
      />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '14px',
        marginTop: '24px',
      }}>
        <FeatureCard
          icon={Stamp}
          title="Snail Mail"
          tagline="Inbound scanned, outbound mailed"
          description="Every piece of physical mail that lands at our address gets opened, scanned, and indexed against the right property or tenant. Outbound — lease violation notices, eviction filings, owner statements on request — goes out via tracked USPS."
          ctaLabel="Open Snail Mail"
          onClick={() => onNavigate('mail-snail')}
          accent="#1565C0"
        />
        <FeatureCard
          icon={Scale}
          title="Registered Agent"
          tagline="Your LLC's legal mailbox"
          description="Every state requires LLCs to maintain a registered agent. We become yours, in all 50 states. Service of process gets handed to you instantly via Slapper, not weeks later via the registered office."
          ctaLabel="Open Registered Agent"
          onClick={() => onNavigate('mail-registered-agent')}
          accent="#2E7D32"
        />
        <FeatureCard
          icon={AtSign}
          title="Email"
          tagline="Outbound + inbound, your domain"
          description="Owner statements, monthly rent reminders, lease notices — all sent from a real address at your domain with full deliverability tuning. Inbound tenant emails route to the right property's thread, no shared inbox chaos."
          ctaLabel="Open Email"
          onClick={() => onNavigate('mail-email')}
          accent="#E65100"
        />
      </div>

      <div style={{
        marginTop: '28px',
        padding: '16px 18px',
        background: 'linear-gradient(135deg, #F3E5F5 0%, #E8EAF6 100%)',
        borderLeft: '3px solid #6A1B9A',
        borderRadius: '8px',
        fontSize: '13px',
        color: '#444',
      }}>
        <strong style={{ color: '#6A1B9A' }}>
          <Sparkles size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
          Why this exists
        </strong>
        <p style={{ margin: '6px 0 0' }}>
          Property managers earn 8–12% of gross rents largely because they handle the comms work
          owners don't want to do — picking up the mail, forwarding state filings, chasing rent.
          Mail Slapper turns each of those into a self-service feature so a Breeze OS owner can
          fire their PM company and keep the income.
        </p>
      </div>
    </div>
  );
}

// ── Snail Mail ──────────────────────────────────────────────────

function SnailMailPage() {
  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <Header
        icon={Stamp}
        title="Snail Mail"
        subtitle="Inbound scanning + outbound mailing for your properties and entities. Every letter, every notice, every certified piece tracked end-to-end."
        accent="#1565C0"
        comingSoon
      />

      <SectionGrid>
        <StubCard
          icon={Inbox}
          title="Inbound"
          bullets={[
            'Mail forwarded to a Breeze address',
            'Opened, scanned, OCR’d within 24 hours',
            'Auto-routed to property/tenant/entity',
            'Originals shredded or held 30 days on request',
          ]}
          mockStat="0 pieces this month"
        />
        <StubCard
          icon={Send}
          title="Outbound"
          bullets={[
            'Lease violation notices (3-day, 5-day, etc.)',
            'Late-rent letters with bookkeeping integration',
            'Eviction filings prepared and printed',
            'Owner statements mailed on request',
            'USPS Certified Mail with tracking numbers',
          ]}
          mockStat="0 letters sent"
        />
        <StubCard
          icon={ShieldCheck}
          title="Compliance"
          bullets={[
            'State-specific notice templates',
            'Proof-of-mailing affidavits archived per letter',
            'PII redaction on shared scans',
            'Tenant-portal opt-in for digital delivery',
          ]}
          mockStat="—"
        />
      </SectionGrid>

      <NotShippedYet
        message="We’re lining up the mail-handling vendor and the print/mail API integration. Targeted for Q3 once Plaid is live and AppFolio migration tooling is shipped."
      />
    </div>
  );
}

// ── Registered Agent ────────────────────────────────────────────

function RegisteredAgentPage() {
  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <Header
        icon={Scale}
        title="Registered Agent"
        subtitle="The legal mailbox every LLC is required to maintain. Breeze is your agent of record — service of process and state filings hit your phone, not a PO box you forget about."
        accent="#2E7D32"
        comingSoon
      />

      <SectionGrid>
        <StubCard
          icon={ShieldCheck}
          title="50-State Coverage"
          bullets={[
            'Filed-and-paid registered-agent service in every state',
            'Per-entity address provisioning at signup',
            'Annual-report reminders + auto-filing',
            'Foreign-qualification handling when you expand',
          ]}
          mockStat="0 entities under coverage"
        />
        <StubCard
          icon={AlertCircle}
          title="Service of Process"
          bullets={[
            'Same-day scan + SMS alert when served',
            'Routed to your designated counsel in one click',
            'Chain-of-custody record (statutory requirement)',
            'Searchable archive of every served document',
          ]}
          mockStat="0 served this year"
        />
        <StubCard
          icon={Clock}
          title="State Compliance Calendar"
          bullets={[
            'Annual report due dates tracked per entity',
            'Franchise tax filings prepared',
            'Auto-renewal of agent designation',
            'Good-standing certificates pulled on demand',
          ]}
          mockStat="—"
        />
      </SectionGrid>

      <NotShippedYet
        message="Building the agent network is a state-by-state rollout. Delaware and Ohio first (Breeze’s portfolio), then top-10 LLC-friendly states, then the rest."
      />
    </div>
  );
}

// ── Email ───────────────────────────────────────────────────────

function EmailPage() {
  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <Header
        icon={AtSign}
        title="Email"
        subtitle="Outbound rent reminders, owner statements, and lease notices from a real address at your domain. Inbound tenant emails routed to the right property thread, with full audit trail."
        accent="#E65100"
        comingSoon
      />

      <SectionGrid>
        <StubCard
          icon={Send}
          title="Outbound"
          bullets={[
            'Monthly rent reminders (T-5, T-1, late, very late)',
            'Owner statements as scheduled or on-demand',
            'Lease renewal letters with e-sign link',
            'Custom-domain From: address w/ SPF + DKIM + DMARC',
            'Bounce + complaint handling with auto-disable',
          ]}
          mockStat="0 sent this month"
        />
        <StubCard
          icon={Inbox}
          title="Inbound"
          bullets={[
            'Tenant emails routed to per-property threads',
            'AI-tagged urgency + maintenance triage',
            'Owner correspondence threaded against the entity',
            'Unified search across all threads',
          ]}
          mockStat="0 threads open"
        />
        <StubCard
          icon={Sparkles}
          title="Templates + AI"
          bullets={[
            'Template library with merge variables ({tenant_name}, etc.)',
            'AI-drafted replies from your style + past responses',
            'Tone match per recipient (owner vs tenant)',
            'Approval queue for staff-drafted high-stakes emails',
          ]}
          mockStat="—"
        />
      </SectionGrid>

      <NotShippedYet
        message="Outbound first via Resend (or AWS SES at scale), inbound via a parser webhook. Ships alongside the tenant-messaging milestone in the roadmap."
      />
    </div>
  );
}

// ── shared building blocks ──────────────────────────────────────

function Header({ icon: Icon, title, subtitle, accent, comingSoon }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '16px',
      paddingBottom: '12px',
      borderBottom: '1px solid #EEE',
    }}>
      <div style={{
        width: '52px', height: '52px',
        borderRadius: '12px',
        background: `${accent}15`,
        color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={28} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '24px', color: '#1A1A1A' }}>{title}</h2>
          {comingSoon && (
            <span style={{
              padding: '2px 10px',
              borderRadius: '12px',
              fontSize: '11px',
              fontWeight: 600,
              background: '#FFF3E0',
              color: '#E65100',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
            }}>
              Coming soon
            </span>
          )}
        </div>
        <p style={{ margin: '6px 0 0', color: '#666', fontSize: '14px', lineHeight: 1.5 }}>
          {subtitle}
        </p>
      </div>
    </div>
  );
}

function FeatureCard({ icon: Icon, title, tagline, description, ctaLabel, onClick, accent }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '18px',
        borderRadius: '10px',
        border: '1px solid #E0E0E0',
        background: 'white',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#E0E0E0'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '36px', height: '36px',
          borderRadius: '8px',
          background: `${accent}15`,
          color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={20} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px', color: '#1A1A1A' }}>{title}</div>
          <div style={{ fontSize: '12px', color: accent, fontWeight: 600 }}>{tagline}</div>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: '13px', color: '#555', lineHeight: 1.5 }}>
        {description}
      </p>
      <div style={{
        marginTop: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        color: accent,
        fontSize: '13px',
        fontWeight: 600,
      }}>
        {ctaLabel} <ArrowRight size={14} />
      </div>
    </button>
  );
}

function SectionGrid({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
      gap: '14px',
      marginTop: '20px',
    }}>
      {children}
    </div>
  );
}

function StubCard({ icon: Icon, title, bullets, mockStat }) {
  return (
    <div style={{
      padding: '16px 18px',
      borderRadius: '10px',
      border: '1px solid #EEE',
      background: 'white',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <Icon size={18} style={{ color: '#666' }} />
        <h3 style={{ margin: 0, fontSize: '14px', color: '#1A1A1A' }}>{title}</h3>
      </div>
      <ul style={{ margin: '0 0 12px', paddingLeft: '18px', fontSize: '13px', color: '#444', lineHeight: 1.55 }}>
        {bullets.map((b) => <li key={b}>{b}</li>)}
      </ul>
      <div style={{
        fontSize: '11px',
        color: '#888',
        borderTop: '1px dashed #EEE',
        paddingTop: '8px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        {mockStat}
      </div>
    </div>
  );
}

function NotShippedYet({ message }) {
  return (
    <div style={{
      marginTop: '20px',
      padding: '14px 16px',
      background: '#FFF8E1',
      borderLeft: '3px solid #F9A825',
      borderRadius: '8px',
      fontSize: '13px',
      color: '#5D4037',
    }}>
      <strong style={{ color: '#E65100' }}>Not shipped yet.</strong> {message}
    </div>
  );
}
