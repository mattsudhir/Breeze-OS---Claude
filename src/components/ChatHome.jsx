import { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, Send, Paperclip, FileText, Home, DollarSign,
  Wrench, User, Bot, ChevronDown, Building2, Loader2,
} from 'lucide-react';

const WELCOME_MESSAGE = {
  id: 1,
  type: 'system',
  sender: 'Breeze AI',
  avatar: 'bot',
  text:
    "Hi! I'm Breeze AI. Ask me anything about your portfolio — tenants, leases, " +
    "properties, maintenance, balances. I'll pull live data from Rent Manager. " +
    'Try: "What is Marcia Clark\'s email?" or "Show me vacant units at Oakwood."',
  time: '9:00 AM',
};

const QUICK_ACTIONS = [
  { icon: User, label: 'Who lives at...', color: '#1565C0', prompt: 'List my current tenants' },
  { icon: DollarSign, label: 'Balances', color: '#2E7D32', prompt: 'Which tenants have an outstanding balance?' },
  { icon: Wrench, label: 'Open maintenance', color: '#E65100', prompt: 'Show me open work orders' },
  { icon: Home, label: 'Vacant units', color: '#6A1B9A', prompt: 'Which units are currently vacant?' },
  { icon: Building2, label: 'Properties', color: '#00695C', prompt: 'List all properties' },
  { icon: FileText, label: 'Lease details', color: '#0077B6', prompt: "What are the lease details for Marcia Clark?" },
];

export default function ChatHome() {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Conversation history sent to the LLM (role/content only, no UI fields)
  const llmHistoryRef = useRef([]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const addMessage = (msg) => {
    setMessages((prev) => [...prev, { id: Date.now() + Math.random(), time: now(), ...msg }]);
  };

  const sendToLLM = async (userText) => {
    // Append user turn to history
    llmHistoryRef.current = [
      ...llmHistoryRef.current,
      { role: 'user', content: userText },
    ];

    setIsThinking(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: llmHistoryRef.current }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        addMessage({
          type: 'system',
          sender: 'Breeze AI',
          avatar: 'bot',
          text: `Sorry, something went wrong: ${data.error || `HTTP ${res.status}`}`,
        });
        return;
      }

      // Append assistant turn to history so follow-ups keep context
      llmHistoryRef.current = [
        ...llmHistoryRef.current,
        { role: 'assistant', content: data.reply },
      ];

      addMessage({
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: data.reply,
      });
    } catch (err) {
      addMessage({
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: `Network error: ${err.message}`,
      });
    } finally {
      setIsThinking(false);
    }
  };

  const handleSend = () => {
    if (!input.trim() || isThinking) return;
    const userText = input.trim();
    addMessage({
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: userText,
    });
    setInput('');
    sendToLLM(userText);
  };

  const handleQuickAction = (action) => {
    if (isThinking) return;
    setShowQuickActions(false);
    addMessage({
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: action.prompt,
    });
    sendToLLM(action.prompt);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleRecording = () => {
    // Voice support comes in Phase 2 (Web Speech API)
    setIsRecording(!isRecording);
    if (!isRecording) {
      setTimeout(() => setIsRecording(false), 2000);
    }
  };

  return (
    <div className="chat-home">
      <div className="quick-actions-bar">
        <button
          className="quick-actions-toggle"
          onClick={() => setShowQuickActions(!showQuickActions)}
        >
          Quick Actions <ChevronDown size={14} style={{
            transform: showQuickActions ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.2s',
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
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-container">
          <button className="chat-attach-btn" title="Attach file">
            <Paperclip size={20} />
          </button>
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Ask Breeze anything..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isThinking}
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

        <button
          className={`walkie-talkie-btn ${isRecording ? 'recording' : ''}`}
          onClick={toggleRecording}
          title={isRecording ? 'Stop recording' : 'Hold to talk'}
        >
          <div className="walkie-inner">
            {isRecording ? <MicOff size={24} /> : <Mic size={24} />}
            <span>{isRecording ? 'Listening...' : 'Talk to Breeze'}</span>
          </div>
          {isRecording && <div className="recording-pulse" />}
        </button>
      </div>
    </div>
  );
}
