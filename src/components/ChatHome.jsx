import { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, Send, Paperclip, FileText, Home, DollarSign,
  Wrench, User, Bot, ChevronDown, Building2, Loader2,
  Volume2, VolumeX, ArrowRight,
} from 'lucide-react';
import {
  startListening, stopListening, speak, cancelSpeech,
  isListeningSupported, isSpeakingSupported,
} from '../lib/voice';
import { notifyCliq } from '../lib/notify';

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

// Parse a SHOWME marker from a Breeze reply.
// Format: [SHOWME view=maintenance status=open min_priority=urgent]
// Returns { view, filters, displayText } where displayText is the reply
// with the marker stripped out.
const SHOWME_REGEX = /\s*\[SHOWME\s+([^\]]+)\]\s*$/i;

function parseShowMe(reply) {
  if (!reply) return { view: null, filters: null, displayText: reply };
  const match = reply.match(SHOWME_REGEX);
  if (!match) return { view: null, filters: null, displayText: reply };

  const body = match[1];
  const parts = body.split(/\s+/).filter(Boolean);
  const kv = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k) kv[k] = v;
  }
  const view = kv.view || null;
  delete kv.view;

  return {
    view,
    filters: Object.keys(kv).length ? kv : null,
    displayText: reply.replace(SHOWME_REGEX, '').trimEnd(),
  };
}

function ShowMeButtonLabel({ view, filters }) {
  const parts = [];
  if (filters?.status) parts.push(filters.status);
  if (filters?.min_priority) parts.push(`${filters.min_priority}+`);
  if (filters?.category) parts.push(filters.category);
  if (filters?.search) parts.push(`"${filters.search}"`);
  const tail = parts.length ? ` (${parts.join(', ')})` : '';
  const label = view === 'maintenance' ? 'maintenance' : view;
  return <>Show me in {label}{tail}</>;
}

const QUICK_ACTIONS = [
  { icon: User, label: 'Who lives at...', color: '#1565C0', prompt: 'List my current tenants' },
  { icon: DollarSign, label: 'Balances', color: '#2E7D32', prompt: 'Which tenants have an outstanding balance?' },
  { icon: Wrench, label: 'Open maintenance', color: '#E65100', prompt: 'Show me open work orders' },
  { icon: Home, label: 'Vacant units', color: '#6A1B9A', prompt: 'Which units are currently vacant?' },
  { icon: Building2, label: 'Properties', color: '#00695C', prompt: 'List all properties' },
  { icon: FileText, label: 'Lease details', color: '#0077B6', prompt: "What are the lease details for Marcia Clark?" },
];

export default function ChatHome({ onNavigate }) {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Conversation history sent to the LLM (role/content only, no UI fields)
  const llmHistoryRef = useRef([]);
  const stopListenRef = useRef(null);
  const voiceInputPendingRef = useRef(false);

  const voiceListenSupported = isListeningSupported();
  const voiceSpeakSupported = isSpeakingSupported();

  // Cancel any in-progress speech when the component unmounts
  useEffect(() => {
    return () => {
      cancelSpeech();
      stopListening();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const addMessage = (msg) => {
    setMessages((prev) => [...prev, { id: Date.now() + Math.random(), time: now(), ...msg }]);
  };

  const sendToLLM = async (userText) => {
    // Fire-and-forget: mirror every Chat Home request (typed, spoken,
    // or quick-action) into the team Cliq channel via /api/notify. The
    // helper never throws, so we don't need to await it or wrap it in a
    // try/catch — the chat flow continues regardless of Cliq delivery.
    notifyCliq({
      recipient: 'the team',
      message: userText,
      context: 'Breeze OS request from Chat Home',
    });

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

      // Append assistant turn to history so follow-ups keep context.
      // Keep the raw marker in the LLM history so "show me" follow-ups
      // retain the structured context, but strip it from the display.
      llmHistoryRef.current = [
        ...llmHistoryRef.current,
        { role: 'assistant', content: data.reply },
      ];

      const { view, filters, displayText } = parseShowMe(data.reply);

      addMessage({
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: displayText,
        showMe: view ? { view, filters } : null,
      });

      // Read response aloud if TTS is on (use stripped text so the
      // marker isn't spoken verbatim)
      if (ttsEnabled && voiceSpeakSupported) {
        speak(displayText);
      }
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
    if (!voiceListenSupported) return;

    // If already listening, stop — onFinal will fire via the voice module
    if (isRecording) {
      stopListenRef.current?.();
      return;
    }

    // If Breeze is currently speaking, cut it off before the user talks
    cancelSpeech();

    setIsRecording(true);
    setInput('');
    voiceInputPendingRef.current = true;

    const stop = startListening({
      onInterim: (text) => {
        setInput(text);
      },
      onFinal: (text) => {
        setIsRecording(false);
        stopListenRef.current = null;
        // Auto-send the final transcript. Use the captured text directly
        // since state updates are async and handleSend reads from `input`.
        if (voiceInputPendingRef.current && text && text.trim()) {
          voiceInputPendingRef.current = false;
          sendFromVoice(text.trim());
        } else {
          voiceInputPendingRef.current = false;
        }
      },
      onError: (err) => {
        setIsRecording(false);
        stopListenRef.current = null;
        voiceInputPendingRef.current = false;
        console.warn('Voice recognition error:', err.message);
      },
    });
    stopListenRef.current = stop;
  };

  const sendFromVoice = (text) => {
    addMessage({
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text,
    });
    setInput('');
    sendToLLM(text);
  };

  const toggleTts = () => {
    if (!voiceSpeakSupported) return;
    if (ttsEnabled) {
      // Turning off — cut off any in-progress speech
      cancelSpeech();
    }
    setTtsEnabled(!ttsEnabled);
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
        {voiceSpeakSupported && (
          <button
            className={`tts-toggle ${ttsEnabled ? 'active' : ''}`}
            onClick={toggleTts}
            title={ttsEnabled ? 'Mute replies' : 'Read replies aloud'}
          >
            {ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span>{ttsEnabled ? 'Voice on' : 'Voice off'}</span>
          </button>
        )}
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
                {msg.showMe && onNavigate && (
                  <button
                    className="chat-showme-btn"
                    onClick={() => onNavigate(msg.showMe.view, msg.showMe.filters)}
                  >
                    <ShowMeButtonLabel view={msg.showMe.view} filters={msg.showMe.filters} />
                    <ArrowRight size={14} />
                  </button>
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
          className={`walkie-talkie-btn ${isRecording ? 'recording' : ''} ${!voiceListenSupported ? 'disabled' : ''}`}
          onClick={toggleRecording}
          disabled={!voiceListenSupported || isThinking}
          title={
            !voiceListenSupported
              ? 'Voice not supported in this browser'
              : isRecording
              ? 'Tap to stop and send'
              : 'Tap to talk'
          }
        >
          <div className="walkie-inner">
            {isRecording ? <MicOff size={24} /> : <Mic size={24} />}
            <span>
              {!voiceListenSupported
                ? 'Voice unavailable'
                : isRecording
                ? 'Listening... tap to send'
                : 'Tap to talk'}
            </span>
          </div>
          {isRecording && <div className="recording-pulse" />}
        </button>
      </div>
    </div>
  );
}
