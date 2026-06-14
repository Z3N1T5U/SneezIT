// ============================================================================
// ChatPanel Component
// ============================================================================
// Real-time text chat between peers, using WebRTC DataChannel or Socket.io fallback.
// This is a "brownie points" feature — it adds polish and demonstrates
// that the DataChannel can be used for more than just file transfer.

import { useState, useRef, useEffect } from 'react';
import { MessageCircle, Send, X, ChevronDown } from 'lucide-react';

export default function ChatPanel({ messages, onSendMessage, peerConnected }) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Open chat panel when first message arrives
  useEffect(() => {
    if (messages.length > 0 && !isOpen) {
      setIsOpen(true);
    }
  }, [messages.length]);

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text || !peerConnected) return;

    onSendMessage(text);
    setInputValue('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const unreadCount = isOpen ? 0 : messages.filter(m => m.from === 'peer' && !m.read).length;

  return (
    <>
      {/* Floating Chat Toggle Button */}
      {!isOpen && (
        <button
          id="chat-toggle-btn"
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-brand-600 hover:bg-brand-500 text-white flex items-center justify-center shadow-lg transition-all duration-300 hover:scale-110 z-50"
          title="Open chat"
        >
          <MessageCircle size={24} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
              {unreadCount}
            </span>
          )}
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-80 h-96 glass-strong flex flex-col z-50 shadow-2xl animate-slide-up overflow-hidden"
             style={{ borderRadius: '16px' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <MessageCircle size={18} className="text-brand-400" />
              <span className="text-sm font-semibold">Chat</span>
              {peerConnected && (
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
              )}
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white transition-colors"
            >
              <ChevronDown size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 ? (
              <div className="text-center text-gray-500 text-sm mt-8">
                {peerConnected
                  ? 'Say hello to your peer! 👋'
                  : 'Connect to a peer to start chatting'}
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.from === 'me' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
                      msg.from === 'me'
                        ? 'bg-brand-600 text-white rounded-br-md'
                        : 'bg-white/10 text-gray-200 rounded-bl-md'
                    }`}
                  >
                    <p className="break-words">{msg.message}</p>
                    <p className={`text-[10px] mt-1 ${
                      msg.from === 'me' ? 'text-brand-200' : 'text-gray-500'
                    }`}>
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-white/10">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={peerConnected ? 'Type a message...' : 'Waiting for peer...'}
                disabled={!peerConnected}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 disabled:opacity-50 transition-all"
                id="chat-input"
              />
              <button
                onClick={handleSend}
                disabled={!inputValue.trim() || !peerConnected}
                className="w-9 h-9 rounded-xl bg-brand-600 hover:bg-brand-500 text-white flex items-center justify-center transition-all disabled:opacity-30 disabled:hover:bg-brand-600 flex-shrink-0"
                id="chat-send-btn"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
