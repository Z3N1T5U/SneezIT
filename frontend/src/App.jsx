// ============================================================================
// PeerDrop — Main Application Component
// ============================================================================
//
// This is the main UI for PeerDrop. It manages the entire application flow:
//   1. Landing page — create or join a room
//   2. Waiting room — share the room code, wait for peer
//   3. Connected — select files, send/receive, view progress
//   4. Complete — transfer finished, hash verification results
//
// STATE MACHINE:
//   idle → creating → waiting → connecting → connected → transferring → complete
//                                                 ↕
//                                              (chat available)
//
// ============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, Download, Copy, Check, Link2, Wifi, WifiOff,
  Shield, ShieldCheck, ShieldX, ArrowRight, FileIcon,
  Image, Video, Music, FileText, Archive, FileCode,
  Zap, Globe, ChevronRight, RefreshCw, X, Users, Radio,
  Send, Loader2
} from 'lucide-react';
import { connectSocket, disconnectSocket, getSocket } from './lib/socket';
import { PeerConnection } from './lib/webrtc';
import { formatFileSize, formatSpeed, formatDuration, getFileIcon } from './lib/fileUtils';
import ChatPanel from './components/ChatPanel';

// ============================================================================
// File Icon Mapper — maps icon names to Lucide components
// ============================================================================
const FILE_ICONS = {
  File: FileIcon,
  Image: Image,
  Video: Video,
  Music: Music,
  FileText: FileText,
  Archive: Archive,
  FileCode: FileCode,
};

// ============================================================================
// Main App Component
// ============================================================================
export default function App() {
  // --- Application State ---
  const [appState, setAppState] = useState('idle');
  // 'idle' | 'creating' | 'waiting' | 'joining' | 'connecting' | 'connected' | 'transferring' | 'complete'
  
  const [roomId, setRoomId] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [isSender, setIsSender] = useState(false);
  
  // --- Connection State ---
  const [isRelay, setIsRelay] = useState(false);
  const [iceState, setIceState] = useState({ gathering: 'new', connection: 'new' });
  const [connectionState, setConnectionState] = useState('new');
  
  // --- File State ---
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [fileList, setFileList] = useState([]);        // Metadata of files being transferred
  
  // --- Transfer State ---
  const [progress, setProgress] = useState(null);      // Current transfer progress
  const [completedFiles, setCompletedFiles] = useState([]);  // Files that finished transferring
  const [allComplete, setAllComplete] = useState(false);
  
  // --- Chat State ---
  const [chatMessages, setChatMessages] = useState([]);
  
  // --- Refs ---
  const peerConnectionRef = useRef(null);
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);

  // ---- Parse URL for room ID ----
  // If someone shares a link like https://peerdrop.app/?room=ABC123
  // we auto-fill the join room input
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get('room');
    if (urlRoom) {
      setJoinRoomInput(urlRoom.toUpperCase());
      setStatusMessage('Room code detected from link! Click "Join Room" to connect.');
    }
  }, []);

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      peerConnectionRef.current?.destroy();
      disconnectSocket();
    };
  }, []);

  // ==========================================================================
  // Socket.IO Setup
  // ==========================================================================

  const setupSocket = useCallback(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Socket] Connected to signaling server');
    });

    socket.on('disconnect', () => {
      console.log('[Socket] Disconnected from signaling server');
    });

    socket.on('room-created', ({ roomId: id }) => {
      setRoomId(id);
      setAppState('waiting');
      setStatusMessage('Room created! Share the code below with your peer.');
    });

    socket.on('room-joined', ({ roomId: id }) => {
      setRoomId(id);
      setAppState('connecting');
      setStatusMessage('Joined room! Establishing connection...');
    });

    socket.on('peer-joined', ({ peerId }) => {
      setAppState('connecting');
      setStatusMessage('Peer joined! Establishing WebRTC connection...');
      
      // Sender creates the offer when receiver joins
      if (isSender || appState === 'waiting') {
        createPeerConnection(socket, roomId || '', true);
      }
    });

    socket.on('peer-disconnected', () => {
      setStatusMessage('Peer disconnected.');
      setErrorMessage('Your peer has left the room.');
      if (!allComplete) {
        setAppState('waiting');
      }
    });

    socket.on('error-message', ({ message }) => {
      setErrorMessage(message);
    });

    // Chat messages via Socket.io (fallback when DataChannel isn't ready)
    socket.on('chat-message', ({ message, timestamp }) => {
      setChatMessages(prev => [...prev, { message, from: 'peer', timestamp }]);
    });

    return socket;
  }, []);

  // ==========================================================================
  // WebRTC Peer Connection Setup
  // ==========================================================================

  const createPeerConnection = useCallback((socket, currentRoomId, asSender) => {
    // Clean up existing connection
    peerConnectionRef.current?.destroy();

    const pc = new PeerConnection(socket, currentRoomId, asSender, {
      onStatus: (msg) => setStatusMessage(msg),
      onError: (msg) => setErrorMessage(msg),
      
      onConnected: ({ relay }) => {
        setAppState('connected');
        setIsRelay(relay);
        setStatusMessage(relay
          ? 'Connected via server relay (P2P was blocked by firewall)'
          : 'Direct P2P connection established! 🎉');
      },
      
      onIceState: (state) => setIceState(state),
      onConnectionState: (state) => setConnectionState(state),
      
      onRelayActivated: () => {
        setIsRelay(true);
        setStatusMessage('Switched to server relay — P2P was blocked');
      },
      
      onDataChannelOpen: () => {
        setAppState('connected');
        setStatusMessage('Data channel open — ready to transfer!');
      },
      
      onFileList: (files) => {
        setFileList(files);
        setAppState('transferring');
      },
      
      onTransferStart: (files) => {
        setFileList(files);
        setAppState('transferring');
        setStatusMessage('Transfer started...');
      },
      
      onFileStart: (meta) => {
        setStatusMessage(`Receiving: ${meta.name}...`);
      },
      
      onProgress: (p) => {
        setProgress(p);
      },
      
      onHashVerification: (result) => {
        setCompletedFiles(prev => {
          const updated = [...prev];
          const existing = updated.findIndex(f => f.fileIndex === result.fileIndex);
          if (existing >= 0) {
            updated[existing] = { ...updated[existing], ...result };
          } else {
            updated.push(result);
          }
          return updated;
        });
      },
      
      onFileComplete: (file) => {
        setCompletedFiles(prev => {
          const updated = [...prev];
          const existing = updated.findIndex(f => f.fileIndex === file.fileIndex);
          if (existing >= 0) {
            updated[existing] = { ...updated[existing], ...file };
          } else {
            updated.push(file);
          }
          return updated;
        });
        setStatusMessage(`File received: ${file.name} ${file.verified ? '(verified ✅)' : '(hash mismatch ⚠️)'}`);
      },
      
      onAllFilesComplete: () => {
        setAllComplete(true);
        setAppState('complete');
        setStatusMessage('All files transferred successfully! 🎉');
      },
      
      onChatMessage: (msg) => {
        setChatMessages(prev => [...prev, msg]);
      },
    });

    peerConnectionRef.current = pc;

    if (asSender) {
      pc.createOffer();
    }
  }, []);

  // ==========================================================================
  // User Actions
  // ==========================================================================

  const handleCreateRoom = () => {
    setIsSender(true);
    setErrorMessage('');
    setAppState('creating');
    
    const socket = setupSocket();
    
    // Wait for connection, then create room
    if (socket.connected) {
      socket.emit('create-room');
    } else {
      socket.on('connect', () => {
        socket.emit('create-room');
      });
    }
  };

  const handleJoinRoom = () => {
    const code = joinRoomInput.trim().toUpperCase();
    if (!code) {
      setErrorMessage('Please enter a room code');
      return;
    }
    
    setIsSender(false);
    setErrorMessage('');
    setAppState('joining');
    
    const socket = setupSocket();
    
    const doJoin = () => {
      socket.emit('join-room', { roomId: code });
      setRoomId(code);
      
      // Setup peer connection as receiver — it will handle the incoming offer
      createPeerConnection(socket, code, false);
    };
    
    if (socket.connected) {
      doJoin();
    } else {
      socket.on('connect', doJoin);
    }
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
    }
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSendFiles = async () => {
    if (selectedFiles.length === 0 || !peerConnectionRef.current) return;
    
    setAppState('transferring');
    setStatusMessage('Starting file transfer...');
    
    try {
      await peerConnectionRef.current.sendFiles(selectedFiles);
    } catch (error) {
      setErrorMessage(`Transfer error: ${error.message}`);
    }
  };

  const handleSendChat = (message) => {
    if (!peerConnectionRef.current) return;
    
    const msg = peerConnectionRef.current.sendChatMessage(message);
    setChatMessages(prev => [...prev, { ...msg, from: 'me' }]);
  };

  const handleCopyRoomId = () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    peerConnectionRef.current?.destroy();
    disconnectSocket();
    setAppState('idle');
    setRoomId('');
    setJoinRoomInput('');
    setStatusMessage('');
    setErrorMessage('');
    setSelectedFiles([]);
    setFileList([]);
    setProgress(null);
    setCompletedFiles([]);
    setAllComplete(false);
    setChatMessages([]);
    setIsSender(false);
    setIsRelay(false);
    setIceState({ gathering: 'new', connection: 'new' });
    setConnectionState('new');
    socketRef.current = null;
    peerConnectionRef.current = null;
    // Clear URL params
    window.history.replaceState({}, '', window.location.pathname);
  };

  // ==========================================================================
  // Render Helpers
  // ==========================================================================

  const renderConnectionBadge = () => {
    if (appState === 'idle' || appState === 'creating') return null;
    
    const isConn = ['connected', 'transferring', 'complete'].includes(appState);
    
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
        isConn
          ? isRelay
            ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
            : 'bg-green-500/10 text-green-400 border border-green-500/20'
          : 'bg-gray-500/10 text-gray-400 border border-gray-500/20'
      }`}>
        {isConn ? (
          <>
            {isRelay ? <Globe size={12} /> : <Wifi size={12} />}
            {isRelay ? 'Server Relay' : 'P2P Direct'}
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          </>
        ) : (
          <>
            <Radio size={12} className="animate-pulse" />
            Connecting...
          </>
        )}
      </div>
    );
  };

  const getFileIconComponent = (mimeType) => {
    const iconName = getFileIcon(mimeType);
    const IconComp = FILE_ICONS[iconName] || FileIcon;
    return <IconComp size={20} />;
  };

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <div className="min-h-screen relative">
      {/* Animated Background */}
      <div className="bg-mesh" />
      
      {/* Header */}
      <header className="relative z-10 py-6 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Zap size={20} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
                PeerDrop
              </h1>
              <p className="text-[11px] text-gray-500 -mt-0.5">P2P File Sharing</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {renderConnectionBadge()}
            {appState !== 'idle' && (
              <button
                onClick={handleReset}
                className="text-gray-400 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5"
                title="New session"
                id="reset-btn"
              >
                <RefreshCw size={18} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 px-4 pb-24">
        <div className="max-w-4xl mx-auto">
          
          {/* ============================================================ */}
          {/* IDLE STATE — Landing Page */}
          {/* ============================================================ */}
          {appState === 'idle' && (
            <div className="animate-slide-up">
              {/* Hero */}
              <div className="text-center mb-12 mt-8">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-300 text-xs font-medium mb-6">
                  <Shield size={14} />
                  End-to-End Encrypted · No Server Storage
                </div>
                <h2 className="text-4xl md:text-5xl font-extrabold mb-4 leading-tight">
                  <span className="bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
                    Share files directly,
                  </span>
                  <br />
                  <span className="bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">
                    browser to browser
                  </span>
                </h2>
                <p className="text-gray-400 max-w-lg mx-auto text-sm leading-relaxed">
                  No uploads. No cloud storage. No file size limits.
                  Your files transfer directly between devices using WebRTC — 
                  they never touch a server.
                </p>
              </div>

              {/* Action Cards */}
              <div className="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                {/* Send Card */}
                <button
                  onClick={handleCreateRoom}
                  className="glass group hover:bg-white/[0.07] transition-all duration-300 p-6 text-left cursor-pointer"
                  id="create-room-btn"
                >
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <Upload size={22} className="text-white" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Send Files</h3>
                  <p className="text-sm text-gray-400">
                    Create a room and share the code with your peer
                  </p>
                  <div className="flex items-center gap-1 mt-3 text-brand-400 text-sm font-medium group-hover:gap-2 transition-all">
                    Create Room <ChevronRight size={16} />
                  </div>
                </button>

                {/* Receive Card */}
                <div className="glass p-6">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-700 flex items-center justify-center mb-4">
                    <Download size={22} className="text-white" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">Receive Files</h3>
                  <p className="text-sm text-gray-400 mb-3">
                    Enter the room code shared by the sender
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={joinRoomInput}
                      onChange={(e) => setJoinRoomInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
                      placeholder="Enter room code"
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 tracking-widest font-mono uppercase"
                      maxLength={6}
                      id="join-room-input"
                    />
                    <button
                      onClick={handleJoinRoom}
                      disabled={!joinRoomInput.trim()}
                      className="px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-xl text-sm font-medium transition-all disabled:opacity-30 disabled:hover:bg-green-600"
                      id="join-room-btn"
                    >
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Features */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto mt-8">
                {[
                  { icon: Shield, label: 'Encrypted', sub: 'WebRTC DTLS' },
                  { icon: Zap, label: 'Fast', sub: 'Direct P2P' },
                  { icon: Globe, label: 'Relay Fallback', sub: 'Works everywhere' },
                  { icon: ShieldCheck, label: 'Verified', sub: 'SHA-256 hashing' },
                ].map((feat, i) => (
                  <div key={i} className="glass text-center py-4 px-3">
                    <feat.icon size={20} className="text-brand-400 mx-auto mb-2" />
                    <p className="text-xs font-semibold text-white">{feat.label}</p>
                    <p className="text-[10px] text-gray-500">{feat.sub}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* WAITING STATE — Room Created, Waiting for Peer */}
          {/* ============================================================ */}
          {(appState === 'waiting' || appState === 'creating') && (
            <div className="animate-slide-up max-w-lg mx-auto mt-12">
              <div className="glass-strong p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-brand-500/20 flex items-center justify-center mx-auto mb-6 animate-float">
                  <Users size={28} className="text-brand-400" />
                </div>
                
                <h2 className="text-2xl font-bold text-white mb-2">Waiting for Peer</h2>
                <p className="text-sm text-gray-400 mb-6">Share this room code with the person you want to share files with</p>

                {/* Room Code Display */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
                  <p className="text-xs text-gray-500 uppercase tracking-wider font-medium mb-2">Room Code</p>
                  <p className="text-4xl font-bold tracking-[0.3em] font-mono text-white" id="room-code-display">
                    {roomId || '......'}
                  </p>
                </div>

                {/* Copy Link Button */}
                <button
                  onClick={handleCopyRoomId}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                    copied
                      ? 'bg-green-600 text-white'
                      : 'bg-brand-600 hover:bg-brand-500 text-white'
                  }`}
                  id="copy-link-btn"
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Link Copied!' : 'Copy Shareable Link'}
                </button>

                <div className="flex items-center gap-2 justify-center mt-4 text-gray-500 text-xs">
                  <Loader2 size={14} className="animate-spin" />
                  Waiting for someone to join...
                </div>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* CONNECTING STATE */}
          {/* ============================================================ */}
          {appState === 'connecting' && (
            <div className="animate-slide-up max-w-lg mx-auto mt-12">
              <div className="glass-strong p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-yellow-500/20 flex items-center justify-center mx-auto mb-6">
                  <Radio size={28} className="text-yellow-400 animate-pulse" />
                </div>
                
                <h2 className="text-2xl font-bold text-white mb-2">Establishing Connection</h2>
                <p className="text-sm text-gray-400 mb-6">{statusMessage || 'Setting up WebRTC peer connection...'}</p>

                {/* ICE Status */}
                <div className="bg-white/5 rounded-xl p-4 text-left space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">ICE Gathering</span>
                    <span className={`font-mono px-2 py-0.5 rounded-md ${
                      iceState.gathering === 'complete' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {iceState.gathering}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Connection</span>
                    <span className={`font-mono px-2 py-0.5 rounded-md ${
                      iceState.connection === 'connected' || iceState.connection === 'completed'
                        ? 'bg-green-500/20 text-green-400'
                        : iceState.connection === 'failed'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {iceState.connection}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Room</span>
                    <span className="font-mono text-brand-400">{roomId}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 justify-center mt-6 text-gray-500 text-xs">
                  <Loader2 size={14} className="animate-spin" />
                  {iceState.connection === 'checking' ? 'Testing network paths...' : 'Negotiating connection...'}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* CONNECTED STATE — Ready to Transfer (Sender view) */}
          {/* ============================================================ */}
          {appState === 'connected' && isSender && (
            <div className="animate-slide-up max-w-2xl mx-auto mt-8">
              <div className="glass-strong p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center">
                    <Wifi size={20} className="text-green-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Connected!</h2>
                    <p className="text-xs text-gray-400">{statusMessage}</p>
                  </div>
                </div>

                {/* Drop Zone */}
                <div
                  className={`drop-zone rounded-2xl p-8 text-center cursor-pointer transition-all ${
                    dragOver ? 'drag-over' : ''
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  id="file-drop-zone"
                >
                  <Upload size={36} className={`mx-auto mb-3 ${dragOver ? 'text-brand-400' : 'text-gray-500'}`} />
                  <p className="text-sm text-gray-300 font-medium">
                    {dragOver ? 'Drop files here!' : 'Drag & drop files or click to browse'}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Supports multiple files of any type</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    id="file-input"
                  />
                </div>

                {/* Selected Files List */}
                {selectedFiles.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs text-gray-400 font-medium">
                      {selectedFiles.length} file(s) selected · {formatFileSize(selectedFiles.reduce((sum, f) => sum + f.size, 0))} total
                    </p>
                    {selectedFiles.map((file, i) => (
                      <div key={i} className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3">
                        <span className="text-brand-400">
                          {getFileIconComponent(file.type)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{file.name}</p>
                          <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                        </div>
                        <button
                          onClick={() => removeFile(i)}
                          className="text-gray-500 hover:text-red-400 transition-colors"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={handleSendFiles}
                      className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-brand-600 to-purple-600 hover:from-brand-500 hover:to-purple-500 text-white rounded-xl text-sm font-semibold transition-all shadow-lg hover:shadow-brand-500/25"
                      id="send-files-btn"
                    >
                      <Send size={16} />
                      Send {selectedFiles.length} File{selectedFiles.length > 1 ? 's' : ''}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* CONNECTED STATE — Waiting for files (Receiver view) */}
          {/* ============================================================ */}
          {appState === 'connected' && !isSender && (
            <div className="animate-slide-up max-w-lg mx-auto mt-12">
              <div className="glass-strong p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-green-500/20 flex items-center justify-center mx-auto mb-6 animate-float">
                  <Download size={28} className="text-green-400" />
                </div>
                
                <h2 className="text-2xl font-bold text-white mb-2">Connected!</h2>
                <p className="text-sm text-gray-400 mb-4">{statusMessage}</p>
                
                <div className="bg-white/5 rounded-xl p-4 text-sm text-gray-300">
                  <Loader2 size={16} className="animate-spin inline mr-2" />
                  Waiting for sender to share files...
                </div>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* TRANSFERRING STATE — Progress View */}
          {/* ============================================================ */}
          {appState === 'transferring' && (
            <div className="animate-slide-up max-w-2xl mx-auto mt-8">
              <div className="glass-strong p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                    {isSender ? <Upload size={20} className="text-brand-400" /> : <Download size={20} className="text-brand-400" />}
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">
                      {isSender ? 'Sending Files' : 'Receiving Files'}
                    </h2>
                    <p className="text-xs text-gray-400">{statusMessage}</p>
                  </div>
                </div>

                {/* Current File Progress */}
                {progress && (
                  <div className="mb-6">
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-white font-medium truncate flex-1 mr-4">{progress.fileName}</span>
                      <span className="text-brand-400 font-mono text-xs flex-shrink-0">
                        {progress.progress.toFixed(1)}%
                      </span>
                    </div>
                    
                    {/* Progress Bar */}
                    <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden mb-3">
                      <div
                        className="h-full progress-bar rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(progress.progress, 100)}%` }}
                      />
                    </div>

                    {/* Stats Row */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-white/5 rounded-lg p-3 text-center">
                        <p className="text-xs text-gray-500 mb-0.5">Speed</p>
                        <p className="text-sm font-semibold text-white">
                          {progress.speed ? formatSpeed(progress.speed) : '—'}
                        </p>
                      </div>
                      <div className="bg-white/5 rounded-lg p-3 text-center">
                        <p className="text-xs text-gray-500 mb-0.5">Transferred</p>
                        <p className="text-sm font-semibold text-white">
                          {formatFileSize(progress.bytesSent)} / {formatFileSize(progress.totalBytes)}
                        </p>
                      </div>
                      <div className="bg-white/5 rounded-lg p-3 text-center">
                        <p className="text-xs text-gray-500 mb-0.5">Chunks</p>
                        <p className="text-sm font-semibold text-white">
                          {progress.chunkIndex + 1} / {progress.totalChunks}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* File List / Completed Files */}
                {(fileList.length > 0 || completedFiles.length > 0) && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400 font-medium mb-2">Files</p>
                    {(fileList.length > 0 ? fileList : completedFiles).map((file, i) => {
                      const completed = completedFiles.find(f => f.fileIndex === (file.fileIndex ?? file.index ?? i));
                      return (
                        <div key={i} className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3">
                          <span className={completed?.verified ? 'text-green-400' : completed ? 'text-yellow-400' : 'text-brand-400'}>
                            {completed ? (completed.verified ? <ShieldCheck size={20} /> : <ShieldX size={20} />) : getFileIconComponent(file.type || file.mimeType)}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{file.name}</p>
                            <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                          </div>
                          {completed && (
                            <span className={`text-xs px-2 py-0.5 rounded-md ${
                              completed.verified
                                ? 'bg-green-500/20 text-green-400'
                                : 'bg-yellow-500/20 text-yellow-400'
                            }`}>
                              {completed.verified ? 'Verified ✓' : 'Unverified'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* COMPLETE STATE */}
          {/* ============================================================ */}
          {appState === 'complete' && (
            <div className="animate-slide-up max-w-lg mx-auto mt-12">
              <div className="glass-strong p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-6 glow-green">
                  <ShieldCheck size={36} className="text-green-400" />
                </div>
                
                <h2 className="text-2xl font-bold text-white mb-2">Transfer Complete! 🎉</h2>
                <p className="text-sm text-gray-400 mb-6">{statusMessage}</p>

                {/* Completed Files Summary */}
                <div className="space-y-2 mb-6 text-left">
                  {completedFiles.map((file, i) => (
                    <div key={i} className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-3">
                      <span className={file.verified ? 'text-green-400' : 'text-yellow-400'}>
                        {file.verified ? <ShieldCheck size={20} /> : <ShieldX size={20} />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{file.name || file.fileName}</p>
                        <p className="text-xs text-gray-500">
                          {formatFileSize(file.size)} · Hash: {(file.hash || file.receivedHash || '').substring(0, 16)}...
                        </p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-md ${
                        file.verified
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {file.verified ? 'SHA-256 ✓' : 'Mismatch ✗'}
                      </span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleReset}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-medium transition-all"
                  id="new-transfer-btn"
                >
                  <RefreshCw size={16} />
                  Start New Transfer
                </button>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* ERROR MESSAGE */}
          {/* ============================================================ */}
          {errorMessage && (
            <div className="max-w-lg mx-auto mt-4 animate-slide-up">
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
                <WifiOff size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-red-300">{errorMessage}</p>
                </div>
                <button onClick={() => setErrorMessage('')} className="text-red-400 hover:text-red-300 ml-auto">
                  <X size={16} />
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Chat Panel — only visible when connected */}
      {['connected', 'transferring', 'complete'].includes(appState) && (
        <ChatPanel
          messages={chatMessages}
          onSendMessage={handleSendChat}
          peerConnected={['connected', 'transferring', 'complete'].includes(appState)}
        />
      )}

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 z-10 py-3 px-4 bg-gradient-to-t from-[#0a0a1a] to-transparent">
        <div className="max-w-4xl mx-auto flex items-center justify-center gap-4 text-[10px] text-gray-600">
          <span>Built with WebRTC + Socket.io</span>
          <span>·</span>
          <span>Files never leave your device</span>
        </div>
      </footer>
    </div>
  );
}
