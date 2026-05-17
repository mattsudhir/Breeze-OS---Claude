import { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, Send, Paperclip, FileText, Home, DollarSign,
  Wrench, User, Bot, ChevronDown, Building2, Loader2,
  Volume2, VolumeX, ArrowRight, X, Square, Sparkles,
} from 'lucide-react';
import { upload as blobUpload } from '@vercel/blob/client';
import {
  startListening, stopListening, speak, cancelSpeech,
  isListeningSupported, isSpeakingSupported,
} from '../lib/voice';
import { notifyCliq } from '../lib/notify';
import { useDataSource } from '../contexts/DataSourceContext.jsx';

const WELCOME_MESSAGE = {
  id: 1,
  type: 'system',
  sender: 'Breeze AI',
  avatar: 'bot',
  text:
    "Hi! I'm Breeze AI. Ask me anything about your portfolio — tenants, leases, " +
    "properties, maintenance, balances. I'll pull live data from AppFolio. " +
    'Try: "How many active tenants do we have?" or "List all properties."',
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
  { icon: Sparkles, label: 'Daily briefing', color: '#6A1B9A',
    prompt: "What's my daily briefing?" },
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
  // Escalating "still working" text shown in the Thinking pill so
  // users know we haven't hung up on them. The hangups always
  // happen mid-fetch when a query falls outside the chat_metrics
  // cache and the agent has to talk to AppFolio directly (10-60s).
  // Updates are pure client-side — no server coordination needed.
  const [thinkingMessage, setThinkingMessage] = useState('Thinking…');
  const thinkingTimersRef = useRef([]);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const { dataSource, sources: DATA_SOURCES } = useDataSource();
  // Pending attachment for the next message. Shape:
  // { url, filename, contentType, isUploading: boolean } | null
  const [attachment, setAttachment] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  // AbortController for the in-flight /api/chat request, so the user
  // can stop a slow response (often after a voice-transcription error)
  // without waiting for it to come back.
  const abortControllerRef = useRef(null);

  // Conversation history sent to the LLM (role/content only, no UI fields)
  const llmHistoryRef = useRef([]);
  const stopListenRef = useRef(null);
  const voiceInputPendingRef = useRef(false);

  const voiceListenSupported = isListeningSupported();
  const voiceSpeakSupported = isSpeakingSupported();

  // Cancel any in-progress speech, voice input, or chat fetch when
  // the component unmounts (user navigated away).
  useEffect(() => {
    return () => {
      cancelSpeech();
      stopListening();
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // The data source is now app-wide (TopBar drives it). When it
  // changes from somewhere else, reset the LLM history so the new
  // backend doesn't see tool calls for tools it doesn't have, and
  // announce the switch in-chat so the user knows the context was
  // cleared. The ref skips the first render — no spurious "switched
  // to AppFolio" line on initial load.
  const prevDataSourceRef = useRef(dataSource);
  useEffect(() => {
    if (prevDataSourceRef.current === dataSource) return;
    prevDataSourceRef.current = dataSource;
    llmHistoryRef.current = [];
    const label = DATA_SOURCES.find((d) => d.value === dataSource)?.label || dataSource;
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: `Switched data source to *${label}*. Previous conversation context has been cleared.`,
        time: now(),
      },
    ]);
  }, [dataSource, DATA_SOURCES]);

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

    // New AbortController for this request. The user can hit Stop
    // while the agent is thinking — typically after a voice transcript
    // came through wrong — and we abort the fetch on the client side.
    // Note: the server function keeps running to completion (Vercel
    // serverless has no upstream cancellation), so the LLM tokens are
    // still spent — but the user gets their input back instantly and
    // we never render the abandoned response.
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsThinking(true);
    setThinkingMessage('Thinking…');
    // Escalation timeline: cached metrics return in ~3-5s, so by 6s
    // we know we're in slow-path territory; by 20s we're almost
    // certainly doing a fresh AppFolio scan.
    thinkingTimersRef.current.forEach(clearTimeout);
    thinkingTimersRef.current = [
      setTimeout(() => setThinkingMessage('Still working…'), 6000),
      setTimeout(
        () => setThinkingMessage('Pulling fresh data — about 30 seconds.'),
        18000,
      ),
      setTimeout(
        () =>
          setThinkingMessage(
            'Big query — could be up to a minute or two. Hang tight.',
          ),
        45000,
      ),
    ];
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: llmHistoryRef.current,
          dataSource,
        }),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      // Parse defensively — Vercel returns an HTML/text error page
      // when a serverless function crashes or times out, and the raw
      // `Unexpected token` JSON parse error is useless to users.
      let data;
      try {
        data = await res.json();
      } catch {
        addMessage({
          type: 'system',
          sender: 'Breeze AI',
          avatar: 'bot',
          text:
            res.status === 504 || res.status === 408
              ? 'That took too long to come back. Try a more specific question, or break it into smaller pieces.'
              : `Sorry, the server returned an unexpected response (HTTP ${res.status}). Try again in a moment.`,
        });
        return;
      }
      if (controller.signal.aborted) return;

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
      // User-initiated cancel — silently drop, the stop handler
      // already added a "Stopped." note.
      if (err.name === 'AbortError') return;
      addMessage({
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: `Network error: ${err.message}`,
      });
    } finally {
      // Only clear refs/state if we're still the current request — a
      // newer one may have replaced us by the time we get here.
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsThinking(false);
        thinkingTimersRef.current.forEach(clearTimeout);
        thinkingTimersRef.current = [];
      }
    }
  };

  // User clicks Stop while the agent is thinking. Aborts the fetch,
  // resets the spinner, kills any in-progress speech, and drops a
  // small "Stopped." note in chat so the user knows what happened.
  const handleStopThinking = () => {
    const controller = abortControllerRef.current;
    if (!controller) return;
    abortControllerRef.current = null;
    controller.abort();
    setIsThinking(false);
    thinkingTimersRef.current.forEach(clearTimeout);
    thinkingTimersRef.current = [];
    cancelSpeech();
    addMessage({
      type: 'system',
      sender: 'Breeze AI',
      avatar: 'bot',
      text: '_Stopped._',
    });
  };

  // ── Attachment upload ───────────────────────────────────────────
  // Paperclip → file picker → @vercel/blob/client direct upload.
  // Bytes go browser-direct to Blob storage with a one-shot signed
  // token from /api/upload, so we're not bound by the 4.5MB function
  // request body cap. The resulting public URL is stashed in
  // `attachment` and inlined into the next user message as
  // "[Attachment: <url>]" so the agent (and charge_tenant in
  // particular) can pick it up.

  const handleAttachClick = () => {
    if (attachment?.isUploading || isThinking) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires onChange
    if (!file) return;

    setAttachment({
      url: null,
      filename: file.name,
      contentType: file.type,
      isUploading: true,
    });

    try {
      const blob = await blobUpload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        contentType: file.type,
      });
      setAttachment({
        url: blob.url,
        filename: file.name,
        contentType: file.type,
        isUploading: false,
      });
    } catch (err) {
      console.warn('Attachment upload failed:', err);
      setAttachment(null);
      addMessage({
        type: 'system',
        sender: 'Breeze AI',
        avatar: 'bot',
        text: `Attachment upload failed: ${err.message || 'unknown error'}`,
      });
    }
  };

  const removeAttachment = () => {
    if (attachment?.isUploading) return;
    setAttachment(null);
  };

  const handleSend = () => {
    if (isThinking) return;
    if (!input.trim() && !attachment?.url) return;
    if (attachment?.isUploading) return;

    const userText = input.trim();
    // Inline the attachment URL into the prompt the LLM sees so
    // charge_tenant (and any future tools that take an URL) can pick
    // it up. The chat bubble itself renders the file separately, so
    // the user doesn't see the raw URL in their own message.
    const llmText = attachment?.url
      ? `${userText}${userText ? '\n\n' : ''}[Attachment: ${attachment.url}]`
      : userText;

    addMessage({
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text: userText,
      attachment: attachment?.url
        ? {
            name: attachment.filename,
            url: attachment.url,
            contentType: attachment.contentType,
          }
        : null,
    });
    setInput('');
    setAttachment(null);
    sendToLLM(llmText);
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
        // Surface the error in-chat so the user can see what went wrong
        // instead of the record button just silently resetting.
        addMessage({
          type: 'system',
          sender: 'Breeze AI',
          avatar: 'bot',
          text: `Voice input failed: ${err.message}`,
        });
      },
    });
    stopListenRef.current = stop;
  };

  const sendFromVoice = (text) => {
    if (attachment?.isUploading) return;
    const llmText = attachment?.url
      ? `${text}${text ? '\n\n' : ''}[Attachment: ${attachment.url}]`
      : text;

    addMessage({
      type: 'user',
      sender: 'You',
      avatar: 'user',
      text,
      attachment: attachment?.url
        ? {
            name: attachment.filename,
            url: attachment.url,
            contentType: attachment.contentType,
          }
        : null,
    });
    setInput('');
    setAttachment(null);
    sendToLLM(llmText);
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
                    {msg.attachment.contentType?.startsWith('image/') ? (
                      <img
                        src={msg.attachment.url}
                        alt={msg.attachment.name}
                        style={{
                          maxWidth: 240,
                          maxHeight: 240,
                          borderRadius: 6,
                          objectFit: 'cover',
                        }}
                      />
                    ) : (
                      <FileText size={20} />
                    )}
                    <div className="attachment-info">
                      <span className="attachment-name">{msg.attachment.name}</span>
                      {msg.attachment.size && (
                        <span className="attachment-size">{msg.attachment.size}</span>
                      )}
                    </div>
                    {msg.attachment.url && (
                      <a
                        className="attachment-download"
                        href={msg.attachment.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View
                      </a>
                    )}
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
                <span>{thinkingMessage}</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {attachment && (
          <div
            className="chat-pending-attachment"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px 6px 6px',
              margin: '0 0 8px',
              background: '#F2F6FA',
              border: '1px solid #D0D7DE',
              borderRadius: 8,
              fontSize: 12,
              color: '#1A1A1A',
              maxWidth: 320,
            }}
          >
            {attachment.isUploading ? (
              <Loader2 size={14} className="spin" />
            ) : attachment.contentType?.startsWith('image/') && attachment.url ? (
              <img
                src={attachment.url}
                alt={attachment.filename}
                style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4 }}
              />
            ) : (
              <FileText size={14} />
            )}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {attachment.filename}
              {attachment.isUploading ? ' — uploading…' : ''}
            </span>
            <button
              type="button"
              onClick={removeAttachment}
              disabled={attachment.isUploading}
              title="Remove attachment"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: attachment.isUploading ? 'default' : 'pointer',
                color: '#6A737D',
                padding: 2,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
        <div className="chat-input-container">
          <button
            className="chat-attach-btn"
            title="Attach photo or PDF"
            onClick={handleAttachClick}
            disabled={attachment?.isUploading || isThinking}
          >
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
            onClick={isThinking ? handleStopThinking : handleSend}
            disabled={
              isThinking
                ? false
                : attachment?.isUploading || (!input.trim() && !attachment?.url)
            }
            title={isThinking ? 'Stop' : 'Send message'}
          >
            {isThinking ? <Square size={18} /> : <Send size={20} />}
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
