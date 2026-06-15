// ============================================================================
// PeerDrop — Main Application Component (Fixed)
// ============================================================================
//
// KEY BUG FIX: Stale Closures
// ============================================================================
// The original code had a critical bug: socket event handlers (like peer-joined)
// were created inside useCallback with empty deps []. This means they captured
// the INITIAL values of state variables (isSender=false, roomId='').
//
// When peer-joined fired, `isSender` was always false and `roomId` was always ''.
// So the offer was never created → ICE gathering never started → stuck on "new".
//
// FIX: Use useRef to store values that socket handlers need to read.
// Refs always give you the CURRENT value, unlike closures over state.
//
// LESSON: In React, when you write a function that reads state but is created
// only once (empty deps array), it will always see the state values from when
// it was created — this is a stale closure. Solution: use refs.
// ============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, Download, Copy, Check, Wifi, WifiOff,
  Shield, ShieldCheck, ShieldX, ArrowRight, FileIcon,
  Image, Video, Music, FileText, Archive, FileCode,
  Zap, Globe, ChevronRight, RefreshCw, X, Users, Radio,
  Send, Loader2, Hash, Activity
} from 'lucide-react';
import { connectSocket, resetSocket } from './lib/socket';
import { generateEncryptionKey, exportKey, importKey } from './lib/crypto';
import { PeerConnection } from './lib/webrtc';
import { formatFileSize, formatSpeed, getFileIcon } from './lib/fileUtils';
import ChatPanel from './components/ChatPanel';
import PixelBlast from './components/PixelBlast';
import PixelCard from './components/PixelCard';

// ============================================================================
// File Icon Mapper
// ============================================================================
const FILE_ICONS = {
  File: FileIcon,
  Image,
  Video,
  Music,
  FileText,
  Archive,
  FileCode,
};

// ============================================================================
// Main App Component
// ============================================================================
export default function App() {
  // --------------------------------------------------------------------------
  // State (for rendering the UI)
  // --------------------------------------------------------------------------
  const [appState, setAppState] = useState('idle');
  const [roomId, setRoomId] = useState('');
  const [joinRoomInput, setJoinRoomInput] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [isSender, setIsSender] = useState(false);

  // Connection
  const [isRelay, setIsRelay] = useState(false);
  const [iceState, setIceState] = useState({ gathering: 'new', connection: 'new' });

  // Files
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [fileList, setFileList] = useState([]);

  // Transfer
  const [progress, setProgress] = useState(null);
  const [completedFiles, setCompletedFiles] = useState([]);
  const [allComplete, setAllComplete] = useState(false);

  // Chat
  const [chatMessages, setChatMessages] = useState([]);

  // Mesh / peers
  const [peerCount, setPeerCount] = useState(0);

  // --------------------------------------------------------------------------
  // Refs (for values that socket handlers need to READ — avoids stale closures)
  // --------------------------------------------------------------------------
  const peerConnectionRef = useRef(null);
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);
  const encryptionKeyRef = useRef(null);

  // These refs mirror the state values so socket handlers always get fresh values
  const isSenderRef = useRef(false);
  const roomIdRef = useRef('');
  const allCompleteRef = useRef(false);
  const appStateRef = useRef('idle');

  // Keep refs in sync with state
  useEffect(() => { isSenderRef.current = isSender; }, [isSender]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { allCompleteRef.current = allComplete; }, [allComplete]);
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  // --------------------------------------------------------------------------
  // Parse URL for room code — AUTO-JOIN if link is pasted
  // --------------------------------------------------------------------------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get('room');
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const urlKey = hashParams.get('key');

    if (!urlRoom) return;

    const code = urlRoom.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code.length < 4) return;

    setJoinRoomInput(code); // Pre-fill input as visual feedback

    // Auto-join: import key if present, then join directly
    const autoJoin = async () => {
      if (urlKey) {
        try {
          encryptionKeyRef.current = await importKey(urlKey);
        } catch (e) {
          console.error('[AutoJoin] Failed to import key:', e);
          // Continue anyway — transfer will be unencrypted
        }
      }

      // Trigger join directly (bypasses joinRoomInput state read)
      isSenderRef.current = false;
      roomIdRef.current = code;
      setIsSender(false);
      setRoomId(code);
      setErrorMessage('');
      setAppState('joining');
      setStatusMessage(`Joining room ${code}...`);

      // setupSocket and getOrCreatePeerConnection are stable (useCallback with [] deps)
      // so it is safe to call them from a mount-time effect.
      setupSocket((socket) => {
        console.log('[AutoJoin] Socket ready — emitting join-room:', code);
        getOrCreatePeerConnection(socket, code, false);
        socket.emit('join-room', { roomId: code });
      });
    };

    autoJoin();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount — setupSocket & getOrCreatePeerConnection are stable

  // --------------------------------------------------------------------------
  // Cleanup on unmount
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      peerConnectionRef.current?.destroy();
      resetSocket();
    };
  }, []);

  const getOrCreatePeerConnection = useCallback((socket, currentRoomId, asSender) => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const pc = new PeerConnection(socket, currentRoomId, asSender, {
      encryptionKey: encryptionKeyRef.current,
      onStatus: (msg) => setStatusMessage(msg),
      onError: (msg) => setErrorMessage(msg),

      onConnected: ({ relay }) => {
        setIsRelay(relay);
        // Only move to 'connected' if we're still in a handshake state.
        // Never override 'transferring' or 'complete' — a new peer joining
        // mid-transfer completes ICE but the overall session stays active.
        const state = appStateRef.current;
        if (state === 'connecting' || state === 'joining') {
          setAppState('connected');
          setStatusMessage(
            relay
              ? '⚡ Connected via server relay (P2P blocked by firewall)'
              : '🎉 Direct P2P connection established!'
          );
        }
      },

      onIceState: (state) => setIceState(state),

      onRelayActivated: () => {
        setIsRelay(true);
        setStatusMessage('Switched to server relay — P2P was blocked by firewall');
      },

      onDataChannelOpen: () => {
        // Only switch to 'connected' if we're not already transferring
        if (appStateRef.current !== 'transferring' && appStateRef.current !== 'complete') {
          setAppState('connected');
          setStatusMessage('Data channel open — ready to transfer files!');
        }
        // If we're already transferring (new peer joined mid-transfer),
        // the swarm handles re-sending the file list on DC open automatically.
      },

      onFileList: (files) => {
        setFileList(prev => {
          // Avoid duplicates if file-list is received again (e.g. peer rejoin)
          const existing = new Set(prev.map(f => f.fileIndex));
          const newFiles = files.filter(f => !existing.has(f.fileIndex));
          return [...prev, ...newFiles];
        });
        setAppState('transferring');
        setStatusMessage('Receiving files...');
      },

      onTransferStart: (files) => {
        setFileList(files);
        setAppState('transferring');
        setStatusMessage(`Sending ${files.length} file${files.length > 1 ? 's' : ''} to ${peerCount} peer${peerCount > 1 ? 's' : ''}...`);
      },

      onPeerCountChange: (count) => {
        setPeerCount(count);
      },

      onResumed: ({ fileIndex, chunksHave, totalChunks }) => {
        setStatusMessage(`↺ Auto-resuming from ${Math.round(chunksHave/totalChunks*100)}%...`);
      },

      onFileStart: (meta) => {
        setStatusMessage(`Receiving: ${meta.name}...`);
      },

      onProgress: (p) => setProgress(p),

      onHashVerification: (result) => {
        setCompletedFiles(prev => {
          const arr = [...prev];
          const idx = arr.findIndex(f => f.fileIndex === result.fileIndex);
          if (idx >= 0) arr[idx] = { ...arr[idx], ...result };
          else arr.push(result);
          return arr;
        });
      },

      onFileComplete: (file) => {
        setCompletedFiles(prev => {
          const arr = [...prev];
          const idx = arr.findIndex(f => f.fileIndex === file.fileIndex);
          if (idx >= 0) arr[idx] = { ...arr[idx], ...file };
          else arr.push(file);
          return arr;
        });
        setStatusMessage(
          `File received: ${file.name} ${file.verified ? '(SHA-256 verified ✅)' : '(hash mismatch ⚠️)'}`
        );
      },

      onAllFilesComplete: () => {
        setAllComplete(true);
        setAppState('complete');
        setStatusMessage('All files transferred successfully! 🎉');
      },

      onChatMessage: (msg) => {
        setChatMessages(prev => [...prev, msg]);
      },

      onPeerLeft: ({ peerId, remainingPeers }) => {
        // Don't do anything if the transfer is done
        if (allCompleteRef.current) return;
        // If there are still other peers connected, just show a toast
        if (remainingPeers > 0) {
          setErrorMessage('A peer has left the room. Transfer continues with remaining peers.');
          return;
        }
        // All peers gone
        const state = appStateRef.current;
        setErrorMessage('Your peer has left the room.');
        // Don’t reset from transferring — the user may want to wait for a reconnect
        if (state !== 'transferring' && state !== 'complete') {
          setAppState('waiting');
        }
      },
    });

    peerConnectionRef.current = pc;

    // If we are the sender (created the room), start the WebRTC handshake
    if (asSender) {
      console.log('[App] Sender creating WebRTC offer...');
      pc.createOffer();
    }

    return pc;
  }, []);

  // ==========================================================================
  // setupSocket — connects to the signaling server and registers handlers
  // ==========================================================================
  // IMPORTANT: Socket handlers use refs (not state) to read current values.
  // This prevents the stale closure bug.
  const setupSocket = useCallback((onReady) => {
    // Avoid re-registering if already connected
    if (socketRef.current && socketRef.current.connected) {
      onReady?.(socketRef.current);
      return socketRef.current;
    }

    const socket = connectSocket();
    socketRef.current = socket;

    // Remove any previously registered handlers to avoid duplicates
    socket.off('room-created');
    socket.off('room-joined');
    socket.off('peer-joined');
    socket.off('peer-disconnected');
    socket.off('error-message');
    socket.off('chat-message');

    // ---- SENDER: Server confirms room was created ----
    socket.on('room-created', ({ roomId: id }) => {
      console.log('[Socket] Room created:', id);
      roomIdRef.current = id;   // Update ref immediately — don't wait for state
      if (peerConnectionRef.current) {
        peerConnectionRef.current.roomId = id;
      }
      setRoomId(id);
      setAppState('waiting');
      setStatusMessage('Room created! Share the code or link with your peer.');
    });

    // ---- RECEIVER: Server confirms we joined the room ----
    socket.on('room-joined', ({ roomId: id }) => {
      console.log('[Socket] Room joined:', id);
      roomIdRef.current = id;
      if (peerConnectionRef.current) {
        peerConnectionRef.current.roomId = id;
      }
      setRoomId(id);
      setAppState('connecting');
      setStatusMessage('Joined room! Waiting for sender...');
    });

    // ---- SENDER: A peer joined the room ----
    // Only change state if we're in a waiting/idle phase.
    // If we're already transferring (a peer reconnected mid-transfer),
    // keep the current state — the swarm will handle re-syncing.
    socket.on('peer-joined', ({ peerId }) => {
      console.log('[Socket] Peer joined:', peerId);
      const state = appStateRef.current;
      if (state === 'waiting' || state === 'idle') {
        setAppState('connecting');
        setStatusMessage('Peer joined! Establishing connection...');
      } else if (state === 'transferring') {
        setStatusMessage('A new peer joined — syncing transfer state...');
      }
    });

    // ---- Both peers: the other peer left ----
    socket.on('peer-disconnected', ({ peerId }) => {
      // Defer by one tick so the swarm's own peer-disconnected handler runs FIRST
      // and removes the peer from its map. Then getPeerCount() returns the
      // correct post-disconnect count.
      setTimeout(() => {
        if (allCompleteRef.current) return;
        const remainingPeers = peerConnectionRef.current?.getPeerCount() ?? 0;
        const state = appStateRef.current;

        if (remainingPeers > 0) {
          // Still connected to other peers — swarm's onPeerLeft already showed a toast.
          // Don't change the app state at all.
          return;
        }

        // All peers gone
        if (state === 'transferring') {
          setErrorMessage('Your peer has left. Transfer paused — they can rejoin to resume.');
        } else if (state !== 'complete' && state !== 'waiting') {
          setErrorMessage('Your peer has left the room.');
          setAppState('waiting');
        }
      }, 0); // setTimeout(0) defers to after current event queue is flushed
    });

    // ---- Socket reconnected — do NOT re-emit create-room/join-room ----
    // The server lost our room on reconnect. We show an error and let the user decide.
    socket.on('reconnect', () => {
      console.log('[Socket] Reconnected to server. Previous room is gone.');
      if (appStateRef.current !== 'idle' && appStateRef.current !== 'complete') {
        setErrorMessage('Lost connection to server and reconnected. Your room session ended. Please start a new transfer.');
      }
    });

    // ---- Server validation errors ----
    socket.on('error-message', ({ message }) => {
      setErrorMessage(message);
      setAppState('idle');
    });

    // ---- Chat fallback through server (when DataChannel isn't open yet) ----
    socket.on('chat-message', ({ message, timestamp }) => {
      setChatMessages(prev => [...prev, { message, from: 'peer', timestamp }]);
    });

    socket.on('room-expired', () => {
      setErrorMessage('This room has expired (1 hour time limit). Please create a new room.');
      handleReset();
    });

    // Connect and fire callback when ready
    if (socket.connected) {
      onReady?.(socket);
    } else {
      socket.once('connect', () => {
        console.log('[Socket] Connected to signaling server');
        onReady?.(socket);
      });
    }

    return socket;
  }, [getOrCreatePeerConnection]);

  // ==========================================================================
  // User Actions
  // ==========================================================================

  const handleCreateRoom = async () => {
    // Set sender ref immediately (before async state update)
    isSenderRef.current = true;
    setIsSender(true);
    setErrorMessage('');
    setAppState('creating');

    try {
      const key = await generateEncryptionKey();
      encryptionKeyRef.current = key;
      const exported = await exportKey(key);
      window.location.hash = `key=${exported}`;
    } catch (err) {
      setErrorMessage(`Failed to generate encryption key: ${err.message}`);
      return;
    }

    setupSocket((socket) => {
      console.log('[App] Socket ready — emitting create-room');
      getOrCreatePeerConnection(socket, '', true); // Instantiate the Swarm Manager
      socket.emit('create-room');
    });
  };

  const handleJoinRoom = async () => {
    // Extract room and key if a full URL was pasted
    let code = joinRoomInput.trim();
    let pastedKey = null;
    try {
      const url = new URL(code);
      code = url.searchParams.get('room') || '';
      pastedKey = new URLSearchParams(url.hash.slice(1)).get('key');
    } catch {
      // Not a full URL, that's fine
    }
    
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!code || code.length < 4) {
      setErrorMessage('Please enter a valid room code or paste the full link');
      return;
    }
    
    // Process key if pasted from URL
    if (pastedKey) {
      try {
        encryptionKeyRef.current = await importKey(pastedKey);
      } catch (e) {
        console.error('Failed to import pasted key', e);
        setErrorMessage('Could not read encryption key from link. File transfer will be unencrypted.');
      }
    }
    // NOTE: encryptionKeyRef.current may be null if user typed the code manually.
    // That is allowed — the transfer will proceed without encryption.
    // The sender sets the key in the URL hash, receiver only gets it via the link.

    // Set receiver refs immediately
    isSenderRef.current = false;
    roomIdRef.current = code;
    setIsSender(false);
    setRoomId(code);
    setErrorMessage('');
    setAppState('joining');

    setupSocket((socket) => {
      console.log('[App] Socket ready — emitting join-room:', code);
      getOrCreatePeerConnection(socket, code, false); // Instantiate the Swarm Manager
      socket.emit('join-room', { roomId: code });
    });
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) setSelectedFiles(prev => [...prev, ...files]);
    // Reset the input so the same file can be re-added
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) setSelectedFiles(prev => [...prev, ...files]);
  };

  const removeFile = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSendFiles = async () => {
    if (selectedFiles.length === 0 || !peerConnectionRef.current) return;
    setAppState('transferring');
    setStatusMessage('Starting transfer...');
    try {
      await peerConnectionRef.current.sendFiles(selectedFiles);
    } catch (err) {
      setErrorMessage(`Transfer error: ${err.message}`);
      setAppState('connected');
    }
  };

  const handleSendChat = (message) => {
    if (!peerConnectionRef.current) return;
    const msg = peerConnectionRef.current.sendChatMessage(message);
    setChatMessages(prev => [...prev, { ...msg, from: 'me' }]);
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomId}${window.location.hash}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const handleReset = () => {
    peerConnectionRef.current?.destroy();
    peerConnectionRef.current = null;
    resetSocket();          // Fully destroy socket so next session starts fresh
    socketRef.current = null;
    isSenderRef.current = false;
    roomIdRef.current = '';
    allCompleteRef.current = false;

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
    setPeerCount(0);
    window.history.replaceState({}, '', window.location.pathname);
  };

  // ==========================================================================
  // UI Helpers
  // ==========================================================================

  const getFileIconComponent = (mimeType) => {
    const name = getFileIcon(mimeType);
    const Icon = FILE_ICONS[name] || FileIcon;
    return <Icon size={20} />;
  };

  const isConnected = ['connected', 'transferring', 'complete'].includes(appState);

  // ICE connection state color
  const iceColor = (val) => {
    if (val === 'connected' || val === 'completed' || val === 'complete') return 'bg-green-500/20 text-green-400';
    if (val === 'failed' || val === 'disconnected') return 'bg-red-500/20 text-red-400';
    if (val === 'checking') return 'bg-blue-500/20 text-blue-400';
    return 'bg-yellow-500/20 text-yellow-400';
  };

  // ==========================================================================
  // Render
  // ==========================================================================
  return (
    <div className="min-h-screen relative">
      {/* Animated Mesh Background */}
      <div className="fixed inset-0 z-0 pointer-events-none mix-blend-screen opacity-70">
        <PixelBlast
          variant="circle"
          pixelSize={6}
          color="#B497CF"
          patternScale={3}
          patternDensity={1.2}
          pixelSizeJitter={0.5}
          enableRipples={false}
          liquid
          liquidStrength={0.12}
          liquidRadius={1.2}
          liquidWobbleSpeed={5}
          speed={0.6}
          edgeFade={0.25}
          transparent
        />
      </div>
      <div className="bg-mesh" />

      {/* ====================================================================
          HEADER
      ==================================================================== */}
      <header className="relative z-10 py-5 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center overflow-hidden">
              <img src="/logo.png" alt="SneezIT Logo" className="w-full h-full object-contain" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent leading-none tracking-tight">
                SneezIT
              </h1>
              <p className="text-[10px] text-gray-400 tracking-widest uppercase mt-0.5">FILES "ACHOO" ACROSS BROWSERS</p>
            </div>
          </div>

          {/* Right side badges */}
          <div className="flex items-center gap-3">

            {/* Active peer count badge (shown when connected) */}
            {isConnected && peerCount > 0 && (
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-300 border border-purple-500/20">
                <Users size={12} />
                {peerCount} peer{peerCount !== 1 ? 's' : ''}
              </div>
            )}

            {/* Connection badge */}
            {appState !== 'idle' && appState !== 'creating' && (
              <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${
                isConnected
                  ? isRelay
                    ? 'bg-yellow-500/10 text-yellow-300 border-yellow-500/20'
                    : 'bg-green-500/10 text-green-300 border-green-500/20'
                  : 'bg-white/5 text-gray-400 border-white/10'
              }`}>
                {isConnected
                  ? (isRelay ? <Globe size={12} /> : <Wifi size={12} />)
                  : <Radio size={12} className="animate-pulse" />}
                {isConnected
                  ? (isRelay ? 'Server Relay' : 'P2P Direct')
                  : 'Connecting...'}
                {isConnected && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
              </div>
            )}

            {/* Reset button */}
            {appState !== 'idle' && (
              <button
                onClick={handleReset}
                className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-all"
                title="New session"
                id="reset-btn"
              >
                <RefreshCw size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ====================================================================
          MAIN CONTENT
      ==================================================================== */}
      <main className="relative z-10 px-4 pb-28">
        <div className="max-w-4xl mx-auto">

          {/* ================================================================
              IDLE — Landing Page
          ================================================================ */}
          {appState === 'idle' && (
            <div className="animate-slide-up">
              {/* Hero */}
              <div className="text-center mb-10 mt-6">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-300 text-xs font-medium mb-5">
                  <Shield size={13} />
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
                  No uploads. No cloud. No file size limits imposed by servers. Files transfer
                  directly peer-to-peer using WebRTC — they never touch our servers.
                </p>
              </div>

              {/* Cards */}
              <div className="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                {/* SEND */}
                <PixelCard variant="blue" className="rounded-2xl">
                  <button
                    onClick={handleCreateRoom}
                    id="create-room-btn"
                    className="group hover:bg-white/[0.07] transition-all duration-300 p-7 text-left cursor-pointer w-full h-full flex flex-col items-start"
                  >
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg">
                      <Upload size={22} className="text-white" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-1">Send Files</h3>
                    <p className="text-sm text-gray-400 mb-4">
                      Create a secure room and share the code with your recipient
                    </p>
                    <div className="flex items-center gap-1 text-brand-400 text-sm font-semibold group-hover:gap-2 transition-all mt-auto">
                      Create Room <ChevronRight size={16} />
                    </div>
                  </button>
                </PixelCard>

                {/* RECEIVE */}
                <PixelCard variant="blue" className="rounded-2xl">
                  <div className="p-7 h-full flex flex-col">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-700 flex items-center justify-center mb-4 shadow-lg">
                      <Download size={22} className="text-white" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-1">Receive Files</h3>
                    <p className="text-sm text-gray-400 mb-3">
                      Enter the 6-character room code from the sender
                    </p>
                    <div className="flex gap-2 mt-auto">
                      <input
                        type="text"
                        value={joinRoomInput}
                        onChange={(e) => setJoinRoomInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                        onKeyDown={(e) => e.key === 'Enter' && handleJoinRoom()}
                        placeholder="e.g. AB3X7K"
                        maxLength={6}
                        id="join-room-input"
                        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 tracking-[0.2em] font-mono uppercase"
                      />
                      <button
                        onClick={handleJoinRoom}
                        disabled={joinRoomInput.trim().length < 4}
                        id="join-room-btn"
                        className="px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-xl text-sm font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowRight size={18} />
                      </button>
                    </div>
                  </div>
                </PixelCard>
              </div>

              {/* Feature Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto mt-6">
                {[
                  { icon: ShieldCheck, label: 'SHA-256 Verified', sub: 'Every file hashed', color: 'text-brand-400' },
                  { icon: Zap,         label: 'Direct P2P',       sub: 'No middleman',    color: 'text-yellow-400' },
                  { icon: Globe,       label: 'Relay Fallback',   sub: 'Works on all nets', color: 'text-blue-400' },
                  { icon: Activity,    label: 'Live Stats',       sub: 'Speed & progress', color: 'text-green-400' },
                ].map((f, i) => (
                  <PixelCard key={i} variant="default" className="rounded-xl">
                    <div className="py-4 px-3 text-center h-full flex flex-col items-center justify-center">
                      <f.icon size={20} className={`${f.color} mb-2`} />
                      <p className="text-xs font-semibold text-white">{f.label}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{f.sub}</p>
                    </div>
                  </PixelCard>
                ))}
              </div>
            </div>
          )}

          {/* ================================================================
              CREATING / WAITING — Share Room Code
          ================================================================ */}
          {(appState === 'creating' || appState === 'waiting') && (
            <div className="animate-slide-up max-w-md mx-auto mt-10">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 text-center h-full flex flex-col">
                <div className="w-16 h-16 rounded-2xl bg-brand-500/15 flex items-center justify-center mx-auto mb-5 animate-float">
                  <Users size={28} className="text-brand-400" />
                </div>

                <h2 className="text-2xl font-bold text-white mb-1.5">Waiting for Peer</h2>
                <p className="text-sm text-gray-400 mb-6">
                  Share this code — the receiver enters it to join your room
                </p>

                {/* Room Code Display */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-5">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium mb-2">Room Code</p>
                  <p
                    id="room-code-display"
                    className="text-5xl font-black tracking-[0.35em] font-mono text-white"
                  >
                    {roomId || '······'}
                  </p>
                </div>

                {/* Copy Link */}
                <button
                  onClick={handleCopyLink}
                  disabled={!roomId}
                  id="copy-link-btn"
                  className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${
                    copied
                      ? 'bg-green-600 text-white'
                      : 'bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40'
                  }`}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Link Copied!' : 'Copy Shareable Link'}
                </button>

                <div className="flex items-center justify-center gap-2 mt-5 text-gray-600 text-xs">
                  <Loader2 size={13} className="animate-spin" />
                  Waiting for someone to join...
                </div>
                </div>
              </PixelCard>
            </div>
          )}

          {/* ================================================================
              JOINING / CONNECTING — ICE State Panel
          ================================================================ */}
          {(appState === 'joining' || appState === 'connecting') && (
            <div className="animate-slide-up max-w-md mx-auto mt-10">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 text-center h-full flex flex-col">
                <div className="w-16 h-16 rounded-2xl bg-yellow-500/15 flex items-center justify-center mx-auto mb-5">
                  <Radio size={28} className="text-yellow-400 animate-pulse" />
                </div>

                <h2 className="text-2xl font-bold text-white mb-1.5">Establishing Connection</h2>
                <p className="text-sm text-gray-400 mb-6">{statusMessage || 'Setting up WebRTC peer connection...'}</p>

                {/* ICE Debug Panel */}
                <div className="bg-white/5 border border-white/[0.06] rounded-xl p-4 text-left space-y-2.5 mb-4">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-medium mb-3">
                    Connection Diagnostics
                  </p>
                  {[
                    { label: 'ICE Gathering', val: iceState.gathering },
                    { label: 'ICE Connection', val: iceState.connection },
                    { label: 'Room', val: roomId || '—' },
                    { label: 'Mode', val: isSender ? 'Sender (Offer)' : 'Receiver (Answer)' },
                  ].map(({ label, val }) => (
                    <div key={label} className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">{label}</span>
                      <span className={`font-mono px-2 py-0.5 rounded-md text-[11px] ${iceColor(val)}`}>
                        {val}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Tip */}
                <p className="text-[11px] text-gray-600">
                  If stuck here, the app will automatically fall back to server relay after 15 seconds.
                </p>

                <div className="flex items-center justify-center gap-2 mt-4 text-gray-600 text-xs">
                  <Loader2 size={13} className="animate-spin" />
                  {iceState.connection === 'checking' ? 'Testing network paths...' : 'Negotiating...'}
                </div>
                </div>
              </PixelCard>
            </div>
          )}

          {/* ================================================================
              CONNECTED — Sender: File Picker
          ================================================================ */}
          {appState === 'connected' && isSender && (
            <div className="animate-slide-up max-w-2xl mx-auto mt-8">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 h-full flex flex-col">
                {/* Header */}
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center">
                    <Wifi size={20} className="text-green-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white leading-none">Connected!</h2>
                    <p className="text-xs text-gray-400 mt-0.5">{statusMessage}</p>
                  </div>
                  <div className={`ml-auto flex items-center gap-1.5 text-xs px-3 py-1 rounded-full ${
                    isRelay ? 'bg-yellow-500/10 text-yellow-400' : 'bg-green-500/10 text-green-400'
                  }`}>
                    {isRelay ? <Globe size={12} /> : <Zap size={12} />}
                    {isRelay ? 'via Relay' : 'P2P Direct'}
                  </div>
                </div>

                {/* Drop Zone */}
                <div
                  className={`drop-zone rounded-2xl p-10 text-center cursor-pointer select-none ${dragOver ? 'drag-over' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  id="file-drop-zone"
                >
                  <Upload size={40} className={`mx-auto mb-3 transition-colors ${dragOver ? 'text-brand-400' : 'text-gray-600'}`} />
                  <p className="text-sm font-semibold text-gray-300">
                    {dragOver ? 'Release to add files' : 'Drag & drop files here'}
                  </p>
                  <p className="text-xs text-gray-600 mt-1">or click to browse · any type · any size</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    id="file-input"
                  />
                </div>

                {/* File Queue */}
                {selectedFiles.length > 0 && (
                  <div className="mt-5 space-y-2">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                      <span>{selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected</span>
                      <span>{formatFileSize(selectedFiles.reduce((s, f) => s + f.size, 0))} total</span>
                    </div>

                    {selectedFiles.map((file, i) => (
                      <div key={i} className="flex items-center gap-3 bg-white/[0.04] rounded-xl px-4 py-3">
                        <span className="text-brand-400 flex-shrink-0">{getFileIconComponent(file.type)}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate font-medium">{file.name}</p>
                          <p className="text-[11px] text-gray-500">{formatFileSize(file.size)} · {file.type || 'unknown type'}</p>
                        </div>
                        <button
                          onClick={() => removeFile(i)}
                          className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={handleSendFiles}
                      id="send-files-btn"
                      className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-brand-600 to-purple-600 hover:from-brand-500 hover:to-purple-500 text-white rounded-xl text-sm font-bold transition-all shadow-xl shadow-brand-500/20"
                    >
                      <Send size={16} />
                      Send {selectedFiles.length} File{selectedFiles.length > 1 ? 's' : ''} →
                    </button>
                  </div>
                )}
                </div>
              </PixelCard>
            </div>
          )}

          {/* ================================================================
              CONNECTED — Receiver: Waiting for files
          ================================================================ */}
          {appState === 'connected' && !isSender && (
            <div className="animate-slide-up max-w-md mx-auto mt-10">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 text-center h-full flex flex-col">
                <div className="w-16 h-16 rounded-2xl bg-green-500/15 flex items-center justify-center mx-auto mb-5 animate-float">
                  <Download size={28} className="text-green-400" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-1.5">Connected!</h2>
                <p className="text-sm text-gray-400 mb-5">{statusMessage}</p>

                <div className="bg-white/[0.04] rounded-xl p-4 text-sm text-gray-400 flex items-center justify-center gap-2">
                  <Loader2 size={15} className="animate-spin text-brand-400" />
                  Waiting for sender to share files...
                </div>

                <div className={`mt-4 inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full ${
                  isRelay ? 'bg-yellow-500/10 text-yellow-400' : 'bg-green-500/10 text-green-400'
                }`}>
                  {isRelay ? <Globe size={11} /> : <Zap size={11} />}
                  {isRelay ? 'Server Relay Mode' : 'P2P Direct Connection'}
                </div>
                </div>
              </PixelCard>
            </div>
          )}

          {/* ================================================================
              TRANSFERRING — Progress Dashboard
          ================================================================ */}
          {appState === 'transferring' && (
            <div className="animate-slide-up max-w-2xl mx-auto mt-8">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 h-full flex flex-col">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/15 flex items-center justify-center">
                    {isSender
                      ? <Upload size={20} className="text-brand-400" />
                      : <Download size={20} className="text-brand-400" />}
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white leading-none">
                      {isSender ? 'Sending Files' : 'Receiving Files'}
                    </h2>
                    <p className="text-xs text-gray-400 mt-0.5">{statusMessage}</p>
                  </div>
                </div>

                {/* Current Progress */}
                {progress && (
                  <div className="mb-6">
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-white font-semibold truncate mr-4">{progress.fileName}</span>
                      <span className="text-brand-400 font-mono text-xs flex-shrink-0 font-bold">
                        {Math.min(progress.progress, 100).toFixed(1)}%
                      </span>
                    </div>

                    {/* Animated Progress Bar */}
                    <div className="w-full h-2.5 bg-white/5 rounded-full overflow-hidden mb-4">
                      <div
                        className="h-full progress-bar rounded-full transition-all duration-200"
                        style={{ width: `${Math.min(progress.progress, 100)}%` }}
                      />
                    </div>

                    {/* Stats Grid */}
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Speed</p>
                        <p className="text-sm font-bold text-white font-mono">
                          {/* Show speed if available; '—' only at start before first measurement */}
                          {progress.speed > 0
                            ? formatSpeed(progress.speed)
                            : progress.bytesSent > 0 ? 'Measuring...' : '—'}
                        </p>
                      </div>
                      <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Transferred</p>
                        <p className="text-sm font-bold text-white font-mono">
                          {formatFileSize(progress.bytesSent)}
                        </p>
                        <p className="text-[10px] text-gray-600">of {formatFileSize(progress.totalBytes)}</p>
                      </div>
                      <div className="bg-white/[0.04] rounded-xl p-3 text-center">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Chunks</p>
                        <p className="text-sm font-bold text-white font-mono">
                          {progress.chunkIndex}<span className="text-gray-500 text-xs">/{progress.totalChunks}</span>
                        </p>
                      </div>
                      <div className="bg-purple-500/[0.08] border border-purple-500/10 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-purple-400 uppercase tracking-wider mb-1">
                          {progress.isSender ? 'Seeders' : 'Peers'}
                        </p>
                        <p className="text-sm font-bold text-purple-300">
                          {progress.activePeers ?? peerCount}
                        </p>
                      </div>
                    </div>

                  </div>
                )}

                {/* File List */}
                {fileList.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Files</p>
                    {fileList.map((file, i) => {
                      const done = completedFiles.find(f => f.fileIndex === (file.fileIndex ?? file.index ?? i));
                      const isCurrent = progress?.fileName === file.name && !done;
                      return (
                        <div key={i} className={`flex items-center gap-3 rounded-xl px-4 py-3 transition-all ${
                          isCurrent ? 'bg-brand-500/10 border border-brand-500/20' : 'bg-white/[0.04]'
                        }`}>
                          <span className={done ? (done.verified ? 'text-green-400' : 'text-red-400') : isCurrent ? 'text-brand-400' : 'text-gray-500'}>
                            {done
                              ? (done.verified ? <ShieldCheck size={18} /> : <ShieldX size={18} />)
                              : isCurrent ? <Loader2 size={18} className="animate-spin" /> : getFileIconComponent(file.type || file.mimeType)}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate font-medium">{file.name}</p>
                            <p className="text-[11px] text-gray-500">{formatFileSize(file.size)}</p>
                          </div>
                          {done && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-lg font-semibold ${
                              done.verified ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
                            }`}>
                              {done.verified ? 'SHA-256 ✓' : 'Hash ✗'}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="text-[10px] text-brand-400 font-semibold">Transferring...</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                </div>
              </PixelCard>
            </div>
          )}

          {/* ================================================================
              COMPLETE — Summary
          ================================================================ */}
          {appState === 'complete' && (
            <div className="animate-slide-up max-w-md mx-auto mt-10">
              <PixelCard variant="blue" className="rounded-2xl">
                <div className="p-8 text-center h-full flex flex-col">
                <div className="w-20 h-20 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-5 glow-green">
                  <ShieldCheck size={38} className="text-green-400" />
                </div>

                <h2 className="text-2xl font-bold text-white mb-1.5">Transfer Complete! 🎉</h2>
                <p className="text-sm text-gray-400 mb-6">{statusMessage}</p>

                <div className="space-y-3 text-left mb-6">
                  {completedFiles.map((file, i) => (
                    <div key={i} className="bg-white/[0.04] rounded-xl px-4 py-3">
                      <div className="flex items-center gap-3 mb-2">
                        <span className={file.verified ? 'text-green-400' : 'text-red-400'}>
                          {file.verified ? <ShieldCheck size={18} /> : <ShieldX size={18} />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium truncate">{file.name}</p>
                          <p className="text-[11px] text-gray-500 font-mono">
                            {file.checksum
                              ? `SHA-256: ${file.checksum.substring(0, 20)}...`
                              : 'AES-GCM Authenticated'}
                          </p>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded-lg font-bold flex-shrink-0 ${
                          file.verified ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
                        }`}>
                          {file.verified ? 'VERIFIED' : 'MISMATCH'}
                        </span>
                      </div>

                      {/* Download button (only shows for receiver — sender has no URL) */}
                      {file.url && (
                        <a
                          href={file.url}
                          download={file.name}
                          className="mt-1 flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-green-600/20 hover:bg-green-600/30 text-green-400 text-xs font-semibold transition-all border border-green-500/20 hover:border-green-500/40"
                        >
                          <Download size={13} />
                          Download {file.name}
                        </a>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleReset}
                  id="new-transfer-btn"
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-sm font-semibold transition-all"
                >
                  <RefreshCw size={15} />
                  Start New Transfer
                </button>
                </div>
              </PixelCard>
            </div>
          )}


          {/* ================================================================
              ERROR MESSAGE (persistent toast)
          ================================================================ */}
          {errorMessage && (
            <div className="max-w-lg mx-auto mt-4 animate-slide-up">
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
                <WifiOff size={17} className="text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-300 flex-1">{errorMessage}</p>
                <button onClick={() => setErrorMessage('')} className="text-red-500 hover:text-red-300 transition-colors">
                  <X size={15} />
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* ====================================================================
          CHAT PANEL (floating, only when connected)
      ==================================================================== */}
      {isConnected && (
        <ChatPanel
          messages={chatMessages}
          onSendMessage={handleSendChat}
          peerConnected={isConnected}
        />
      )}

      {/* ====================================================================
          FOOTER
      ==================================================================== */}
      <footer className="fixed bottom-0 left-0 right-0 z-10 py-3 px-4 pointer-events-none">
        <p className="text-center text-[10px] text-gray-700">
           · Built with WebRTC + Socket.io ·
        </p>
      </footer>
    </div>
  );
}
