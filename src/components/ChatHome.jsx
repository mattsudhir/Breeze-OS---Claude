import { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, Send, Paperclip, FileText, Home, DollarSign,
  Wrench, User, Bot, ChevronDown, X, Building2
} from 'lucide-react';

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
  { icon: FileText, label: 'Pull a lease', color: '#0077B6' },
  { icon: DollarSign, label: 'Rent status', color: '#2E7D32' },
  { icon: Wrench, label: 'Maintenance', color: '#E65100' },
  { icon: Home, label: 'Vacancies', color: '#6A1B9A' },
  { icon: Building2, label: 'Properties', color: '#00695C' },
  { icon: User, label: 'Tenants', color: '#1565C0' },
];

export default function ChatHome() {
  const [messages, setMessages] = useState(DEMO_MESSAGES);
  const [input, setInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const newMsg = {
      id: Date.now(),
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: input,
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, newMsg]);
    setInput('');

    // Simulated AI response
    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: 'I\'m processing your request. In the full version, I\'ll be able to pull up any property data, generate documents, coordinate with your team, and more — all right here in chat.',
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      }]);
    }, 1200);
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
      // Simulate stopping after 3s
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
                onClick={() => {
                  setInput(`Show me ${action.label.toLowerCase()}`);
                  setShowQuickActions(false);
                  inputRef.current?.focus();
                }}
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
                <p>{msg.text}</p>
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
            disabled={!input.trim()}
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
