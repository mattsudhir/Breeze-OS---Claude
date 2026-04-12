import { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, Send, Paperclip, FileText, Home, DollarSign,
  Wrench, User, Bot, ChevronDown, Building2, Loader2
} from 'lucide-react';
import { getProperties, getUnits, getTenants, getWorkOrders } from '../services/rentManager';

const DEMO_MESSAGES = [
  {
    id: 1,
    type: 'system',
    sender: 'Breeze AI',
    avatar: 'bot',
    text: 'Welcome to Breeze! I\'m your property management assistant. You can ask me anything — pull up leases, submit maintenance requests, check rent status, or message your team. Just type or tap the walkie-talkie button to talk.',
    time: '9:00 AM',
  },
  {
    id: 2,
    type: 'user',
    sender: 'You',
    avatar: 'user',
    text: 'Can you pull up the lease for unit 204 at Oakwood Apartments?',
    time: '9:02 AM',
  },
  {
    id: 3,
    type: 'system',
    sender: 'Breeze AI',
    avatar: 'bot',
    text: 'Here\'s the lease for Unit 204, Oakwood Apartments:',
    time: '9:02 AM',
    attachment: {
      name: 'Lease_Oakwood_204_Johnson.pdf',
      size: '2.4 MB',
      type: 'lease',
    },
  },
  {
    id: 4,
    type: 'user',
    sender: 'You',
    avatar: 'user',
    text: 'Send that to the tenant with a reminder that it expires in 60 days.',
    time: '9:03 AM',
  },
  {
    id: 5,
    type: 'system',
    sender: 'Breeze AI',
    avatar: 'bot',
    text: 'Done! I\'ve sent the lease to Sarah Johnson (sarah.j@email.com) along with a renewal reminder noting the 60-day expiration window. She\'ll also see it in her tenant portal.',
    time: '9:03 AM',
  },
];

const QUICK_ACTIONS = [
  { icon: FileText, label: 'Pull a lease', color: '#0077B6', query: 'properties' },
  { icon: DollarSign, label: 'Rent status', color: '#2E7D32', query: 'tenants' },
  { icon: Wrench, label: 'Maintenance', color: '#E65100', query: 'workorders' },
  { icon: Home, label: 'Vacancies', color: '#6A1B9A', query: 'units' },
  { icon: Building2, label: 'Properties', color: '#00695C', query: 'properties' },
  { icon: User, label: 'Tenants', color: '#1565C0', query: 'tenants' },
];

// Simple keyword-based intent detection for the chat
function detectIntent(text) {
  const t = text.toLowerCase();
  if (t.includes('propert')) return 'properties';
  if (t.includes('unit') || t.includes('vacanc') || t.includes('vacant') || t.includes('occupied')) return 'units';
  if (t.includes('tenant') || t.includes('resident') || t.includes('rent status')) return 'tenants';
  if (t.includes('maintenance') || t.includes('work order') || t.includes('repair') || t.includes('fix')) return 'workorders';
  return null;
}

function formatPropertiesResponse(data) {
  if (!data || data.length === 0) return 'No properties found in Rent Manager.';
  const lines = data.slice(0, 10).map((p, i) =>
    `${i + 1}. ${p.name}${p.city ? ` — ${p.city}${p.state ? ', ' + p.state : ''}` : ''}${p.address ? `\n    ${p.address}` : ''}`
  );
  return `Found ${data.length} properties in Rent Manager:\n\n${lines.join('\n')}${data.length > 10 ? `\n\n...and ${data.length - 10} more.` : ''}`;
}

function formatUnitsResponse(data) {
  if (!data || data.length === 0) return 'No units found.';
  const vacant = data.filter(u => {
    const s = (u.status || '').toLowerCase();
    return s.includes('vacant') || s.includes('available') || (!s.includes('occupied') && !s.includes('current'));
  });
  const occupied = data.length - vacant.length;
  let response = `Found ${data.length} total units — ${occupied} occupied, ${vacant.length} vacant.`;
  if (vacant.length > 0) {
    const vacantList = vacant.slice(0, 8).map(u =>
      `  - ${u.name} (Property ${u.propertyId})${u.marketRent ? ` — $${u.marketRent}/mo` : ''}`
    );
    response += `\n\nVacant units:\n${vacantList.join('\n')}`;
    if (vacant.length > 8) response += `\n  ...and ${vacant.length - 8} more.`;
  }
  return response;
}

function formatTenantsResponse(data) {
  if (!data || data.length === 0) return 'No tenants found.';
  const lines = data.slice(0, 8).map(t =>
    `  - ${t.name}${t.email ? ` (${t.email})` : ''}${t.status ? ` — ${t.status}` : ''}`
  );
  return `Found ${data.length} tenants:\n\n${lines.join('\n')}${data.length > 8 ? `\n\n...and ${data.length - 8} more.` : ''}`;
}

function formatWorkOrdersResponse(data) {
  if (!data || data.length === 0) return 'No work orders found.';
  const open = data.filter(w => {
    const s = (w.status || '').toLowerCase();
    return !s.includes('complete') && !s.includes('closed');
  });
  const lines = open.slice(0, 6).map(wo =>
    `  - WO-${wo.id}: ${wo.summary || 'No description'} [${wo.priority || 'normal'}] — ${wo.status || 'open'}`
  );
  return `Found ${data.length} work orders (${open.length} open):\n\n${lines.join('\n')}${open.length > 6 ? `\n\n...and ${open.length - 6} more open.` : ''}`;
}

export default function ChatHome() {
  const [messages, setMessages] = useState(DEMO_MESSAGES);
  const [input, setInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const addBotMessage = (text, extra = {}) => {
    setMessages(prev => [...prev, {
      id: Date.now() + Math.random(),
      type: 'system',
      sender: 'Breeze AI',
      avatar: 'bot',
      text,
      time: now(),
      ...extra,
    }]);
  };

  const handleLiveQuery = async (intent, userText) => {
    setIsThinking(true);
    try {
      let data, response;
      switch (intent) {
        case 'properties':
          data = await getProperties();
          response = data ? formatPropertiesResponse(data) : null;
          break;
        case 'units':
          data = await getUnits();
          response = data ? formatUnitsResponse(data) : null;
          break;
        case 'tenants':
          data = await getTenants();
          response = data ? formatTenantsResponse(data) : null;
          break;
        case 'workorders':
          data = await getWorkOrders();
          response = data ? formatWorkOrdersResponse(data) : null;
          break;
      }

      if (response) {
        addBotMessage(response);
      } else {
        addBotMessage(
          `I tried to fetch ${intent} from Rent Manager but the API isn't connected yet. ` +
          `Once deployed to Vercel with the RM credentials, I'll be able to pull live data right here in chat.`
        );
      }
    } catch {
      addBotMessage('Something went wrong connecting to Rent Manager. Please try again.');
    }
    setIsThinking(false);
  };

  const handleSend = () => {
    if (!input.trim()) return;
    const userText = input;
    const newMsg = {
      id: Date.now(),
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: userText,
      time: now(),
    };
    setMessages(prev => [...prev, newMsg]);
    setInput('');

    const intent = detectIntent(userText);
    if (intent) {
      handleLiveQuery(intent, userText);
    } else {
      setTimeout(() => {
        addBotMessage(
          'I understand your request. Try asking about properties, units, tenants, or maintenance ' +
          '— I can pull that data live from Rent Manager when the API is connected.'
        );
      }, 800);
    }
  };

  const handleQuickAction = (action) => {
    setInput('');
    setShowQuickActions(false);
    const userText = `Show me ${action.label.toLowerCase()}`;
    setMessages(prev => [...prev, {
      id: Date.now(),
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: userText,
      time: now(),
    }]);
    handleLiveQuery(action.query, userText);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleRecording = () => {
    setIsRecording(!isRecording);
    if (!isRecording) {
      setTimeout(() => setIsRecording(false), 3000);
    }
  };

  return (
    <div className="chat-home">
      {/* Quick actions bar */}
      <div className="quick-actions-bar">
        <button
          className="quick-actions-toggle"
          onClick={() => setShowQuickActions(!showQuickActions)}
        >
          Quick Actions <ChevronDown size={14} style={{
            transform: showQuickActions ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.2s'
          }} />
        </button>
        {showQuickActions && (
          <div className="quick-actions-grid">
            {QUICK_ACTIONS.map((action, i) => (
              <button
                key={i}
                className="quick-action-chip"
                onClick={() => handleQuickAction(action)}
              >
                <action.icon size={16} color={action.color} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble-row ${msg.type}`}>
            <div className="chat-avatar">
              {msg.avatar === 'bot' ? (
                <div className="avatar-icon bot-avatar">
                  <Bot size={18} />
                </div>
              ) : (
                <div className="avatar-icon user-avatar">
                  <User size={18} />
                </div>
              )}
            </div>
            <div className="chat-bubble-content">
              <div className="chat-bubble-header">
                <span className="chat-sender">{msg.sender}</span>
                <span className="chat-time">{msg.time}</span>
              </div>
              <div className={`chat-bubble ${msg.type}`}>
                <p style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</p>
                {msg.attachment && (
                  <div className="chat-attachment">
                    <FileText size={20} />
                    <div className="attachment-info">
                      <span className="attachment-name">{msg.attachment.name}</span>
                      <span className="attachment-size">{msg.attachment.size}</span>
                    </div>
                    <button className="attachment-download">View</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
        {isThinking && (
          <div className="chat-bubble-row system">
            <div className="chat-avatar">
              <div className="avatar-icon bot-avatar">
                <Bot size={18} />
              </div>
            </div>
            <div className="chat-bubble-content">
              <div className="chat-bubble system thinking-bubble">
                <Loader2 size={16} className="spin" />
                <span>Querying Rent Manager...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <div className="chat-input-container">
          <button className="chat-attach-btn" title="Attach file">
            <Paperclip size={20} />
          </button>
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Ask Breeze anything... pull a lease, check rent, submit a work order..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            title="Send message"
          >
            <Send size={20} />
          </button>
        </div>

        {/* Walkie-talkie button */}
        <button
          className={`walkie-talkie-btn ${isRecording ? 'recording' : ''}`}
          onClick={toggleRecording}
          title={isRecording ? 'Stop recording' : 'Hold to talk'}
        >
          <div className="walkie-inner">
            {isRecording ? <MicOff size={24} /> : <Mic size={24} />}
            <span>{isRecording ? 'Listening...' : 'Talk to Breeze'}</span>
          </div>
          {isRecording && (
            <div className="recording-pulse" />
          )}
        </button>
      </div>
    </div>
  );
}
