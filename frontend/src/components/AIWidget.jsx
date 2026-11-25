import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { getApiUrl } from '../api/client';
import { NovaLogo } from './brand/NovaLogo';
import {
  Send,
  X,
  Square,
  RotateCcw,
  Copy,
  Check,
  PanelLeft,
  SquarePen,
  Trash2,
  BookOpen,
  Pencil,
  Star,
  Search,
  ThumbsUp,
  ThumbsDown,
  ArrowDown,
  Info,
  ShieldAlert,
  ExternalLink,
  Sun,
  Moon,
  Minus
} from 'lucide-react';

const APP_NAME = 'Nova';
const CONVERSATIONS_STORAGE_KEY = 'nova_clinical_conversations_v4';

// Subject to Chapters mapping for clinical curriculum scoping
const SUBJECT_CHAPTERS = {
  'All': ['All chapters'],
  'Anatomy': [
    'All chapters',
    'Cardiovascular Anatomy',
    'Respiratory Anatomy',
    'Musculoskeletal Anatomy',
    'Neuroanatomy'
  ],
  'Physiology': [
    'All chapters',
    'Cardiovascular & Hemodynamic Physiology',
    'Respiratory & Gas Exchange Physiology',
    'Renal & Fluid Balance Physiology',
    'Neurophysiology'
  ],
  'Clinical Biochemistry': [
    'All chapters',
    'Carbohydrate Metabolism & Clinical Disorders',
    'Lipid Metabolism & Atherosclerosis',
    'Protein & Amino Acid Metabolism',
    'Acid-Base & Clinical Enzymes'
  ],
  'Applied Nutrition': [
    'All chapters',
    'Enteral & Parenteral Clinical Nutrition',
    'Macronutrient Deficiencies & PEM',
    'Micronutrient & Mineral Disorders',
    'Therapeutic Diets in Critical Illness'
  ]
};

// 4 Suggested prompt cards for the Claude-style home state
const PROMPT_SUGGESTIONS = [
  {
    subject: 'Anatomy',
    chapter: 'Cardiovascular Anatomy',
    title: 'Cardiac Blood Flow',
    prompt: 'Trace the complete pathway of blood flow through the heart chambers, valves, and great vessels.'
  },
  {
    subject: 'Physiology',
    chapter: 'Cardiovascular & Hemodynamic Physiology',
    title: 'Frank-Starling Law',
    prompt: 'Explain the Frank-Starling law of the heart and how ventricular preload determines stroke volume.'
  },
  {
    subject: 'Clinical Biochemistry',
    chapter: 'Carbohydrate Metabolism & Clinical Disorders',
    title: 'Diabetic Ketoacidosis (DKA)',
    prompt: 'What are the diagnostic blood glucose, ketone, and Arterial Blood Gas (ABG) criteria for Diabetic Ketoacidosis?'
  },
  {
    subject: 'Applied Nutrition',
    chapter: 'Enteral & Parenteral Clinical Nutrition',
    title: 'Refeeding Syndrome',
    prompt: 'Explain the pathophysiological mechanisms of Refeeding Syndrome and why severe hypophosphatemia develops.'
  }
];

// Helper: Strip emojis for clean clinical typography
const stripEmojis = (str) => (str ? str.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '') : '');

// Safe unique ID generator for user actions (outside pure render)
const generateId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// Formats relative time groups (Today, Yesterday, Previous 7 days, Older)
const getRelativeDateGroup = (timestamp) => {
  if (!timestamp) return 'Older';
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'Previous 7 days';
  return 'Older';
};

// Render inline Markdown formatting (bold, code, links, italics)
const renderInlineMarkdown = (text, isDark = false) => {
  if (!text) return null;
  const clean = stripEmojis(text);
  const tokens = clean.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);

  return tokens.map((token, idx) => {
    if (!token) return null;
    if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      return (
        <strong key={idx} className={`font-semibold ${isDark ? 'text-white' : 'text-[#123B50]'}`}>
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      return (
        <code
          key={idx}
          className={`px-1.5 py-0.5 rounded font-mono text-xs ${
            isDark
              ? 'bg-[#0B222E] text-[#20B8AE] border border-neutral-700/60'
              : 'bg-neutral-100 text-[#123B50]'
          }`}
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
      return (
        <em key={idx} className={`italic ${isDark ? 'text-neutral-300' : 'text-[#263746]'}`}>
          {token.slice(1, -1)}
        </em>
      );
    }
    return <span key={idx}>{token}</span>;
  });
};

// Markdown block renderer supporting headings, bullet lists, ordered lists, blockquotes, and paragraphs
const MarkdownRenderer = ({ content, isDark = false }) => {
  if (!content) return null;
  const lines = content.split('\n');
  const elements = [];
  let inList = false;
  let isOrdered = false;
  let listItems = [];

  const flushList = () => {
    if (inList && listItems.length > 0) {
      if (isOrdered) {
        elements.push(
          <ol key={`ol-${elements.length}`} className="my-2 space-y-1.5 pl-5 list-decimal marker:text-[#159A91] marker:font-semibold">
            {listItems.map((item, i) => (
              <li key={i} className="text-sm leading-relaxed">
                {renderInlineMarkdown(item, isDark)}
              </li>
            ))}
          </ol>
        );
      } else {
        elements.push(
          <ul key={`ul-${elements.length}`} className="my-2 space-y-1.5 pl-4 list-disc marker:text-[#159A91]">
            {listItems.map((item, i) => (
              <li key={i} className="text-sm leading-relaxed">
                {renderInlineMarkdown(item, isDark)}
              </li>
            ))}
          </ul>
        );
      }
      inList = false;
      isOrdered = false;
      listItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('# ')) {
      flushList();
      elements.push(
        <h1 key={i} className={`text-lg font-bold mt-4 mb-2 ${isDark ? 'text-white' : 'text-[#123B50]'}`}>
          {renderInlineMarkdown(line.slice(2), isDark)}
        </h1>
      );
    } else if (line.startsWith('## ')) {
      flushList();
      elements.push(
        <h2 key={i} className={`text-base font-bold mt-3 mb-1.5 ${isDark ? 'text-white' : 'text-[#123B50]'}`}>
          {renderInlineMarkdown(line.slice(3), isDark)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      flushList();
      elements.push(
        <h3 key={i} className={`text-sm font-semibold mt-2.5 mb-1 ${isDark ? 'text-neutral-200' : 'text-[#123B50]'}`}>
          {renderInlineMarkdown(line.slice(4), isDark)}
        </h3>
      );
    } else if (line.startsWith('> ')) {
      flushList();
      elements.push(
        <blockquote key={i} className={`my-2 pl-3 border-l-2 border-[#159A91] italic text-sm ${isDark ? 'text-neutral-300' : 'text-neutral-600'}`}>
          {renderInlineMarkdown(line.slice(2), isDark)}
        </blockquote>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      if (!inList || isOrdered) {
        flushList();
        inList = true;
        isOrdered = false;
      }
      listItems.push(line.replace(/^[-*•]\s+/, ''));
    } else if (/^\d+\.\s+/.test(line)) {
      if (!inList || !isOrdered) {
        flushList();
        inList = true;
        isOrdered = true;
      }
      listItems.push(line.replace(/^\d+\.\s+/, ''));
    } else if (line.length === 0) {
      flushList();
    } else {
      flushList();
      elements.push(
        <p key={i} className={`my-2 text-sm leading-relaxed ${isDark ? 'text-neutral-200' : 'text-[#263746]'}`}>
          {renderInlineMarkdown(line, isDark)}
        </p>
      );
    }
  }
  flushList();

  return <div className="space-y-0.5">{elements}</div>;
};

export default function AIWidget() {
  const { currentUser, token } = useAuth();

  // Widget visibility and Claude layout state
  const [isOpen, setIsOpen] = useState(false);
  const [windowMode, setWindowMode] = useState(() => {
    try {
      return localStorage.getItem('nova_window_mode') || 'normal';
    } catch { /* ignore */ }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      const mode = localStorage.getItem('nova_window_mode') || 'normal';
      return mode !== 'normal';
    } catch { /* ignore */ }
  });
  const [isDark, setIsDark] = useState(() => {
    try {
      const savedTheme = localStorage.getItem('nova_theme');
      if (savedTheme) return savedTheme === 'dark';
      return document.documentElement.classList.contains('dark') ||
        (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    } catch { /* ignore */ }
  });
  const [searchQuery, setSearchQuery] = useState('');

  const handleSetWindowMode = (mode) => {
    setWindowMode(mode);
    try {
      localStorage.setItem('nova_window_mode', mode);
    } catch { /* ignore */ }
    if (mode === 'normal') {
      setSidebarOpen(false);
    }
  };

  const handleToggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('nova_theme', next ? 'dark' : 'light');
        if (next) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Curriculum Subject & Chapter Scope
  const [selectedSubject, setSelectedSubject] = useState('All');
  const [selectedChapter, setSelectedChapter] = useState('All chapters');
  const [allChapters, setAllChapters] = useState(true);

  const handleSelectSubject = (subject) => {
    setSelectedSubject(subject);
    setSelectedChapter('All chapters');
    setAllChapters(subject === 'All');
  };

  // Active Chat & History State
  const [threads, setThreads] = useState(() => {
    try {
      const saved = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { /* ignore */ }
  });

  const [activeThreadId, setActiveThreadId] = useState(() => {
    try {
      const saved = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) : [];
      return parsed[0]?.id || 'thread_initial_001';
    } catch { /* ignore */ }
  });

  const [editingThreadId, setEditingThreadId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');

  // Input & Streaming State
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [feedbackToast, setFeedbackToast] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [activeCitationDrawer, setActiveCitationDrawer] = useState(null);

  // Editing existing user message
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editMessageContent, setEditMessageContent] = useState('');

  // References
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const textareaRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Active Thread
  const activeThread = useMemo(() => {
    return threads.find((t) => t.id === activeThreadId) || {
      id: activeThreadId,
      title: 'New chat',
      messages: [],
      starred: false,
      createdAt: 0
    };
  }, [threads, activeThreadId]);

  // Persist threads to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(threads));
    } catch (e) {
      console.warn('[AIWidget] Storage save error:', e);
    }
  }, [threads]);

  // Toast feedback trigger
  const triggerToast = useCallback((msg) => {
    setFeedbackToast(msg);
    setTimeout(() => setFeedbackToast(''), 2500);
  }, []);

  // Create New Chat (declared before useEffect to adhere to declaration order)
  const handleNewChat = useCallback(() => {
    const newId = generateId('thread');
    const newThread = {
      id: newId,
      title: 'New chat',
      messages: [],
      starred: false,
      createdAt: Date.now()
    };
    setThreads((prev) => [newThread, ...prev]);
    setActiveThreadId(newId);
    setStatusMessage('');
    if (windowMode === 'normal') {
      setSidebarOpen(false);
    }
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [windowMode]);

  // Auto-scroll logic
  const scrollToBottom = useCallback((behavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    if (isStreaming) {
      scrollToBottom('auto');
    }
  }, [activeThread.messages, isStreaming, scrollToBottom]);

  // Handle scroll events for "Scroll to bottom" button
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isUp = scrollHeight - scrollTop - clientHeight > 180;
    setShowScrollBottom(isUp);
  };

  // Set document title to "Nova | MedPulse"
  useEffect(() => {
    document.title = 'Nova | MedPulse';
  }, []);

  // Keyboard shortcut listener (Ctrl/Cmd+K focuses composer, Ctrl/Cmd+Shift+O starts new chat)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsOpen(true);
        setTimeout(() => textareaRef.current?.focus(), 100);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNewChat]);

  // Toggle Star / Pin on thread
  const handleToggleStar = (threadId, e) => {
    e.stopPropagation();
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, starred: !t.starred } : t))
    );
  };

  // Inline Rename Thread
  const handleSaveRename = (threadId) => {
    if (!editingTitle.trim()) {
      setEditingThreadId(null);
      return;
    }
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, title: editingTitle.trim() } : t))
    );
    setEditingThreadId(null);
    triggerToast('Chat renamed');
  };

  // Delete Thread
  const handleDeleteThread = (threadId, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat permanently?')) return;
    setThreads((prev) => {
      const filtered = prev.filter((t) => t.id !== threadId);
      if (filtered.length === 0) {
        const freshId = generateId('thread');
        return [{ id: freshId, title: 'New chat', messages: [], starred: false, createdAt: Date.now() }];
      }
      return filtered;
    });
    if (activeThreadId === threadId) {
      const remaining = threads.filter((t) => t.id !== threadId);
      setActiveThreadId(remaining[0]?.id || generateId('thread'));
    }
    triggerToast('Chat deleted');
  };

  // Stop generation
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStatusMessage('');
  };

  // Send message over SSE (/api/nova/chat)
  const handleSendMessage = useCallback(async (textToSend) => {
    const query = (textToSend || inputValue).trim();
    if (!query || isStreaming) return;

    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const nowTimestamp = Date.now();
    const userMessageId = `msg_user_${nowTimestamp}`;
    const assistantMessageId = `msg_asst_${nowTimestamp}`;

    const userMsg = {
      id: userMessageId,
      role: 'user',
      content: query,
      timestamp: nowTimestamp
    };

    const initialAssistantMsg = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      citations: [],
      timestamp: nowTimestamp,
      isSpecialNotice: false,
      isNotFound: false
    };

    // Auto-update thread title if this is the first message
    const isFirstMessage = activeThread.messages.length === 0;
    const updatedTitle = isFirstMessage
      ? query.slice(0, 32) + (query.length > 32 ? '...' : '')
      : activeThread.title;

    setThreads((prev) =>
      prev.map((t) => {
        if (t.id === activeThreadId) {
          return {
            ...t,
            title: updatedTitle,
            messages: [...t.messages, userMsg, initialAssistantMsg]
          };
        }
        return t;
      })
    );

    setIsStreaming(true);
    setStatusMessage('Nova is thinking...');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const authToken = token || localStorage.getItem('nursing_token') || '';
      const response = await fetch(getApiUrl('/api/nova/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          query,
          subject: selectedSubject,
          chapter: selectedChapter,
          allChapters
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to reach Nova.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);

            if (data.status) {
              setStatusMessage(data.status);
            }

            if (data.token) {
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.id === activeThreadId) {
                    const msgs = [...t.messages];
                    const lastIdx = msgs.length - 1;
                    if (lastIdx >= 0 && msgs[lastIdx].id === assistantMessageId) {
                      msgs[lastIdx] = {
                        ...msgs[lastIdx],
                        content: msgs[lastIdx].content + data.token
                      };
                    }
                    return { ...t, messages: msgs };
                  }
                  return t;
                })
              );
            }

            if (data.done) {
              setThreads((prev) =>
                prev.map((t) => {
                  if (t.id === activeThreadId) {
                    const msgs = [...t.messages];
                    const lastIdx = msgs.length - 1;
                    if (lastIdx >= 0 && msgs[lastIdx].id === assistantMessageId) {
                      msgs[lastIdx] = {
                        ...msgs[lastIdx],
                        content: data.fullText || msgs[lastIdx].content,
                        citations: data.citations || [],
                        isSpecialNotice: Boolean(data.specialNotice),
                        isNotFound: Boolean(data.notFoundInMaterial)
                      };
                    }
                    return { ...t, messages: msgs };
                  }
                  return t;
                })
              );
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('[Nova UI Error]:', err.message);
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id === activeThreadId) {
            const msgs = [...t.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].id === assistantMessageId) {
              msgs[lastIdx] = {
                ...msgs[lastIdx],
                content: 'Connection interrupted. Please click Retry to ask Nova again.',
                isSpecialNotice: true
              };
            }
            return { ...t, messages: msgs };
          }
          return t;
        })
      );
    } finally {
      setIsStreaming(false);
      setStatusMessage('');
      abortControllerRef.current = null;
    }
  }, [inputValue, isStreaming, token, selectedSubject, selectedChapter, allChapters, activeThread, activeThreadId]);

  // Regenerate last response
  const handleRegenerate = () => {
    const msgs = activeThread.messages;
    if (msgs.length === 0 || isStreaming) return;
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      handleSendMessage(lastUserMsg.content);
    }
  };

  // Edit user message and resend
  const handleSaveEditUserMessage = (msgId) => {
    if (!editMessageContent.trim()) return;
    // Remove all subsequent messages and re-send
    const msgIdx = activeThread.messages.findIndex((m) => m.id === msgId);
    if (msgIdx === -1) return;

    const trimmedMessages = activeThread.messages.slice(0, msgIdx);
    setThreads((prev) =>
      prev.map((t) => (t.id === activeThreadId ? { ...t, messages: trimmedMessages } : t))
    );
    setEditingMessageId(null);
    handleSendMessage(editMessageContent.trim());
  };

  // Copy message text
  const handleCopyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      triggerToast('Copied to clipboard');
    } catch { /* ignore */ }
  };

  // Auto-grow textarea
  const handleTextareaChange = (e) => {
    setInputValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  // Display name extraction
  const studentFirstName = currentUser?.displayName
    ? currentUser.displayName.split(' ')[0]
    : currentUser?.name
    ? currentUser.name.split(' ')[0]
    : '';

  // Filtered threads by search
  const filteredThreads = useMemo(() => {
    return threads.filter((t) =>
      (t.title || '').toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [threads, searchQuery]);

  const starredThreads = useMemo(() => filteredThreads.filter((t) => t.starred), [filteredThreads]);
  const unstarredThreads = useMemo(() => filteredThreads.filter((t) => !t.starred), [filteredThreads]);

  // Group unstarred threads by date
  const groupedThreads = useMemo(() => {
    return unstarredThreads.reduce((acc, t) => {
      const group = getRelativeDateGroup(t.createdAt || 0);
      if (!acc[group]) acc[group] = [];
      acc[group].push(t);
      return acc;
    }, {});
  }, [unstarredThreads]);

  return (
    <>
      {/* Floating launcher trigger if closed */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          aria-label="Open Nova Clinical Tutor"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 bg-[#159A91] hover:bg-[#12837B] text-white rounded-full shadow-lg transition-transform hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-[#159A91] focus:ring-offset-2"
        >
          <NovaLogo size={24} className="rounded-md" />
          <span className="font-semibold text-sm tracking-wide">Ask {APP_NAME}</span>
          <span className="text-[11px] bg-white/20 px-2 py-0.5 rounded-full font-mono">Ctrl+K</span>
        </button>
      )}

      {/* Main Window: Side Window (Normal/Half) or Fullscreen */}
      {isOpen && (
        <div
          className={`fixed z-50 transition-all duration-300 ease-in-out ${
            windowMode === 'full'
              ? 'inset-0 flex bg-black/40 backdrop-blur-xs'
              : windowMode === 'half'
              ? 'top-0 right-0 bottom-0 w-full sm:w-1/2 pointer-events-auto'
              : 'top-0 right-0 bottom-0 w-full sm:w-[480px] md:w-[500px] pointer-events-auto'
          }`}
        >
          <div
            className={`flex w-full h-full ${
              isDark ? 'dark bg-[#0B222E] text-neutral-100' : 'bg-[#FAFAFA] text-[#263746]'
            } overflow-hidden shadow-2xl relative font-sans ${
              windowMode !== 'full' ? 'border-l border-neutral-200 dark:border-neutral-700/80' : ''
            }`}
          >
            {/* Feedback Toast Notification */}
            {feedbackToast && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-60 px-4 py-2 bg-[#123B50] text-white text-xs font-semibold rounded-full shadow-lg flex items-center gap-2 animate-bounce-short">
                <Check className="w-3.5 h-3.5 text-[#20B8AE]" />
                <span>{feedbackToast}</span>
              </div>
            )}

            {/* Backdrop for sidebar in normal mode when opened */}
            {windowMode === 'normal' && sidebarOpen && (
              <div
                onClick={() => setSidebarOpen(false)}
                className="absolute inset-0 z-20 bg-black/30 backdrop-blur-xs transition-opacity"
                aria-label="Close sidebar backdrop"
              />
            )}

            {/* ================= LEFT SIDEBAR (Claude-Style Collapsible) ================= */}
            <aside
              className={`transition-all duration-200 ease-in-out flex flex-col ${
                windowMode === 'normal'
                  ? `absolute inset-y-0 left-0 z-30 w-72 shadow-2xl border-r ${
                      isDark ? 'bg-[#0F2D3D] border-neutral-700/60' : 'bg-[#FAFAFA] border-neutral-200'
                    } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'}`
                  : `border-r ${
                      isDark ? 'bg-[#0F2D3D] border-neutral-700/60' : 'bg-[#FAFAFA] border-neutral-200'
                    } ${sidebarOpen ? 'w-64 min-w-[16rem] max-w-[16rem]' : 'w-0 min-w-0 max-w-0 overflow-hidden border-r-0'}`
              }`}
            >
              {/* Sidebar Header: Nova Branding + New Chat */}
              <div className="p-3 border-b border-neutral-200 dark:border-neutral-700/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <NovaLogo size={28} className="rounded-lg shadow-2xs" />
                  <span className="font-serif font-bold text-lg tracking-tight text-[#159A91]">
                    {APP_NAME}
                  </span>
                </div>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-1 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                  aria-label="Collapse sidebar"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
              </div>

              {/* "New chat" button */}
              <div className="p-3">
                <button
                  onClick={handleNewChat}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold rounded-xl bg-[#E9F5F3] hover:bg-[#D0EEEB] text-[#123B50] dark:bg-[#123B50] dark:hover:bg-[#159A91]/20 dark:text-[#20B8AE] border border-[#159A91]/20 transition-all shadow-2xs"
                >
                  <div className="flex items-center gap-2">
                    <SquarePen className="w-4 h-4 text-[#159A91]" />
                    <span>New chat</span>
                  </div>
                  <span className="text-[10px] text-neutral-400 font-mono">⌘⇧O</span>
                </button>
              </div>

              {/* Chat Search input */}
              <div className="px-3 pb-2">
                <div className="relative flex items-center">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 text-neutral-400" />
                  <input
                    type="text"
                    placeholder="Search chats..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-[#0B222E] border border-neutral-200 dark:border-neutral-700/60 focus:outline-none focus:ring-1 focus:ring-[#159A91] text-[#263746] dark:text-neutral-200 placeholder-neutral-400"
                  />
                </div>
              </div>

              {/* Chat List (Grouped) */}
              <div className="flex-1 overflow-y-auto px-2 space-y-4 text-xs">
                {/* Starred Section */}
                {starredThreads.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-[#159A91] flex items-center gap-1.5">
                      <Star className="w-3 h-3 fill-[#159A91]" />
                      <span>Starred</span>
                    </div>
                    <div className="space-y-0.5">
                      {starredThreads.map((thread) => (
                        <div
                          key={thread.id}
                          onClick={() => {
                            setActiveThreadId(thread.id);
                            if (windowMode === 'normal') setSidebarOpen(false);
                          }}
                          className={`group relative flex items-center justify-between px-2.5 py-2 rounded-xl cursor-pointer text-xs transition-colors ${
                            activeThreadId === thread.id
                              ? 'bg-[#E9F5F3] dark:bg-[#123B50] font-semibold text-[#123B50] dark:text-[#20B8AE]'
                              : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60'
                          }`}
                        >
                          <span className="truncate pr-8">{thread.title || 'Untitled chat'}</span>
                          <button
                            onClick={(e) => handleToggleStar(thread.id, e)}
                            className="text-[#159A91] p-1"
                            aria-label="Unpin chat"
                          >
                            <Star className="w-3.5 h-3.5 fill-[#159A91]" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Date Grouped Sections */}
                {['Today', 'Yesterday', 'Previous 7 days', 'Older'].map((group) => {
                  const items = groupedThreads[group] || [];
                  if (items.length === 0) return null;
                  return (
                    <div key={group}>
                      <div className="px-2 py-1 text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                        {group}
                      </div>
                      <div className="space-y-0.5">
                        {items.map((thread) => (
                          <div
                            key={thread.id}
                            onClick={() => {
                              setActiveThreadId(thread.id);
                              if (windowMode === 'normal') setSidebarOpen(false);
                            }}
                            className={`group relative flex items-center justify-between px-2.5 py-2 rounded-xl cursor-pointer text-xs transition-colors ${
                              activeThreadId === thread.id
                                ? 'bg-[#E9F5F3] dark:bg-[#123B50] font-semibold text-[#123B50] dark:text-[#20B8AE]'
                                : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60'
                            }`}
                          >
                            {editingThreadId === thread.id ? (
                              <input
                                autoFocus
                                type="text"
                                value={editingTitle}
                                onChange={(e) => setEditingTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveRename(thread.id);
                                  if (e.key === 'Escape') setEditingThreadId(null);
                                }}
                                onBlur={() => handleSaveRename(thread.id)}
                                className="w-full bg-white dark:bg-[#0B222E] px-1.5 py-0.5 rounded border border-[#159A91] text-xs focus:outline-none"
                              />
                            ) : (
                              <>
                                <span className="truncate pr-12">{thread.title || 'New chat'}</span>
                                <div className="absolute right-1 flex items-center opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-100 dark:bg-[#123B50] rounded-lg px-1 py-0.5 shadow-xs">
                                  <button
                                    onClick={(e) => handleToggleStar(thread.id, e)}
                                    className="p-1 hover:text-[#159A91]"
                                    aria-label="Star chat"
                                  >
                                    <Star className="w-3 h-3 text-neutral-400" />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingThreadId(thread.id);
                                      setEditingTitle(thread.title);
                                    }}
                                    className="p-1 hover:text-[#159A91]"
                                    aria-label="Rename chat"
                                  >
                                    <Pencil className="w-3 h-3 text-neutral-400" />
                                  </button>
                                  <button
                                    onClick={(e) => handleDeleteThread(thread.id, e)}
                                    className="p-1 hover:text-red-500"
                                    aria-label="Delete chat"
                                  >
                                    <Trash2 className="w-3 h-3 text-neutral-400" />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Sidebar Footer: User Avatar + Theme Toggle */}
              <div className="p-3 border-t border-neutral-200 dark:border-neutral-700/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <div className="w-8 h-8 rounded-full bg-[#123B50] text-white flex items-center justify-center font-bold text-xs shrink-0">
                    {currentUser?.displayName?.[0] || currentUser?.name?.[0] || 'S'}
                  </div>
                  <div className="truncate text-xs">
                    <p className="font-semibold truncate text-[#263746] dark:text-neutral-100">
                      {currentUser?.displayName || currentUser?.name || 'Student RN'}
                    </p>
                    <p className="text-[11px] text-neutral-400 truncate">
                      {currentUser?.email || 'MedPulse Nursing'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleToggleTheme}
                  className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                  aria-label="Toggle Theme"
                >
                  {isDark ? <Sun className="w-4 h-4 text-[#F2B66D]" /> : <Moon className="w-4 h-4" />}
                </button>
              </div>
            </aside>

            {/* ================= MAIN CONVERSATION COLUMN ================= */}
            <main className="flex-1 flex flex-col h-full overflow-hidden relative">
              {/* Top Navigation Bar */}
              <header className="h-14 border-b border-neutral-200 dark:border-neutral-700/60 px-3 sm:px-4 flex items-center justify-between shrink-0 bg-white/60 dark:bg-[#0F2D3D]/60 backdrop-blur-md z-10 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {(!sidebarOpen || windowMode === 'normal') && (
                    <button
                      onClick={() => setSidebarOpen(!sidebarOpen)}
                      className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-800 shrink-0"
                      aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
                      title="Toggle chat history"
                    >
                      <PanelLeft className="w-4 h-4" />
                    </button>
                  )}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-serif font-bold text-base text-[#123B50] dark:text-white truncate">
                      {APP_NAME}
                    </span>
                    <span className="hidden xs:inline-block text-[11px] px-2 py-0.5 rounded-full bg-[#E9F5F3] dark:bg-[#123B50] text-[#159A91] dark:text-[#20B8AE] font-semibold whitespace-nowrap">
                      {windowMode === 'normal' ? 'Tutor' : 'Nursing Study Companion'}
                    </span>
                  </div>
                </div>

                {/* Window Mode Controls & Actions */}
                <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                  {/* Subject Scope Pills (shown in full or half mode on wide screens) */}
                  {windowMode !== 'normal' && (
                    <div className="hidden md:flex items-center gap-1 bg-neutral-100 dark:bg-[#0B222E] p-1 rounded-xl text-xs">
                      {['All', 'Anatomy', 'Physiology', 'Clinical Biochemistry', 'Applied Nutrition'].map(
                        (sub) => (
                          <button
                            key={sub}
                            onClick={() => handleSelectSubject(sub)}
                            className={`px-2 py-0.5 rounded-lg font-medium transition-colors ${
                              selectedSubject === sub
                                ? 'bg-white dark:bg-[#123B50] text-[#159A91] dark:text-[#20B8AE] shadow-xs'
                                : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                            }`}
                          >
                            {sub === 'Clinical Biochemistry'
                              ? 'Biochem'
                              : sub === 'Applied Nutrition'
                              ? 'Nutrition'
                              : sub}
                          </button>
                        )
                      )}
                    </div>
                  )}

                  {/* Window Mode Switcher Segmented Control */}
                  <div className="flex items-center bg-neutral-100 dark:bg-[#0B222E] p-0.5 rounded-lg border border-neutral-200 dark:border-neutral-700/60 text-xs">
                    <button
                      onClick={() => handleSetWindowMode('normal')}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                        windowMode === 'normal'
                          ? 'bg-white dark:bg-[#123B50] text-[#159A91] dark:text-[#20B8AE] shadow-xs font-semibold'
                          : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                      }`}
                      title="Normal side window (~480px docked)"
                      aria-label="Normal mode"
                    >
                      Normal
                    </button>
                    <button
                      onClick={() => handleSetWindowMode('half')}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                        windowMode === 'half'
                          ? 'bg-white dark:bg-[#123B50] text-[#159A91] dark:text-[#20B8AE] shadow-xs font-semibold'
                          : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                      }`}
                      title="Half screen (50% split view)"
                      aria-label="Half mode"
                    >
                      Half
                    </button>
                    <button
                      onClick={() => handleSetWindowMode('full')}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                        windowMode === 'full'
                          ? 'bg-white dark:bg-[#123B50] text-[#159A91] dark:text-[#20B8AE] shadow-xs font-semibold'
                          : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                      }`}
                      title="Full screen view"
                      aria-label="Full mode"
                    >
                      Full
                    </button>
                  </div>

                  {/* Minimize & Close Buttons */}
                  <div className="flex items-center border-l border-neutral-200 dark:border-neutral-700/60 pl-1.5 ml-0.5 gap-0.5">
                    <button
                      onClick={() => setIsOpen(false)}
                      className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                      aria-label="Minimize Nova"
                      title="Minimize"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setIsOpen(false)}
                      className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 hover:bg-neutral-200/50 dark:hover:bg-neutral-800"
                      aria-label="Close Nova"
                      title="Close"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </header>

              {/* Messages Container */}
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-4 sm:p-6"
              >
                <div className="max-w-3xl mx-auto space-y-6">
                  {/* Empty Home State (Claude-Style) */}
                  {activeThread.messages.length === 0 && (
                    <div className="py-8 sm:py-12 text-center animate-fade-in">
                      <div className="flex justify-center mb-3">
                        <NovaLogo size={64} className="rounded-2xl shadow-md" />
                      </div>
                      <div className="font-serif text-2xl font-bold tracking-tight text-[#159A91] mb-2">
                        {APP_NAME}
                      </div>
                      <h1 className="font-serif text-3xl font-bold tracking-tight text-[#123B50] dark:text-white mb-2">
                        {studentFirstName ? `Hi ${studentFirstName}, I'm ${APP_NAME}` : `Hi, I'm ${APP_NAME}`}
                      </h1>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto mb-6">
                        Your nursing study companion. Ask me about Anatomy, Physiology, Clinical Biochemistry, or Applied Nutrition.
                      </p>

                      {/* 4 Suggested Prompt Cards */}
                      <div className={`grid gap-3 text-left max-w-2xl mx-auto ${windowMode === 'normal' ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                        {PROMPT_SUGGESTIONS.map((card, i) => (
                          <div
                            key={i}
                            onClick={() => {
                              setSelectedSubject(card.subject);
                              handleSendMessage(card.prompt);
                            }}
                            className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-700/60 bg-white dark:bg-[#0F2D3D] hover:border-[#159A91] hover:shadow-sm cursor-pointer transition-all group"
                          >
                            <span className="text-[11px] font-bold uppercase tracking-wider text-[#159A91] dark:text-[#20B8AE]">
                              {card.subject}
                            </span>
                            <h3 className="text-sm font-semibold text-[#123B50] dark:text-white mt-1 group-hover:text-[#159A91] transition-colors">
                              {card.title}
                            </h3>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5 line-clamp-2">
                              {card.prompt}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Rendered Messages */}
                  {activeThread.messages.map((message) => {
                    const isUser = message.role === 'user';
                    return (
                      <div
                        key={message.id}
                        className={`group relative flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                      >
                        {/* USER MESSAGE: Soft Bubble */}
                        {isUser && (
                          <div className="max-w-[85%] sm:max-w-[75%]">
                            <div className="bg-[#E9F5F3] dark:bg-[#123B50] text-[#123B50] dark:text-neutral-100 px-4 py-3 rounded-2xl rounded-tr-xs text-sm leading-relaxed shadow-2xs border border-[#159A91]/15">
                              {editingMessageId === message.id ? (
                                <div className="space-y-2">
                                  <textarea
                                    value={editMessageContent}
                                    onChange={(e) => setEditMessageContent(e.target.value)}
                                    className="w-full bg-white dark:bg-[#0B222E] p-2 rounded-lg text-xs border border-[#159A91] focus:outline-none"
                                    rows={3}
                                  />
                                  <div className="flex justify-end gap-1.5">
                                    <button
                                      onClick={() => setEditingMessageId(null)}
                                      className="px-2 py-1 text-xs text-neutral-500"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => handleSaveEditUserMessage(message.id)}
                                      className="px-2.5 py-1 text-xs bg-[#159A91] text-white rounded-md font-semibold"
                                    >
                                      Resend
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <span>{message.content}</span>
                              )}
                            </div>

                            {/* User Action Row */}
                            <div className="flex items-center gap-1.5 justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => handleCopyText(message.content)}
                                className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                                aria-label="Copy message"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  setEditingMessageId(message.id);
                                  setEditMessageContent(message.content);
                                }}
                                className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                                aria-label="Edit message"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}

                        {/* ASSISTANT MESSAGE: Full-width with Nova Avatar */}
                        {!isUser && (
                          <div className="w-full">
                            <div className="flex items-center gap-2 mb-2">
                              <NovaLogo size={24} className="rounded-md shadow-2xs" />
                              <span className="font-semibold text-xs tracking-tight text-[#159A91]">
                                {APP_NAME}
                              </span>
                            </div>

                            {/* Informational Callout Styling for Special Replies */}
                            {message.isSpecialNotice || message.isNotFound ? (
                              <div
                                className={`p-4 rounded-2xl border text-sm leading-relaxed flex items-start gap-3 my-2 ${
                                  message.content.includes('educational study tool')
                                    ? 'bg-[#FEF3C7] text-[#78350F] border-[#F2B66D]'
                                    : 'bg-[#F0F6F8] dark:bg-[#123B50]/60 text-[#123B50] dark:text-neutral-200 border-[#159A91]/30'
                                }`}
                              >
                                {message.content.includes('educational study tool') ? (
                                  <ShieldAlert className="w-5 h-5 text-[#D97706] shrink-0 mt-0.5" />
                                ) : (
                                  <Info className="w-5 h-5 text-[#159A91] shrink-0 mt-0.5" />
                                )}
                                <div>
                                  <p>{message.content}</p>
                                </div>
                              </div>
                            ) : (
                              <div className="prose dark:prose-invert max-w-none text-sm leading-relaxed text-[#263746] dark:text-neutral-100">
                                <MarkdownRenderer content={message.content} isDark={isDark} />
                              </div>
                            )}

                            {/* Source Citation Chips */}
                            {message.citations && message.citations.length > 0 && (
                              <div className="mt-3 pt-2 border-t border-neutral-200/60 dark:border-neutral-700/60 flex flex-wrap gap-1.5 items-center">
                                <span className="text-[11px] font-semibold text-neutral-400 mr-1 flex items-center gap-1">
                                  <BookOpen className="w-3 h-3 text-[#159A91]" />
                                  Cited sources:
                                </span>
                                {message.citations.map((cite, cIdx) => (
                                  <button
                                    key={cIdx}
                                    onClick={() => setActiveCitationDrawer(cite)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[#E9F5F3] dark:bg-[#123B50] text-[#123B50] dark:text-[#20B8AE] border border-[#159A91]/20 hover:border-[#159A91] transition-all cursor-pointer"
                                  >
                                    <span>
                                      {cite.subject} › {cite.chapter} (p. {cite.pageNumber})
                                    </span>
                                    <ExternalLink className="w-3 h-3 text-[#159A91]" />
                                  </button>
                                ))}
                              </div>
                            )}

                            {/* Assistant Action Row */}
                            <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => handleCopyText(message.content)}
                                className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                                aria-label="Copy reply"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={handleRegenerate}
                                className="p-1 rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                                aria-label="Regenerate reply"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => triggerToast('Feedback submitted. Thank you!')}
                                className="p-1 rounded text-neutral-400 hover:text-green-600"
                                aria-label="Thumbs up"
                              >
                                <ThumbsUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => triggerToast('Feedback noted for faculty review.')}
                                className="p-1 rounded text-neutral-400 hover:text-red-500"
                                aria-label="Thumbs down"
                              >
                                <ThumbsDown className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Real-Time Streaming Status Line */}
                  {isStreaming && (
                    <div className="flex items-center gap-2 text-xs font-medium text-[#159A91] dark:text-[#20B8AE] py-2 animate-pulse">
                      <NovaLogo size={16} className="rounded-xs animate-spin" />
                      <span>{statusMessage || `${APP_NAME} is thinking...`}</span>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              </div>

              {/* Floating "Scroll to bottom" button */}
              {showScrollBottom && (
                <button
                  onClick={() => scrollToBottom('smooth')}
                  className="absolute bottom-24 right-8 z-20 p-2 bg-white dark:bg-[#123B50] border border-neutral-200 dark:border-neutral-700 rounded-full shadow-md text-[#159A91] hover:scale-105 transition-all"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              )}

              {/* ================= COMPOSER (Fixed at Bottom) ================= */}
              <div className="p-4 sm:p-6 shrink-0 max-w-3xl w-full mx-auto">
                <div className="relative rounded-2xl border border-neutral-300 dark:border-neutral-700/80 bg-white dark:bg-[#0F2D3D] shadow-sm focus-within:ring-2 focus-within:ring-[#159A91] focus-within:border-[#159A91] transition-all">
                  {/* Subject Scope Chip inside composer */}
                  <div className="px-3.5 pt-2 flex items-center justify-between text-xs text-neutral-400 flex-wrap gap-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-[#159A91] dark:text-[#20B8AE]">
                        Scope:
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-[#0B222E] text-neutral-600 dark:text-neutral-300 font-medium">
                        {selectedSubject === 'All' ? 'All Nursing Subjects' : selectedSubject}
                      </span>
                      {selectedSubject !== 'All' && (
                        <select
                          value={selectedChapter}
                          onChange={(e) => {
                            setSelectedChapter(e.target.value);
                            setAllChapters(e.target.value === 'All chapters');
                          }}
                          aria-label="Filter chapter"
                          className="px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-[#0B222E] text-neutral-600 dark:text-neutral-300 font-medium border-0 focus:ring-1 focus:ring-[#159A91] text-xs cursor-pointer"
                        >
                          {(SUBJECT_CHAPTERS[selectedSubject] || ['All chapters']).map((ch) => (
                            <option key={ch} value={ch}>
                              {ch}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <span className="text-[11px] font-mono">
                      {inputValue.length} / 4000
                    </span>
                  </div>

                  {/* Input Textarea */}
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    value={inputValue}
                    onChange={handleTextareaChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder={`Message ${APP_NAME}...`}
                    disabled={isStreaming}
                    className="w-full px-3.5 py-2.5 text-sm bg-transparent resize-none focus:outline-none text-[#263746] dark:text-white placeholder-neutral-400 max-h-48 leading-relaxed"
                  />

                  {/* Send / Stop Controls */}
                  <div className="px-3 pb-2.5 flex items-center justify-between">
                    <p className="text-[11px] text-neutral-400">
                      Press <kbd className="font-mono bg-neutral-100 dark:bg-neutral-800 px-1 py-0.5 rounded">Enter</kbd> to send
                    </p>

                    <div>
                      {isStreaming ? (
                        <button
                          onClick={handleStopGeneration}
                          className="flex items-center gap-1 px-3 py-1.5 bg-[#123B50] hover:bg-neutral-800 text-white rounded-xl text-xs font-semibold shadow-xs transition-all"
                        >
                          <Square className="w-3.5 h-3.5 fill-white" />
                          <span>Stop</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSendMessage()}
                          disabled={!inputValue.trim()}
                          className={`p-2 rounded-xl transition-all ${
                            inputValue.trim()
                              ? 'bg-[#159A91] hover:bg-[#12837B] text-white shadow-xs'
                              : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
                          }`}
                          aria-label="Send message"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </main>

            {/* ================= SIDE DRAWER: SOURCE PASSAGE VIEWER ================= */}
            {activeCitationDrawer && (
              <div className="absolute inset-y-0 right-0 w-full sm:w-80 max-w-full z-40 bg-white dark:bg-[#0F2D3D] border-l border-neutral-200 dark:border-neutral-700 shadow-2xl flex flex-col animate-slide-left">
                <div className="p-4 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-[#159A91]" />
                    <span className="font-bold text-xs uppercase tracking-wider text-[#123B50] dark:text-white">
                      Curriculum Source
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveCitationDrawer(null)}
                    className="p-1 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    aria-label="Close passage"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 overflow-y-auto flex-1 space-y-4 text-xs">
                  <div>
                    <span className="text-[11px] font-bold uppercase text-[#159A91]">
                      {activeCitationDrawer.subject}
                    </span>
                    <h3 className="font-serif font-bold text-base text-[#123B50] dark:text-white mt-0.5">
                      {activeCitationDrawer.chapter}
                    </h3>
                    <p className="text-neutral-500 text-[11px]">
                      Section: {activeCitationDrawer.subtopic} | Page {activeCitationDrawer.pageNumber}
                    </p>
                  </div>

                  <div className="p-3 bg-[#FAFAFA] dark:bg-[#0B222E] rounded-xl border border-neutral-200 dark:border-neutral-700/60 leading-relaxed text-[#263746] dark:text-neutral-200">
                    <p>{activeCitationDrawer.snippet}</p>
                  </div>

                  <div className="text-[11px] text-neutral-400 flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-800">
                    <span>File: {activeCitationDrawer.sourceFile}</span>
                    <span>Confidence: {Math.round(activeCitationDrawer.similarity * 100)}%</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
