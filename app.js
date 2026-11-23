(function () {
  'use strict';

  const STORAGE_KEY = 'slovosk_state_v2';
  const LEGACY_KEY = 'slovosk_state_v1';
  const AUTO_SNAPSHOT_KEY = 'slovosk_auto_snapshot_v2';
  const WEEK_MS = 7 * 86400000;
  const DIACRITICS = ['á', 'ä', 'č', 'ď', 'é', 'í', 'ĺ', 'ľ', 'ň', 'ó', 'ô', 'ŕ', 'š', 'ť', 'ú', 'ý', 'ž'];
  const SRS_DAYS = [0, 1, 3, 7, 14, 30]; // Box 0..5

  // =====================================================
  // MODULAR COURSE LOADER (m1.js, m2.js, m3.js ...)
  // =====================================================
  const LOADED_MODULES = [];
  window.SLOVOSK_REGISTER = function (mod) {
    if (!mod || !mod.id) return;
    const idx = LOADED_MODULES.findIndex((m) => m.id === mod.id);
    if (idx >= 0) LOADED_MODULES[idx] = mod;
    else LOADED_MODULES.push(mod);
  };

  let SECTIONS = [];
  let ALL_LESSONS = [];
  let ALL_WORDS = [];
  let WORD_MAP = {};
  let REF = {
    pronunciation: [],
    falseFriends: [],
    grammar: [],
    aiScenarios: []
  };

  function rebuildCourseIndex() {
    LOADED_MODULES.sort((a, b) => (a.order || 0) - (b.order || 0));
    SECTIONS = [];
    ALL_LESSONS = [];
    ALL_WORDS = [];
    WORD_MAP = {};
    REF = { pronunciation: [], falseFriends: [], grammar: [], aiScenarios: [] };

    const seenWords = new Set();
    LOADED_MODULES.forEach((mod) => {
      (mod.sections || []).forEach((sec) => {
        const sObj = { ...sec, moduleId: mod.id, level: sec.level || 'A1' };
        SECTIONS.push(sObj);
        (sec.lessons || []).forEach((les) => {
          ALL_LESSONS.push({
            ...les,
            sectionId: sec.id,
            sectionTitle: sec.title,
            sectionColor: sec.color,
            level: sObj.level
          });
          (les.words || []).forEach((w) => {
            if (seenWords.has(w.id)) return;
            seenWords.add(w.id);
            const enriched = {
              ...w,
              lessonId: les.id,
              sectionId: sec.id,
              lessonTitle: les.title,
              level: sObj.level
            };
            ALL_WORDS.push(enriched);
            WORD_MAP[w.id] = enriched;
          });
        });
      });

      if (mod.reference) {
        if (mod.reference.pronunciation) REF.pronunciation.push(...mod.reference.pronunciation);
        if (mod.reference.falseFriends) REF.falseFriends.push(...mod.reference.falseFriends);
        if (mod.reference.grammar) REF.grammar.push(...mod.reference.grammar);
        if (mod.reference.aiScenarios) {
          mod.reference.aiScenarios.forEach((sc) => {
            if (!REF.aiScenarios.some((x) => x.id === sc.id)) REF.aiScenarios.push(sc);
          });
        }
      }
    });
  }

  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve(true);
      s.onerror = () => {
        s.remove();
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }

  async function discoverModules() {
    for (let n = 1; n <= 30; n++) {
      const ok = await loadScript(`./m${n}.js`);
      if (!ok) break;
    }
    rebuildCourseIndex();
  }

  // =====================================================
  // PERSISTENT STATE (Never loses progress on module updates)
  // =====================================================
  const XP_LESSON = 20;
  const XP_STORY = 15;
  const XP_EXAM = 30;
  const XP_REVIEW = 15;

  const LEVEL_EXAM_CONFIGS = [
    {
      id: 'lvl_A0',
      level: 'A0',
      icon: '🥉',
      badge: 'A0',
      title: 'Великий екзамен рівня A0',
      subtitle: 'Повна атестація бази: читання, наголос, бути/мати, числа й магазин',
      questions: 24,
      maxMistakes: 2,
      xp: 80,
      themeClass: 'lvl-a0'
    },
    {
      id: 'lvl_A1',
      level: 'A1',
      icon: '🥈',
      badge: 'A1',
      title: 'Великий екзамен рівня A1',
      subtitle: 'Комплексна перевірка всього A1: робота, побут, банк, минулий і майбутній час',
      questions: 40,
      maxMistakes: 3,
      xp: 120,
      themeClass: 'lvl-a1'
    },
    {
      id: 'lvl_A2',
      level: 'A2',
      icon: '🥇',
      badge: 'A2',
      title: 'Великий екзамен рівня A2',
      subtitle: 'Масштабна атестація всього A2: жива мова, документи, фінанси й сервіси',
      questions: 50,
      maxMistakes: 4,
      xp: 150,
      themeClass: 'lvl-a2'
    },
    {
      id: 'lvl_FINAL',
      level: 'ALL',
      icon: '👑',
      badge: 'ФІНАЛ',
      title: 'Фінальний мега-екзамен: Увесь курс',
      subtitle: 'Масштабна підсумкова атестація всього вивченого (A0 + A1 + A2 + B1)',
      questions: 60,
      maxMistakes: 5,
      xp: 250,
      themeClass: 'lvl-final'
    }
  ];

  function getLevelExamConfig(examId) {
    return LEVEL_EXAM_CONFIGS.find((c) => c.id === examId) || null;
  }

  function getActiveLevelExams() {
    return LEVEL_EXAM_CONFIGS.filter((cfg) => {
      if (cfg.level === 'ALL') return SECTIONS.length > 0;
      return SECTIONS.some((s) => s.level === cfg.level);
    });
  }

  const todayKey = (dateObj = new Date()) => {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  function daysBetweenKeys(fromKey, toKey) {
    if (!fromKey || !toKey) return 0;
    const p1 = String(fromKey).split('-').map(Number);
    const p2 = String(toKey).split('-').map(Number);
    if (p1.length !== 3 || p2.length !== 3 || !p1[0] || !p2[0]) return 0;
    const t1 = Date.UTC(p1[0], p1[1] - 1, p1[2]);
    const t2 = Date.UTC(p2[0], p2[1] - 1, p2[2]);
    return Math.round((t2 - t1) / 86400000);
  }

  const defaultState = () => ({
    xp: 0,
    dailyXp: 0,
    dailyGoal: 60,
    lastDay: todayKey(),
    lastActiveDay: todayKey(),
    missedDaysWarning: 0,
    dailyPenalty: 0,
    lastPenaltyDay: '',
    streak: 0,
    streakDay: '',
    hearts: 5,
    infiniteHearts: false,
    freeUnlock: false,
    levelFilter: 'ALL',
    completedLessons: [],
    completedStories: [],
    passedExams: [],
    passedLevelExams: [],
    weakWords: [],
    knownWords: [],
    srs: {}, // wordId -> { box: 0..5, nextReview: ms }
    theme: 'dark',
    soundFx: true,
    autoSpeak: true,
    micEnabled: true,
    preferredVoiceURI: '',
    geminiKey: '',
    refSubtab: 'dict',
    reviewSubtab: 'srs',
    aiScenario: 'interview',
    audioPauseSec: 3,
    audioSpeakUk: true,
    audioSlow: false,
    weeklyBackupEnabled: true,
    lastFileExportAt: 0,
    backupSnoozeUntil: 0,
    lastAutoSnapshotAt: 0
  });

  function loadState() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) {
          const old = JSON.parse(legacy);
          const migrated = {
            ...defaultState(),
            xp: old.xp || 0,
            dailyXp: old.dailyXp || 0,
            dailyGoal: old.dailyGoal || 50,
            streak: old.streak || 0,
            streakDay: old.streakDay || '',
            hearts: typeof old.hearts === 'number' ? old.hearts : 5,
            infiniteHearts: !!old.infiniteHearts,
            theme: old.theme || 'dark',
            soundFx: old.soundFx !== false,
            autoSpeak: old.autoSpeak !== false,
            micEnabled: old.micEnabled !== false,
            preferredVoiceURI: old.preferredVoiceURI || '',
            geminiKey: old.geminiKey || ''
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
        return defaultState();
      }
      const rawObj = JSON.parse(raw);
      const parsed = { ...defaultState(), ...rawObj };
      if (!parsed.srs || typeof parsed.srs !== 'object') parsed.srs = {};
      if (!Array.isArray(parsed.passedLevelExams)) parsed.passedLevelExams = [];
      if (!rawObj.lastActiveDay) {
        parsed.lastActiveDay = rawObj.streakDay || rawObj.lastDay || todayKey();
      }
      return parsed;
    } catch {
      return defaultState();
    }
  }

  let state = loadState();
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
    updateHeader();
    updateSrsBadge();
  }

  // =====================================================
  // WEEKLY AUTO-BACKUP (Internal Rolling Snapshot + Weekly JSON File)
  // =====================================================
  function saveAutoSnapshot(reason = 'auto') {
    try {
      const snap = {
        savedAt: Date.now(),
        reason,
        data: { ...state }
      };
      // Always overwrites the single previous snapshot (zero extra space)
      localStorage.setItem(AUTO_SNAPSHOT_KEY, JSON.stringify(snap));
      state.lastAutoSnapshotAt = snap.savedAt;
    } catch {}
  }

  function getAutoSnapshot() {
    try {
      const raw = localStorage.getItem(AUTO_SNAPSHOT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.data ? parsed : null;
    } catch {
      return null;
    }
  }

  function formatShortDate(ms) {
    if (!ms) return 'ще не було';
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }

  function hasAnyProgress() {
    return state.xp > 0 || state.completedLessons.length > 0 || state.passedExams.length > 0 || state.passedLevelExams.length > 0;
  }

  function checkAutoBackupTimers() {
    const now = Date.now();
    // Initialize baseline timestamp for existing users so first reminder fires after 7 days
    if (state.lastFileExportAt === 0 && hasAnyProgress()) {
      state.lastFileExportAt = now;
      saveState();
    }
    // Automatically refresh rolling internal snapshot once a week (overwrites old one)
    if (hasAnyProgress() && (now - (state.lastAutoSnapshotAt || 0) >= WEEK_MS)) {
      saveAutoSnapshot('weekly');
      saveState();
    }
  }

  function isWeeklyFileExportDue() {
    if (!state.weeklyBackupEnabled || !hasAnyProgress()) return false;
    const now = Date.now();
    if (state.backupSnoozeUntil && now < state.backupSnoozeUntil) return false;
    if (!state.lastFileExportAt) return false;
    return (now - state.lastFileExportAt) >= WEEK_MS;
  }

  async function exportProgressFile() {
    const jsonStr = JSON.stringify(state, null, 2);
    const filename = 'slovosk_backup.json';

    // Desktop Chrome progressive enhancement: lets user overwrite existing file directly
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'SlovoSK Backup JSON', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        state.lastFileExportAt = Date.now();
        state.backupSnoozeUntil = 0;
        saveAutoSnapshot('export');
        saveState();
        showToast('Копію прогресу збережено: slovosk_backup.json ✓');
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
      }
    }

    // Standard Android/iOS/Browser download with fixed filename
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    state.lastFileExportAt = Date.now();
    state.backupSnoozeUntil = 0;
    saveAutoSnapshot('export');
    saveState();
    showToast('Копію збережено: slovosk_backup.json ✓');
    return true;
  }

  function computeMissedPenalty(missedDays, goal) {
    const g = Math.max(10, Number(goal) || 60);
    if (missedDays < 2) return 0;
    const raw = missedDays === 2 ? g * 0.4 : g * 0.25 * (missedDays - 1);
    const rounded = Math.max(10, Math.round(raw / 5) * 5);
    return Math.min(g, rounded);
  }

  function syncDailyRollover(rerender = false) {
    const today = todayKey();
    let changed = false;

    if (!state.lastActiveDay) {
      state.lastActiveDay = state.streakDay || state.lastDay || today;
      changed = true;
    }

    const gap = daysBetweenKeys(state.lastActiveDay, today);
    const fullMissedDays = Math.max(0, gap - 1);
    const activeLearner = hasAnyProgress();

    if (state.lastDay !== today) {
      state.lastDay = today;
      state.dailyXp = 0;
      state.dailyPenalty = 0;
      if (fullMissedDays >= 1) {
        state.streak = 0;
      }
      if (activeLearner && fullMissedDays === 1) {
        state.missedDaysWarning = 1;
      } else if (activeLearner && fullMissedDays >= 2 && state.lastPenaltyDay !== today) {
        const penalty = computeMissedPenalty(fullMissedDays, state.dailyGoal);
        state.dailyPenalty = penalty;
        state.dailyXp = -penalty;
        state.missedDaysWarning = fullMissedDays;
        state.lastPenaltyDay = today;
      } else if (fullMissedDays === 0) {
        state.missedDaysWarning = 0;
      }
      changed = true;
    } else if (activeLearner) {
      // Same day check: if user hasn't studied today yet and missed 1+ days
      if (fullMissedDays === 1 && state.missedDaysWarning === 0 && state.lastActiveDay !== today) {
        state.missedDaysWarning = 1;
        changed = true;
      } else if (fullMissedDays >= 2 && state.lastPenaltyDay !== today && state.lastActiveDay !== today) {
        const penalty = computeMissedPenalty(fullMissedDays, state.dailyGoal);
        state.dailyPenalty = penalty;
        state.dailyXp = -penalty;
        state.missedDaysWarning = fullMissedDays;
        state.lastPenaltyDay = today;
        state.streak = 0;
        changed = true;
      }
    }

    if (changed) {
      saveState();
      if (rerender && activeTab === 'course' && !activeSession && !activeStory) {
        renderCourseTab(true);
      }
    }
    return changed;
  }

  function addXP(amount) {
    syncDailyRollover(false);
    const today = todayKey();
    state.xp = Math.max(0, state.xp + amount);
    state.dailyXp += amount;
    state.lastActiveDay = today;

    if (state.dailyXp >= 0) {
      state.missedDaysWarning = 0;
    }

    if (state.streakDay !== today) {
      const yesterday = todayKey(new Date(Date.now() - 86400000));
      if (state.streakDay === yesterday) state.streak += 1;
      else state.streak = 1;
      state.streakDay = today;
    }
    saveState();
  }

  // =====================================================
  // SMART SPACED REPETITION (SRS: 1 -> 3 -> 7 -> 14d)
  // =====================================================
  function srsMarkCorrect(wordId, isReviewSession = false) {
    if (!wordId) return;
    if (!state.knownWords.includes(wordId)) state.knownWords.push(wordId);
    const now = Date.now();
    const cur = state.srs[wordId];
    if (!cur) {
      state.srs[wordId] = { box: 1, nextReview: now + SRS_DAYS[1] * 86400000 };
    } else if (isReviewSession || cur.nextReview <= now) {
      const nextBox = Math.min(5, (cur.box || 0) + 1);
      state.srs[wordId] = { box: nextBox, nextReview: now + SRS_DAYS[nextBox] * 86400000 };
    }
    if (isReviewSession) {
      state.weakWords = state.weakWords.filter((id) => id !== wordId);
    }
  }

  function srsMarkWrong(wordId) {
    if (!wordId) return;
    if (!state.weakWords.includes(wordId)) state.weakWords.push(wordId);
    state.srs[wordId] = { box: 0, nextReview: Date.now() };
  }

  function getDueSrsWords() {
    const now = Date.now();
    return Object.keys(state.srs)
      .filter((id) => WORD_MAP[id] && state.srs[id].nextReview <= now)
      .sort((a, b) => (state.srs[a].box || 0) - (state.srs[b].box || 0))
      .map((id) => WORD_MAP[id]);
  }

  function updateSrsBadge() {
    const badge = document.getElementById('srs-nav-badge');
    if (!badge) return;
    const due = getDueSrsWords().length;
    if (due > 0) {
      badge.textContent = due > 99 ? '99+' : String(due);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // =====================================================
  // SOUND FX (Offline Web Audio API)
  // =====================================================
  const SoundFX = (() => {
    let ctx = null;
    function getCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function tone(freq, start, dur, type = 'sine', gainVal = 0.14) {
      if (!state.soundFx) return;
      const c = getCtx();
      if (!c) return;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, c.currentTime + start);
      gain.gain.setValueAtTime(gainVal, c.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(c.currentTime + start);
      osc.stop(c.currentTime + start + dur);
    }

    return {
      ok() {
        tone(523.25, 0, 0.11, 'triangle', 0.16);
        tone(659.25, 0.09, 0.18, 'triangle', 0.16);
      },
      bad() {
        tone(210, 0, 0.14, 'sawtooth', 0.11);
        tone(165, 0.12, 0.22, 'sawtooth', 0.11);
      },
      tap() {
        tone(440, 0, 0.04, 'sine', 0.06);
      },
      win() {
        tone(523.25, 0, 0.12, 'triangle', 0.16);
        tone(659.25, 0.11, 0.12, 'triangle', 0.16);
        tone(783.99, 0.22, 0.14, 'triangle', 0.16);
        tone(1046.5, 0.35, 0.32, 'triangle', 0.18);
      }
    };
  })();

  // =====================================================
  // ANDROID CHROME TTS ENGINE (sk-SK + uk-UA for Audio Mode)
  // =====================================================
  const SpeechEngine = (() => {
    const supported = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    let voices = [];
    let currentUtterance = null;
    let listeners = [];

    function refreshVoices() {
      if (!supported) return [];
      const list = window.speechSynthesis.getVoices() || [];
      if (list.length > 0) {
        voices = list;
        listeners.forEach((fn) => fn());
      }
      return voices;
    }

    if (supported) {
      refreshVoices();
      window.speechSynthesis.onvoiceschanged = refreshVoices;
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        refreshVoices();
        if (voices.length > 0 || tries >= 12) clearInterval(timer);
      }, 250);
    }

    function getSlovakVoices() {
      return voices.filter((v) => (v.lang || '').toLowerCase().startsWith('sk'));
    }

    function getUkrainianVoice() {
      const uk = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('uk'));
      return uk.find((v) => /google/i.test(v.name)) || uk[0] || null;
    }

    function pickBestVoice() {
      const skVoices = getSlovakVoices();
      if (state.preferredVoiceURI) {
        const chosen = voices.find((v) => v.voiceURI === state.preferredVoiceURI);
        if (chosen) return chosen;
      }
      if (skVoices.length > 0) {
        return skVoices.find((v) => /google/i.test(v.name)) || skVoices[0];
      }
      return voices.find((v) => (v.lang || '').toLowerCase().startsWith('cs')) || null;
    }

    function cancel() {
      if (!supported) return;
      try { window.speechSynthesis.cancel(); } catch {}
      currentUtterance = null;
    }

    function speak(text, slow = false, onDone = null) {
      if (!supported) {
        if (onDone) onDone();
        else showToast('Озвучка недоступна в цьому браузері. Відкрий у Chrome.');
        return false;
      }
      refreshVoices();
      cancel();
      const clean = String(text || '').trim();
      if (!clean) {
        if (onDone) onDone();
        return false;
      }
      setTimeout(() => {
        try {
          const u = new SpeechSynthesisUtterance(clean);
          u.lang = 'sk-SK';
          u.rate = slow ? 0.62 : 0.94;
          u.pitch = 1.0;
          const v = pickBestVoice();
          if (v) {
            u.voice = v;
            if ((v.lang || '').toLowerCase().startsWith('sk')) u.lang = v.lang;
          }
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            currentUtterance = null;
            if (onDone) onDone();
          };
          currentUtterance = u;
          u.onend = done;
          u.onerror = done;
          window.speechSynthesis.speak(u);
          // Safety fallback in case Android Chrome fails to fire onend
          if (onDone) setTimeout(done, Math.max(3500, clean.length * 140));
        } catch {
          if (onDone) onDone();
        }
      }, 45);
      return true;
    }

    function speakUk(text, onDone = null) {
      if (!supported) {
        if (onDone) onDone();
        return false;
      }
      refreshVoices();
      const ukVoice = getUkrainianVoice();
      if (!ukVoice) {
        // No Ukrainian voice installed: let caller wait visually instead of reading gibberish
        if (onDone) setTimeout(onDone, 1600);
        return false;
      }
      cancel();
      const clean = String(text || '').replace(/\s*\/\s*/g, ', ').trim();
      setTimeout(() => {
        try {
          const u = new SpeechSynthesisUtterance(clean);
          u.lang = ukVoice.lang || 'uk-UA';
          u.voice = ukVoice;
          u.rate = 0.96;
          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            currentUtterance = null;
            if (onDone) onDone();
          };
          currentUtterance = u;
          u.onend = done;
          u.onerror = done;
          window.speechSynthesis.speak(u);
          if (onDone) setTimeout(done, Math.max(3200, clean.length * 140));
        } catch {
          if (onDone) onDone();
        }
      }, 45);
      return true;
    }

    return {
      supported,
      refreshVoices,
      getAllVoices: () => voices,
      getSlovakVoices,
      getUkrainianVoice,
      pickBestVoice,
      speak,
      speakUk,
      cancel,
      onChange(fn) { listeners.push(fn); }
    };
  })();

  // =====================================================
  // MICROPHONE RECOGNITION (sk-SK)
  // =====================================================
  const MicEngine = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let activeRec = null;

    function stop() {
      if (activeRec) {
        try { activeRec.stop(); } catch {}
        activeRec = null;
      }
    }

    function listen(onResult, onError, onEnd) {
      if (!SR) {
        onError && onError('Мікрофон не підтримується в цьому браузері.');
        return;
      }
      stop();
      const rec = new SR();
      rec.lang = 'sk-SK';
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      activeRec = rec;

      rec.onresult = (e) => {
        const alts = [];
        for (let i = 0; i < e.results[0].length; i++) alts.push(e.results[0][i].transcript);
        onResult && onResult(alts[0] || '', alts);
      };
      rec.onerror = (e) => {
        let msg = 'Не вдалося розпізнати голос. Спробуй ще раз.';
        if (e.error === 'not-allowed') msg = 'Доступ до мікрофона заборонено в налаштуваннях браузера.';
        else if (e.error === 'no-speech') msg = 'Нічого не почув. Говори трохи голосніше.';
        else if (e.error === 'network') msg = 'Для розпізнавання голосу потрібен інтернет.';
        onError && onError(msg);
      };
      rec.onend = () => {
        activeRec = null;
        onEnd && onEnd();
      };
      try { rec.start(); } catch { onError && onError('Не вдалося запустити мікрофон.'); }
    }

    return { supported: !!SR, listen, stop };
  })();

  // =====================================================
  // UTILITIES
  // =====================================================
  function stripDiacritics(str) {
    return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function normStrict(str) {
    return String(str || '').toLowerCase().replace(/[.,!?;:«»"()—–-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function normLoose(str) {
    return normStrict(stripDiacritics(str));
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2700);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#131F24' : '#F4F7F9');
  }

  function updateHeader() {
    document.getElementById('stat-streak').textContent = state.streak;
    document.getElementById('stat-xp').textContent = state.xp;
    const hText = state.infiniteHearts ? '♾️' : String(state.hearts);
    document.getElementById('stat-hearts').textContent = hText;
    const lh = document.getElementById('lesson-hearts-val');
    if (lh) lh.textContent = hText;
  }

  // =====================================================
  // MODAL HELPERS
  // =====================================================
  const modalOverlay = document.getElementById('modal-overlay');
  const modalCard = document.getElementById('modal-card');

  function openModal(html, dismissible = true) {
    modalCard.innerHTML = html;
    modalOverlay.classList.remove('hidden');
    modalOverlay.dataset.dismissible = dismissible ? '1' : '0';
  }
  function closeModal() {
    modalOverlay.classList.add('hidden');
    modalCard.innerHTML = '';
  }
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay && modalOverlay.dataset.dismissible === '1') closeModal();
  });

  function openHeartsModal(fromZero = false) {
    const statusText = state.infiniteHearts
      ? 'Увімкнено режим <strong>♾️ Безкінечні серця</strong> — помилки не забирають серця.'
      : `Зараз у тебе <strong>${state.hearts} / 5 ❤️</strong>. Поновлення безкоштовне.`;
    openModal(`
      <h3>${fromZero ? '💔 Серця закінчилися!' : '❤️ Керування серцями'}</h3>
      <p class="muted" style="font-size:14px;margin-bottom:16px;">${statusText}</p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button class="btn btn-primary btn-full" id="m-refill-hearts">❤️ Поновити до 5/5 безкоштовно</button>
        <button class="btn btn-outline btn-full" id="m-toggle-inf">
          ${state.infiniteHearts ? 'Вимкнути безкінечні серця' : '♾️ Увімкнути безкінечні серця'}
        </button>
        ${fromZero
          ? `<button class="btn btn-outline btn-full" id="m-exit-lesson" style="color:var(--red);">Вийти з уроку</button>`
          : `<button class="btn btn-outline btn-full" id="m-close-hearts">Закрити</button>`
        }
      </div>
    `, !fromZero);

    document.getElementById('m-refill-hearts').onclick = () => {
      state.hearts = 5;
      saveState();
      SoundFX.ok();
      closeModal();
      showToast('Серця відновлено: 5/5 ❤️');
    };
    document.getElementById('m-toggle-inf').onclick = () => {
      state.infiniteHearts = !state.infiniteHearts;
      if (state.infiniteHearts) state.hearts = 5;
      saveState();
      SoundFX.ok();
      closeModal();
      showToast(state.infiniteHearts ? 'Безкінечні серця увімкнено ♾️' : 'Звичайний режим сердець');
    };
    const closeBtn = document.getElementById('m-close-hearts');
    if (closeBtn) closeBtn.onclick = closeModal;
    const exitBtn = document.getElementById('m-exit-lesson');
    if (exitBtn) exitBtn.onclick = () => { closeModal(); exitOverlay(); };
  }

  // =====================================================
  // UNLOCKING LOGIC (Strict Exam Gatekeeper per Section!)
  // =====================================================
  function getLevelSections(level) {
    if (level === 'ALL') return SECTIONS;
    return SECTIONS.filter((s) => s.level === level);
  }

  function getLevelExamRemaining(examId) {
    const cfg = getLevelExamConfig(examId);
    if (!cfg) return { sectionsLeft: 0, levelExamsLeft: 0 };
    if (cfg.level === 'ALL') {
      const sectionsLeft = SECTIONS.filter((s) => !state.passedExams.includes(s.id)).length;
      const reqLevels = getActiveLevelExams().filter((c) => c.level !== 'ALL');
      const levelExamsLeft = reqLevels.filter((c) => !state.passedLevelExams.includes(c.id)).length;
      return { sectionsLeft, levelExamsLeft };
    }
    const secs = getLevelSections(cfg.level);
    const sectionsLeft = secs.filter((s) => !state.passedExams.includes(s.id)).length;
    return { sectionsLeft, levelExamsLeft: 0 };
  }

  function isLevelExamUnlocked(examId) {
    if (state.freeUnlock) return true;
    const rem = getLevelExamRemaining(examId);
    return rem.sectionsLeft === 0 && rem.levelExamsLeft === 0;
  }

  function isSectionUnlocked(secIdx) {
    if (state.freeUnlock || secIdx === 0) return true;
    const prevSec = SECTIONS[secIdx - 1];
    const curSec = SECTIONS[secIdx];
    if (!state.passedExams.includes(prevSec.id)) return false;
    if (curSec && prevSec.level !== curSec.level) {
      const lvlExam = getLevelExamConfig('lvl_' + prevSec.level);
      if (lvlExam && !state.passedLevelExams.includes(lvlExam.id)) return false;
    }
    return true;
  }

  function isLessonUnlocked(secIdx, lesIdx) {
    if (state.freeUnlock) return true;
    if (!isSectionUnlocked(secIdx)) return false;
    if (lesIdx === 0) return true;
    const prevLesson = SECTIONS[secIdx].lessons[lesIdx - 1];
    return state.completedLessons.includes(prevLesson.id);
  }

  function areAllSectionLessonsDone(sec) {
    return sec.lessons.every((l) => state.completedLessons.includes(l.id));
  }

  function isExamUnlocked(secIdx) {
    if (state.freeUnlock) return true;
    return isSectionUnlocked(secIdx) && areAllSectionLessonsDone(SECTIONS[secIdx]);
  }

  function isStoryUnlocked(secIdx) {
    if (state.freeUnlock) return true;
    return isSectionUnlocked(secIdx) && areAllSectionLessonsDone(SECTIONS[secIdx]);
  }

  // =====================================================
  // NAVIGATION
  // =====================================================
  let activeTab = 'course';
  const mainView = document.getElementById('main-view');

  function setTab(tab) {
    stopAudioMode();
    MicEngine.stop();
    if (tab !== 'course' && progressEditMode) exitProgressEditMode();
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (tab === 'course') renderCourseTab();
    else if (tab === 'review') renderReviewTab();
    else if (tab === 'ai') renderAiTab();
    else if (tab === 'ref') renderRefTab();
    else if (tab === 'settings') renderSettingsTab();
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      SoundFX.tap();
      setTab(btn.dataset.tab);
    });
  });

  document.getElementById('btn-hearts-top').addEventListener('click', () => openHeartsModal(false));
  document.getElementById('btn-hearts-lesson').addEventListener('click', () => openHeartsModal(false));
  document.getElementById('btn-streak').addEventListener('click', () => {
    showToast(`Серія: ${state.streak} дн. Проходь хоча б 1 урок щодня!`);
  });
  document.getElementById('btn-xp').addEventListener('click', () => {
    showToast(`Сьогодні: ${state.dailyXp}/${state.dailyGoal} XP • Усього: ${state.xp} XP`);
  });

  // =====================================================
  // TAB 1: COURSE (Accordion + Levels A0/A1/A2 + Exams + Stories)
  // =====================================================
  const expandedSections = {}; // secId -> boolean
  let progressEditMode = false;
  let progressDraft = null; // { origLessons, origStories, origExams, lessons, stories, exams }

  function enterProgressEditMode() {
    progressEditMode = true;
    progressDraft = {
      origLessons: new Set(state.completedLessons),
      origStories: new Set(state.completedStories),
      origExams: new Set(state.passedExams),
      origLevelExams: new Set(state.passedLevelExams),
      lessons: new Set(state.completedLessons),
      stories: new Set(state.completedStories),
      exams: new Set(state.passedExams),
      levelExams: new Set(state.passedLevelExams)
    };
    mainView.classList.add('edit-active');
  }

  function exitProgressEditMode() {
    progressEditMode = false;
    progressDraft = null;
    mainView.classList.remove('edit-active');
    const bar = document.getElementById('edit-confirm-bar');
    if (bar) bar.remove();
  }

  function getProgressDraftDiff() {
    if (!progressDraft) {
      return {
        resetLessons: [], restoreLessons: [],
        resetStories: [], restoreStories: [],
        resetExams: [], restoreExams: [],
        resetLevelExams: [], restoreLevelExams: [],
        toReset: 0, toRestore: 0, total: 0
      };
    }
    const resetLessons = [...progressDraft.origLessons].filter((id) => !progressDraft.lessons.has(id));
    const restoreLessons = [...progressDraft.lessons].filter((id) => !progressDraft.origLessons.has(id));
    const resetStories = [...progressDraft.origStories].filter((id) => !progressDraft.stories.has(id));
    const restoreStories = [...progressDraft.stories].filter((id) => !progressDraft.origStories.has(id));
    const resetExams = [...progressDraft.origExams].filter((id) => !progressDraft.exams.has(id));
    const restoreExams = [...progressDraft.exams].filter((id) => !progressDraft.origExams.has(id));
    const resetLevelExams = [...progressDraft.origLevelExams].filter((id) => !progressDraft.levelExams.has(id));
    const restoreLevelExams = [...progressDraft.levelExams].filter((id) => !progressDraft.origLevelExams.has(id));
    const toReset = resetLessons.length + resetStories.length + resetExams.length + resetLevelExams.length;
    const toRestore = restoreLessons.length + restoreStories.length + restoreExams.length + restoreLevelExams.length;
    return {
      resetLessons, restoreLessons,
      resetStories, restoreStories,
      resetExams, restoreExams,
      resetLevelExams, restoreLevelExams,
      toReset, toRestore,
      total: toReset + toRestore
    };
  }

  function renderEditConfirmBar() {
    let bar = document.getElementById('edit-confirm-bar');
    if (!progressEditMode) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'edit-confirm-bar';
      bar.className = 'edit-confirm-bar';
      document.body.appendChild(bar);
    }
    const diff = getProgressDraftDiff();
    const summaryText = diff.total === 0
      ? 'Натисни на блок або урок'
      : [
          diff.toReset > 0 ? `<span style="color:var(--red);">↺ Скинути: ${diff.toReset}</span>` : '',
          diff.toRestore > 0 ? `<span style="color:var(--green);">✓ Повернути: ${diff.toRestore}</span>` : ''
        ].filter(Boolean).join(' • ');

    bar.innerHTML = `
      <div class="edit-confirm-inner">
        <div class="edit-confirm-info">${summaryText}</div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="btn btn-outline btn-sm" id="edit-bar-cancel">Скасувати</button>
          <button class="btn btn-primary btn-sm" id="edit-bar-confirm" ${diff.total === 0 ? 'disabled' : ''}>✓ Підтвердити${diff.total > 0 ? ` (${diff.total})` : ''}</button>
        </div>
      </div>
    `;

    document.getElementById('edit-bar-cancel').onclick = () => {
      SoundFX.tap();
      exitProgressEditMode();
      renderCourseTab();
    };
    document.getElementById('edit-bar-confirm').onclick = () => {
      if (diff.total === 0) return;
      openConfirmProgressModal(diff);
    };
  }

  function openConfirmProgressModal(diff) {
    const resetParts = [];
    if (diff.resetLessons.length) resetParts.push(`уроків: <strong>${diff.resetLessons.length}</strong>`);
    if (diff.resetStories.length) resetParts.push(`діалогів: <strong>${diff.resetStories.length}</strong>`);
    if (diff.resetExams.length) resetParts.push(`екзаменів: <strong>${diff.resetExams.length}</strong>`);
    if (diff.resetLevelExams.length) resetParts.push(`великих екзаменів: <strong>${diff.resetLevelExams.length}</strong>`);

    const restoreParts = [];
    if (diff.restoreLessons.length) restoreParts.push(`уроків: <strong>${diff.restoreLessons.length}</strong>`);
    if (diff.restoreStories.length) restoreParts.push(`діалогів: <strong>${diff.restoreStories.length}</strong>`);
    if (diff.restoreExams.length) restoreParts.push(`екзаменів: <strong>${diff.restoreExams.length}</strong>`);
    if (diff.restoreLevelExams.length) restoreParts.push(`великих екзаменів: <strong>${diff.restoreLevelExams.length}</strong>`);

    const levelExamsRollbackXp = diff.resetLevelExams.reduce((sum, id) => {
      const cfg = getLevelExamConfig(id);
      return sum + (cfg ? cfg.xp : 80);
    }, 0);
    const rollbackXp = (diff.resetLessons.length * XP_LESSON)
      + (diff.resetStories.length * XP_STORY)
      + (diff.resetExams.length * XP_EXAM)
      + levelExamsRollbackXp;

    openModal(`
      <h3>↺ Підтвердити зміни прогресу?</h3>
      <div class="card" style="background:var(--surface-2);margin:12px 0;">
        ${resetParts.length ? `<div style="margin-bottom:6px;color:var(--red);font-weight:700;">↺ Скинути: ${resetParts.join(', ')}</div>` : ''}
        ${restoreParts.length ? `<div style="color:var(--green);font-weight:700;">✓ Повернути (позначити пройденим): ${restoreParts.join(', ')}</div>` : ''}
      </div>
      ${rollbackXp > 0 ? `
        <label class="row-between" style="padding:6px 2px;cursor:pointer;gap:10px;">
          <span style="font-size:13px;">Відкотити XP за скинуті теми (<strong style="color:var(--red);">−${rollbackXp} XP</strong>)</span>
          <input type="checkbox" id="m-reset-xp-chk" checked style="width:20px;height:20px;accent-color:var(--red);" />
        </label>
      ` : ''}
      ${diff.resetLessons.length > 0 ? `
        <label class="row-between" style="padding:6px 2px 12px;cursor:pointer;gap:10px;">
          <span style="font-size:13px;">Також очистити слова й SRS для скинутих уроків</span>
          <input type="checkbox" id="m-reset-srs-chk" checked style="width:20px;height:20px;accent-color:var(--blue);" />
        </label>
      ` : ''}
      <p class="muted" style="font-size:12px;margin:6px 0 14px;">Перед збереженням додаток автоматично створить резервну копію (її можна відновити в Налаштуваннях).</p>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-full" id="m-edit-back">Назад</button>
        <button class="btn btn-primary btn-full" id="m-edit-apply">✓ Застосувати</button>
      </div>
    `);

    document.getElementById('m-edit-back').onclick = closeModal;
    document.getElementById('m-edit-apply').onclick = () => {
      const clearSrs = document.getElementById('m-reset-srs-chk')?.checked ?? true;
      const doRollbackXp = document.getElementById('m-reset-xp-chk')?.checked ?? false;
      // Save safety snapshot before modifying progress
      saveAutoSnapshot('pre-edit');

      state.completedLessons = [...progressDraft.lessons];
      state.completedStories = [...progressDraft.stories];
      state.passedExams = [...progressDraft.exams];
      state.passedLevelExams = [...progressDraft.levelExams];

      if (doRollbackXp && rollbackXp > 0) {
        state.xp = Math.max(0, state.xp - rollbackXp);
        const dailyFloor = state.dailyPenalty > 0 ? -state.dailyPenalty : 0;
        state.dailyXp = Math.max(dailyFloor, state.dailyXp - rollbackXp);
      }

      // Clean up words & SRS for reset lessons
      if (clearSrs && diff.resetLessons.length > 0) {
        const resetWordIds = new Set();
        diff.resetLessons.forEach((lesId) => {
          const les = ALL_LESSONS.find((l) => l.id === lesId);
          if (les) les.words.forEach((w) => resetWordIds.add(w.id));
        });
        state.knownWords = state.knownWords.filter((id) => !resetWordIds.has(id));
        state.weakWords = state.weakWords.filter((id) => !resetWordIds.has(id));
        resetWordIds.forEach((id) => { delete state.srs[id]; });
      }

      // Restore words & SRS for marked-done lessons
      if (diff.restoreLessons.length > 0) {
        const now = Date.now();
        diff.restoreLessons.forEach((lesId) => {
          const les = ALL_LESSONS.find((l) => l.id === lesId);
          if (!les) return;
          les.words.forEach((w) => {
            if (!state.knownWords.includes(w.id)) state.knownWords.push(w.id);
            if (!state.srs[w.id]) {
              state.srs[w.id] = { box: 1, nextReview: now + SRS_DAYS[1] * 86400000 };
            }
          });
        });
      }

      saveState();
      SoundFX.ok();
      closeModal();
      exitProgressEditMode();
      renderCourseTab();
      showToast('Прогрес успішно оновлено! ✓');
    };
  }

  function initAccordionDefaults() {
    let firstActiveFound = false;
    SECTIONS.forEach((sec, idx) => {
      if (sec.id in expandedSections) return;
      const passed = state.passedExams.includes(sec.id);
      const unlocked = isSectionUnlocked(idx);
      if (!passed && unlocked && !firstActiveFound) {
        expandedSections[sec.id] = true;
        firstActiveFound = true;
      } else {
        expandedSections[sec.id] = false;
      }
    });
    if (!firstActiveFound && SECTIONS.length > 0) {
      expandedSections[SECTIONS[SECTIONS.length - 1].id] = true;
    }
  }

  function renderCourseTab(preserveScroll = false) {
    const prevScroll = preserveScroll ? window.scrollY : 0;
    if (SECTIONS.length === 0) {
      mainView.innerHTML = `
        <div class="card" style="text-align:center;padding:24px;">
          <h3>Не знайдено жодного модуля</h3>
          <p class="muted">Перевір, щоб файл <strong>m1.js</strong> був завантажений поруч із index.html.</p>
        </div>
      `;
      return;
    }

    initAccordionDefaults();
    const isInDebt = state.dailyXp < 0;
    const dailyPct = isInDebt
      ? Math.min(100, Math.round((Math.abs(state.dailyXp) / Math.max(1, state.dailyPenalty || state.dailyGoal)) * 100))
      : Math.min(100, Math.round((state.dailyXp / Math.max(1, state.dailyGoal)) * 100));
    const knownCount = state.knownWords.filter((id) => WORD_MAP[id]).length;

    // Dynamic level order & word thresholds (A0 -> A1 -> A2 -> B1 -> B2)
    const LEVEL_ORDER = ['A0', 'A1', 'A2', 'B1', 'B2'];
    const lvlCounts = { ALL: SECTIONS.length, A0: 0, A1: 0, A2: 0, B1: 0, B2: 0 };
    const lvlWords = { A0: 0, A1: 0, A2: 0, B1: 0, B2: 0 };
    SECTIONS.forEach((s) => {
      if (lvlCounts[s.level] !== undefined) lvlCounts[s.level]++;
    });
    ALL_WORDS.forEach((w) => {
      if (lvlWords[w.level] !== undefined) lvlWords[w.level]++;
    });

    // Build cumulative milestones for smart level bar
    const milestones = [];
    let cum = 0;
    LEVEL_ORDER.forEach((lv) => {
      if (lvlWords[lv] > 0) {
        cum += lvlWords[lv];
        milestones.push({ level: lv, target: cum });
      }
    });
    let activeStage = milestones[milestones.length - 1] || { level: 'A1', target: Math.max(1, ALL_WORDS.length) };
    let achievedLevel = '';
    for (let i = 0; i < milestones.length; i++) {
      if (knownCount < milestones[i].target) {
        activeStage = milestones[i];
        achievedLevel = i > 0 ? milestones[i - 1].level : '';
        break;
      }
      achievedLevel = milestones[i].level;
    }
    const allDone = ALL_WORDS.length > 0 && knownCount >= ALL_WORDS.length;
    const stagePct = Math.min(100, Math.round((knownCount / Math.max(1, activeStage.target)) * 100));
    const stageRemain = Math.max(0, activeStage.target - knownCount);
    const stageTitle = allDone
      ? `🏆 Усі рівні пройдено (${achievedLevel})`
      : `📈 До рівня ${activeStage.level}${achievedLevel ? ` (закрито ${achievedLevel} ✓)` : ''}`;
    const stageRight = allDone
      ? `${knownCount} / ${ALL_WORDS.length} слів 🎉`
      : `${knownCount} / ${activeStage.target} слів (ще ${stageRemain})`;

    const visibleLevels = ['A0', 'A1', 'A2', 'B1'];
    if (lvlCounts.B2 > 0) visibleLevels.push('B2');
    if (state.levelFilter !== 'ALL' && !visibleLevels.includes(state.levelFilter)) {
      state.levelFilter = 'ALL';
    }

    const filteredSections = SECTIONS.map((s, idx) => ({ s, idx }))
      .filter(({ s }) => state.levelFilter === 'ALL' || s.level === state.levelFilter);

    const showWeeklyBanner = !progressEditMode && isWeeklyFileExportDue();
    const showMissedWarning = !progressEditMode && !isInDebt && state.missedDaysWarning === 1 && state.lastActiveDay !== todayKey();

    let html = '';

    if (isInDebt && !progressEditMode) {
      const needTotal = state.dailyGoal - state.dailyXp;
      html += `
        <div class="card missed-penalty-banner">
          <div style="font-weight:900;font-size:15px;color:var(--red);margin-bottom:4px;">🚨 Штраф за пропуск (${state.missedDaysWarning} дн.): ${state.dailyXp} XP</div>
          <div class="muted" style="font-size:13px;">Ти пропустив ${state.missedDaysWarning} ${state.missedDaysWarning >= 2 && state.missedDaysWarning <= 4 ? 'дні' : 'днів'} поспіль, тому денна XP пішла в мінус. Набери <strong>${Math.abs(state.dailyXp)} XP</strong>, щоб вийти в нуль (разом до норми: <strong>${needTotal} XP</strong>).</div>
        </div>
      `;
    } else if (showMissedWarning) {
      html += `
        <div class="card missed-warn-banner">
          <div style="font-weight:900;font-size:15px;color:var(--orange);margin-bottom:4px;">⚠️ Попередження: пропущено 1 день!</div>
          <div class="muted" style="font-size:13px;">Пройди хоча б один урок сьогодні — якщо пропустиш ще один день, завтра XP піде в мінус як покарання і доведеться наверстувати.</div>
        </div>
      `;
    }

    if (showWeeklyBanner) {
      html += `
        <div class="card weekly-backup-banner">
          <div style="font-weight:900;font-size:15px;margin-bottom:4px;">💾 Щотижнева резервна копія</div>
          <div class="muted" style="margin-bottom:10px;">Пройшов тиждень від останнього збереження. Експортуй свіжий файл <strong>slovosk_backup.json</strong> на телефон (~3 КБ).</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-blue btn-sm" id="weekly-export-now">⬇️ Зберегти зараз</button>
            <button class="btn btn-outline btn-sm" id="weekly-export-later">Пізніше</button>
          </div>
        </div>
      `;
    }

    html += `
      <div class="card goal-card">
        <div class="row-between">
          <div>
            <div style="font-weight:900;font-size:15px;">🎯 Ціль на сьогодні</div>
            <div class="muted">Модулів: <strong>${LOADED_MODULES.length}</strong> (${ALL_WORDS.length} слів) • Екзаменів: <strong>${state.passedExams.length}/${SECTIONS.length}</strong></div>
          </div>
          <div style="font-weight:900;color:${isInDebt ? 'var(--red)' : 'var(--green)'};font-size:15px;">${state.dailyXp} / ${state.dailyGoal} XP</div>
        </div>
        <div class="goal-bar"><div class="goal-fill ${isInDebt ? 'debt' : ''}" style="width:${dailyPct}%"></div></div>

        <div class="row-between" style="margin-top:12px;">
          <div class="muted" style="font-weight:700;">${stageTitle}</div>
          <div style="font-size:12.5px;font-weight:800;color:var(--blue);">${stageRight}</div>
        </div>
        <div class="goal-bar"><div class="goal-fill blue" style="width:${stagePct}%"></div></div>

        <div class="cert-strip" id="cert-strip">
          ${getActiveLevelExams().map((cfg) => {
            const passed = state.passedLevelExams.includes(cfg.id);
            const unlocked = isLevelExamUnlocked(cfg.id);
            const cls = passed ? 'passed' : (unlocked ? 'ready' : 'locked');
            return `<button type="button" class="cert-chip ${cls}" data-cert-exam="${cfg.id}" title="${escHtml(cfg.title)}">
              <span>${cfg.icon}</span>
              <span>${escHtml(cfg.badge)}</span>
              <span>${passed ? '✓' : (unlocked ? '▶' : '🔒')}</span>
            </button>`;
          }).join('')}
        </div>
      </div>

      <div class="level-tabs" id="level-tabs">
        <button class="level-tab ${state.levelFilter === 'ALL' ? 'active' : ''}" data-lvl="ALL" style="font-size:12px;padding:8px 3px;">Усі (${lvlCounts.ALL})</button>
        ${visibleLevels.map((lv) => `
          <button class="level-tab ${state.levelFilter === lv ? 'active' : ''}" data-lvl="${lv}" style="font-size:12px;padding:8px 3px;">${lv} (${lvlCounts[lv]})</button>
        `).join('')}
      </div>

      <div class="mode-toggle-bar">
        <div class="muted" style="font-weight:700;font-size:12px;">Екзамен: ≤1 помилка</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="chip-btn ${progressEditMode ? 'active edit-btn-on' : ''}" id="toggle-progress-edit" title="Скинути або повернути прогрес">
            ${progressEditMode ? '✕ Вийти' : '↺ Скинути'}
          </button>
          <button class="chip-btn ${state.freeUnlock ? 'active' : ''}" id="toggle-unlock-mode">
            ${state.freeUnlock ? '🔓 Вільно' : '🔒 По порядку'}
          </button>
        </div>
      </div>
    `;

    if (progressEditMode) {
      html += `
        <div class="card edit-mode-banner">
          <div style="font-weight:900;font-size:14px;color:var(--orange);margin-bottom:3px;">✏️ Режим редагування прогресу</div>
          <div class="muted" style="font-size:12.5px;">Вибирай цілий блок кнопкою на банері розділу або розкрий розділ і натискай на окремі уроки, діалоги чи екзамени, щоб <strong>скинути</strong> або <strong>повернути</strong> їх.</div>
        </div>
      `;
    }

    if (filteredSections.length === 0) {
      html += `
        <div class="card" style="text-align:center;padding:24px 16px;">
          <div style="font-size:34px;margin-bottom:8px;">📦</div>
          <div style="font-weight:900;font-size:16px;margin-bottom:6px;">Рівень ${escHtml(state.levelFilter)} поки не завантажено</div>
          <div class="muted">Коли будеш готовий, просто попроси наступний модуль (<strong>m${LOADED_MODULES.length + 1}.js</strong>) і закинь його на GitHub — прогрес збережеться автоматично.</div>
        </div>
      `;
    }

    function renderMajorExamCardHtml(cfg) {
      const levelExamSet = progressEditMode ? progressDraft.levelExams : new Set(state.passedLevelExams);
      const passed = levelExamSet.has(cfg.id);
      const unlocked = progressEditMode ? true : isLevelExamUnlocked(cfg.id);
      const secs = getLevelSections(cfg.level);
      const wordTotal = secs.reduce((sum, s) => sum + s.lessons.reduce((ls, l) => ls + l.words.length, 0), 0);
      const rem = getLevelExamRemaining(cfg.id);

      if (progressEditMode) {
        const wasDone = progressDraft.origLevelExams.has(cfg.id);
        const editCls = (wasDone && !passed) ? 'edit-will-reset' : ((!wasDone && passed) ? 'edit-will-restore' : (passed ? 'passed' : ''));
        const editTag = (wasDone && !passed) ? '↺ Скинути' : ((!wasDone && passed) ? '✓ Повернути' : (passed ? 'Складено' : 'Не складено'));
        return `
          <button type="button" class="major-exam-card ${cfg.themeClass} ${editCls}" data-edit-type="level_exam" data-edit-id="${cfg.id}">
            <div class="edit-checkbox ${passed ? 'checked' : ''} ${(wasDone && !passed) ? 'reset' : ''}">${passed ? '✓' : ''}</div>
            <div class="major-exam-meta">
              <div class="major-exam-kicker">${cfg.icon} ВЕЛИКИЙ ЕКЗАМЕН • ${cfg.questions} ПИТАНЬ</div>
              <div class="major-exam-title">${escHtml(cfg.title)}</div>
              <div class="major-exam-sub">Макс. ${cfg.maxMistakes} помилки • +${cfg.xp} XP</div>
            </div>
            <div class="major-exam-cta">${editTag}</div>
          </button>
        `;
      }

      const lockHint = cfg.level === 'ALL'
        ? `Залишилось розділів: ${rem.sectionsLeft}${rem.levelExamsLeft > 0 ? `, екзаменів рівнів: ${rem.levelExamsLeft}` : ''}`
        : `Спочатку склади всі розділи ${cfg.level} (залишилось: ${rem.sectionsLeft})`;

      return `
        <button type="button" class="major-exam-card ${cfg.themeClass} ${passed ? 'passed' : (unlocked ? 'ready' : 'locked')}"
          data-level-exam="${cfg.id}" ${unlocked ? '' : 'data-locked="1"'}>
          <div class="major-exam-icon">
            <span>${cfg.icon}</span>
            ${passed ? '<span class="lesson-check-badge">✓</span>' : ''}
          </div>
          <div class="major-exam-meta">
            <div class="major-exam-kicker">${cfg.level === 'ALL' ? 'ФІНАЛЬНА АТЕСТАЦІЯ КУРСУ' : `ЕКЗАМЕН РІВНЯ ${cfg.level}`} • ${cfg.questions} ПИТАНЬ</div>
            <div class="major-exam-title">${escHtml(cfg.title)}</div>
            <div class="major-exam-sub">${passed
              ? `Атестацію пройдено! База: ${wordTotal} слів • +${cfg.xp} XP`
              : (unlocked
                  ? `База: ${wordTotal} слів • Макс. ${cfg.maxMistakes} пом. • +${cfg.xp} XP`
                  : `🔒 ${lockHint}`
                )
            }</div>
          </div>
          <div class="major-exam-cta">${passed ? 'Складено ✓' : (unlocked ? 'Скласти' : '🔒')}</div>
        </button>
      `;
    }

    // Track last section index for each level to place checkpoint exam right after it
    const lastSecIdxByLevel = {};
    SECTIONS.forEach((s, i) => { lastSecIdxByLevel[s.level] = i; });

    filteredSections.forEach(({ s: sec, idx: secIdx }) => {
      const secUnlocked = progressEditMode ? true : isSectionUnlocked(secIdx);
      const examSet = progressEditMode ? progressDraft.exams : new Set(state.passedExams);
      const lessonSet = progressEditMode ? progressDraft.lessons : new Set(state.completedLessons);
      const storySet = progressEditMode ? progressDraft.stories : new Set(state.completedStories);

      const examPassed = examSet.has(sec.id);
      const doneLessonsInSec = sec.lessons.filter((l) => lessonSet.has(l.id)).length;
      const isOpen = !!expandedSections[sec.id];

      // Block-level stats for Edit Mode
      const blockCheckedCount = doneLessonsInSec + (sec.story && storySet.has(sec.story.id) ? 1 : 0) + (examPassed ? 1 : 0);
      const blockHasChanges = progressEditMode && (
        sec.lessons.some((l) => progressDraft.lessons.has(l.id) !== progressDraft.origLessons.has(l.id)) ||
        (sec.story && progressDraft.stories.has(sec.story.id) !== progressDraft.origStories.has(sec.story.id)) ||
        (progressDraft.exams.has(sec.id) !== progressDraft.origExams.has(sec.id))
      );

      let lockLabel = '🔒 Склади попередній екзамен';
      if (!secUnlocked && secIdx > 0) {
        const prevSec = SECTIONS[secIdx - 1];
        if (prevSec.level !== sec.level && state.passedExams.includes(prevSec.id)) {
          lockLabel = `🔒 Склади Великий екзамен ${prevSec.level}`;
        }
      }
      const statusLabel = examPassed
        ? 'Складено ✅'
        : (secUnlocked ? `${doneLessonsInSec}/${sec.lessons.length} уроків` : lockLabel);

      html += `
        <div class="section-wrap">
          <div class="section-banner ${secUnlocked ? '' : 'sec-locked'} ${blockHasChanges ? 'sec-edited' : ''}" style="background:${sec.color};" data-toggle-sec="${sec.id}" role="button" tabindex="0">
            <div style="min-width:0;flex:1;">
              <div class="sec-top-tags">
                <span class="sec-lvl-pill">${escHtml(sec.level)}</span>
                <span class="sec-lvl-pill">${statusLabel}</span>
                ${blockHasChanges ? '<span class="sec-lvl-pill" style="background:rgba(0,0,0,0.45);">✏️ змінено</span>' : ''}
              </div>
              <h2>${escHtml(sec.title)}</h2>
              <p>${escHtml(sec.subtitle)}</p>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              ${progressEditMode ? `
                <button type="button" class="sec-block-btn ${blockCheckedCount > 0 ? 'reset' : 'restore'}" data-block-toggle="${sec.id}">
                  ${blockCheckedCount > 0 ? '↺ Скинути блок' : '✓ Повернути блок'}
                </button>
              ` : ''}
              <span class="sec-chevron">${isOpen ? '▾' : '▸'}</span>
            </div>
          </div>
      `;

      if (isOpen) {
        html += `<div class="lesson-list">`;

        // 4 Lessons
        sec.lessons.forEach((les, lesIdx) => {
          const done = lessonSet.has(les.id);
          const gramTag = (les.grammar && les.grammar.length) ? ' • Граматика' : '';

          if (progressEditMode) {
            const wasDone = progressDraft.origLessons.has(les.id);
            const editCls = (wasDone && !done) ? 'edit-will-reset' : ((!wasDone && done) ? 'edit-will-restore' : (done ? 'done' : ''));
            const editTag = (wasDone && !done) ? '↺ Скинути' : ((!wasDone && done) ? '✓ Повернути' : (done ? 'Пройдено' : 'Не пройдено'));
            html += `
              <button class="lesson-card ${editCls}" data-edit-type="lesson" data-edit-id="${les.id}">
                <div class="edit-checkbox ${done ? 'checked' : ''} ${(wasDone && !done) ? 'reset' : ''}">${done ? '✓' : ''}</div>
                <div class="lesson-meta">
                  <div class="lesson-code">Урок ${escHtml(les.code)} • 6 слів${gramTag}</div>
                  <div class="lesson-title">${escHtml(les.title)}</div>
                </div>
                <div class="lesson-action-tag">${editTag}</div>
              </button>
            `;
          } else {
            const unlocked = isLessonUnlocked(secIdx, lesIdx);
            const isNext = unlocked && !done;
            const cls = done ? 'done' : (isNext ? 'next-up' : (!unlocked ? 'locked' : ''));
            const actionTag = done ? 'Повторити' : (unlocked ? 'Старт' : '🔒');
            html += `
              <button class="lesson-card ${cls}" data-lesson-id="${les.id}" ${unlocked ? '' : 'data-locked="1"'}>
                <div class="lesson-icon-box">
                  <span>${les.icon}</span>
                  ${done ? '<span class="lesson-check-badge">✓</span>' : ''}
                </div>
                <div class="lesson-meta">
                  <div class="lesson-code">Урок ${escHtml(les.code)} • 6 слів${gramTag}</div>
                  <div class="lesson-title">${escHtml(les.title)}</div>
                  <div class="lesson-desc">${escHtml(les.desc)}</div>
                </div>
                <div class="lesson-action-tag">${actionTag}</div>
              </button>
            `;
          }
        });

        // Mini-Dialogue Story Card
        if (sec.story) {
          const stDone = storySet.has(sec.story.id);
          if (progressEditMode) {
            const wasDone = progressDraft.origStories.has(sec.story.id);
            const editCls = (wasDone && !stDone) ? 'edit-will-reset' : ((!wasDone && stDone) ? 'edit-will-restore' : (stDone ? 'done' : ''));
            const editTag = (wasDone && !stDone) ? '↺ Скинути' : ((!wasDone && stDone) ? '✓ Повернути' : (stDone ? 'Пройдено' : 'Не пройдено'));
            html += `
              <button class="lesson-card story-card ${editCls}" data-edit-type="story" data-edit-id="${sec.story.id}">
                <div class="edit-checkbox ${stDone ? 'checked' : ''} ${(wasDone && !stDone) ? 'reset' : ''}">${stDone ? '✓' : ''}</div>
                <div class="lesson-meta">
                  <div class="lesson-code">Міні-діалог</div>
                  <div class="lesson-title">${escHtml(sec.story.title)}</div>
                </div>
                <div class="lesson-action-tag">${editTag}</div>
              </button>
            `;
          } else {
            const stUnlocked = isStoryUnlocked(secIdx);
            html += `
              <button class="lesson-card story-card ${stDone ? 'done' : ''} ${stUnlocked ? '' : 'locked'}"
                data-story-sec="${sec.id}" ${stUnlocked ? '' : 'data-locked="1"'}>
                <div class="lesson-icon-box">
                  <span>${sec.story.icon || '💬'}</span>
                  ${stDone ? '<span class="lesson-check-badge">✓</span>' : ''}
                </div>
                <div class="lesson-meta">
                  <div class="lesson-code">Міні-діалог • +15 XP</div>
                  <div class="lesson-title">${escHtml(sec.story.title)}</div>
                  <div class="lesson-desc">${escHtml(sec.story.desc)}</div>
                </div>
                <div class="lesson-action-tag">${stDone ? 'Ще раз' : (stUnlocked ? 'Читати' : '🔒')}</div>
              </button>
            `;
          }
        }

        // Section Exam Card (Max 1 mistake!)
        if (progressEditMode) {
          const wasDone = progressDraft.origExams.has(sec.id);
          const editCls = (wasDone && !examPassed) ? 'edit-will-reset' : ((!wasDone && examPassed) ? 'edit-will-restore' : (examPassed ? 'done' : ''));
          const editTag = (wasDone && !examPassed) ? '↺ Скинути' : ((!wasDone && examPassed) ? '✓ Повернути' : (examPassed ? 'Складено' : 'Не складено'));
          html += `
            <button class="lesson-card exam-card ${editCls}" data-edit-type="exam" data-edit-id="${sec.id}">
              <div class="edit-checkbox ${examPassed ? 'checked' : ''} ${(wasDone && !examPassed) ? 'reset' : ''}">${examPassed ? '✓' : ''}</div>
              <div class="lesson-meta">
                <div class="lesson-code">Екзамен розділу</div>
                <div class="lesson-title">Перевірка знань (${sec.lessons.length * 6} слів)</div>
              </div>
              <div class="lesson-action-tag">${editTag}</div>
            </button>
          `;
        } else {
          const exUnlocked = isExamUnlocked(secIdx);
          html += `
            <button class="lesson-card exam-card ${examPassed ? 'done' : ''} ${exUnlocked ? '' : 'locked'}"
              data-exam-sec="${sec.id}" ${exUnlocked ? '' : 'data-locked="1"'}>
              <div class="lesson-icon-box">
                <span>🎓</span>
                ${examPassed ? '<span class="lesson-check-badge">✓</span>' : ''}
              </div>
              <div class="lesson-meta">
                <div class="lesson-code">Екзамен розділу • Макс. 1 помилка</div>
                <div class="lesson-title">Перевірка знань (${sec.lessons.length * 6} слів)</div>
                <div class="lesson-desc">${examPassed ? 'Розділ успішно складено! Наступна тема відкрита.' : 'Склади тест (до 1 помилки), щоб відкрити наступний розділ'}</div>
              </div>
              <div class="lesson-action-tag">${examPassed ? 'Складено' : (exUnlocked ? 'Скласти' : '🔒')}</div>
            </button>
          `;
        }

        html += `</div>`;
      }
      html += `</div>`;

      // Place Major Level Exam right after the last section of A0, A1, A2
      if (lastSecIdxByLevel[sec.level] === secIdx) {
        const lvlCfg = getLevelExamConfig('lvl_' + sec.level);
        if (lvlCfg) {
          html += renderMajorExamCardHtml(lvlCfg);
        }
      }
    });

    // Place Grand Comprehensive Final Exam at the very end (in 'ALL' and 'B1' tabs)
    const finalCfg = getLevelExamConfig('lvl_FINAL');
    if (finalCfg && SECTIONS.length > 0 && (state.levelFilter === 'ALL' || state.levelFilter === 'B1')) {
      html += renderMajorExamCardHtml(finalCfg);
    }

    mainView.innerHTML = html;
    renderEditConfirmBar();
    if (preserveScroll) window.scrollTo({ top: prevScroll, behavior: 'instant' });

    // Weekly export banner handlers
    const wNow = document.getElementById('weekly-export-now');
    if (wNow) {
      wNow.onclick = async () => {
        await exportProgressFile();
        renderCourseTab(true);
      };
    }
    const wLater = document.getElementById('weekly-export-later');
    if (wLater) {
      wLater.onclick = () => {
        state.backupSnoozeUntil = Date.now() + 86400000;
        saveState();
        renderCourseTab(true);
        showToast('Нагадаємо завтра 👍');
      };
    }

    // Bind events
    document.getElementById('level-tabs').querySelectorAll('.level-tab').forEach((b) => {
      b.onclick = () => {
        state.levelFilter = b.dataset.lvl;
        saveState();
        SoundFX.tap();
        renderCourseTab();
      };
    });

    document.getElementById('toggle-progress-edit').onclick = () => {
      SoundFX.tap();
      if (progressEditMode) exitProgressEditMode();
      else enterProgressEditMode();
      renderCourseTab(true);
    };

    document.getElementById('toggle-unlock-mode').onclick = () => {
      state.freeUnlock = !state.freeUnlock;
      saveState();
      SoundFX.tap();
      renderCourseTab(true);
      showToast(state.freeUnlock ? 'Вільний доступ увімкнено' : 'Сувора хронологія + екзамени');
    };

    mainView.querySelectorAll('[data-block-toggle]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (!progressEditMode) return;
        SoundFX.tap();
        const sid = btn.dataset.blockToggle;
        const sec = SECTIONS.find((s) => s.id === sid);
        if (!sec) return;
        const anyChecked =
          sec.lessons.some((l) => progressDraft.lessons.has(l.id)) ||
          (sec.story && progressDraft.stories.has(sec.story.id)) ||
          progressDraft.exams.has(sec.id);

        if (anyChecked) {
          sec.lessons.forEach((l) => progressDraft.lessons.delete(l.id));
          if (sec.story) progressDraft.stories.delete(sec.story.id);
          progressDraft.exams.delete(sec.id);
        } else {
          sec.lessons.forEach((l) => progressDraft.lessons.add(l.id));
          if (sec.story) progressDraft.stories.add(sec.story.id);
          progressDraft.exams.add(sec.id);
        }
        renderCourseTab(true);
      };
    });

    mainView.querySelectorAll('[data-toggle-sec]').forEach((b) => {
      b.onclick = () => {
        const sid = b.dataset.toggleSec;
        expandedSections[sid] = !expandedSections[sid];
        SoundFX.tap();
        renderCourseTab(true);
      };
    });

    mainView.querySelectorAll('[data-cert-exam]').forEach((btn) => {
      btn.onclick = () => {
        if (progressEditMode) {
          showToast('Спочатку вийди з режиму редагування');
          return;
        }
        SoundFX.tap();
        openMajorExamModal(btn.dataset.certExam);
      };
    });

    if (progressEditMode) {
      mainView.querySelectorAll('[data-edit-type]').forEach((card) => {
        card.onclick = () => {
          SoundFX.tap();
          const t = card.dataset.editType;
          const id = card.dataset.editId;
          const targetSet = t === 'lesson'
            ? progressDraft.lessons
            : (t === 'story' ? progressDraft.stories : (t === 'level_exam' ? progressDraft.levelExams : progressDraft.exams));
          if (targetSet.has(id)) targetSet.delete(id);
          else targetSet.add(id);
          renderCourseTab(true);
        };
      });
    } else {
      mainView.querySelectorAll('[data-level-exam]').forEach((card) => {
        card.onclick = () => {
          SoundFX.tap();
          openMajorExamModal(card.dataset.levelExam);
        };
      });
      mainView.querySelectorAll('[data-lesson-id]').forEach((card) => {
        card.onclick = () => {
          if (card.dataset.locked === '1') {
            showToast('Спочатку пройди попередній урок або екзамен розділу!');
            return;
          }
          startLesson(card.dataset.lessonId);
        };
      });

      mainView.querySelectorAll('[data-story-sec]').forEach((card) => {
        card.onclick = () => {
          if (card.dataset.locked === '1') {
            showToast('Спочатку пройди всі 4 уроки цього розділу!');
            return;
          }
          const sec = SECTIONS.find((s) => s.id === card.dataset.storySec);
          if (sec && sec.story) startStory(sec);
        };
      });

      mainView.querySelectorAll('[data-exam-sec]').forEach((card) => {
        card.onclick = () => {
          if (card.dataset.locked === '1') {
            showToast('Спочатку заверши всі 4 уроки розділу, щоб відкрити екзамен!');
            return;
          }
          const sec = SECTIONS.find((s) => s.id === card.dataset.examSec);
          if (sec) startSectionExam(sec);
        };
      });
    }
  }

  // =====================================================
  // LESSON + EXAM ENGINE
  // =====================================================
  let activeSession = null; // { mode: 'lesson'|'exam'|'srs'|'custom', ... }

  function pickDistractors(correctWord, pool, count = 3) {
    const others = pool.filter((w) => w.id !== correctWord.id && w.uk !== correctWord.uk && w.sk !== correctWord.sk);
    const chosen = shuffle(others).slice(0, count);
    if (chosen.length < count) {
      const extra = shuffle(ALL_WORDS.filter((w) => w.id !== correctWord.id && !chosen.some((c) => c.id === w.id)));
      while (chosen.length < count && extra.length) chosen.push(extra.pop());
    }
    return chosen;
  }

  function buildLessonQueue(lesson) {
    const w = lesson.words;
    const g1 = w.slice(0, 3);
    const g2 = w.slice(3, 6);
    const q = [];

    // Stage 1: Intro words 1..3
    g1.forEach((word) => q.push({ type: 'intro', word }));
    // Stage 2: Drill words 1..3 ONLY
    q.push({ type: 'mc_sk_uk', word: g1[0], pool: w });
    q.push({ type: 'mc_uk_sk', word: g1[1], pool: w });
    q.push({ type: SpeechEngine.supported ? 'listen_mc' : 'mc_sk_uk', word: g1[2], pool: w });
    q.push({ type: 'mc_uk_sk', word: g1[0], pool: w });

    // Stage 3: Intro words 4..6 + drill
    g2.forEach((word) => q.push({ type: 'intro', word }));
    q.push({ type: 'mc_sk_uk', word: g2[0], pool: w });
    q.push({ type: 'mc_uk_sk', word: g2[1], pool: w });
    q.push({ type: SpeechEngine.supported ? 'listen_mc' : 'mc_sk_uk', word: g2[2], pool: w });

    // Match all 6 words
    q.push({ type: 'match_pairs', words: w });

    // Stage 4: Grammar drills (if any) + Sentences + Typing + Mic
    (lesson.grammar || []).forEach((g) => q.push({ type: 'grammar', gram: g }));

    const sents = lesson.sentences || [];
    if (sents[0]) q.push({ type: 'word_bank', sentence: sents[0], lessonWords: w });
    if (sents[1]) q.push({ type: 'word_bank', sentence: sents[1], lessonWords: w });

    q.push({ type: 'typing', word: shuffle(w)[0] });

    if (state.micEnabled && MicEngine.supported && sents[2]) {
      q.push({ type: 'speak', sentence: sents[2] });
    } else if (sents[2]) {
      q.push({ type: 'word_bank', sentence: sents[2], lessonWords: w });
    }
    return q;
  }

  function buildExamQueue(sec) {
    const secWords = [];
    const secGrams = [];
    const secSents = [];
    sec.lessons.forEach((l) => {
      secWords.push(...l.words);
      if (l.grammar) secGrams.push(...l.grammar);
      if (l.sentences) secSents.push(...l.sentences);
    });

    const pickedWords = shuffle(secWords);
    const q = [];

    // 4 SK->UK, 3 UK->SK, 2 Listening (or SK->UK), 1-2 Grammar, 1 Word Bank, 1 Typing = 12 strict questions
    for (let i = 0; i < 4 && pickedWords[i]; i++) {
      q.push({ type: 'mc_sk_uk', word: pickedWords[i], pool: secWords });
    }
    for (let i = 4; i < 7 && pickedWords[i]; i++) {
      q.push({ type: 'mc_uk_sk', word: pickedWords[i], pool: secWords });
    }
    for (let i = 7; i < 9 && pickedWords[i]; i++) {
      q.push({ type: SpeechEngine.supported ? 'listen_mc' : 'mc_sk_uk', word: pickedWords[i], pool: secWords });
    }
    if (secGrams.length > 0) {
      shuffle(secGrams).slice(0, 1).forEach((g) => q.push({ type: 'grammar', gram: g }));
    } else if (pickedWords[9]) {
      q.push({ type: 'mc_uk_sk', word: pickedWords[9], pool: secWords });
    }
    if (secSents.length > 0) {
      q.push({ type: 'word_bank', sentence: shuffle(secSents)[0], lessonWords: secWords });
    }
    if (pickedWords[10]) {
      q.push({ type: 'typing', word: pickedWords[10] });
    }
    return shuffle(q);
  }

  function buildMajorExamQueue(targetSections, totalQuestions) {
    // Stratified sampling across all target sections so every topic is represented
    const secWordBuckets = targetSections.map((s) => shuffle(s.lessons.flatMap((l) => l.words))).filter((b) => b.length > 0);
    const allPoolWords = targetSections.flatMap((s) => s.lessons.flatMap((l) => l.words));
    const secGramBuckets = targetSections.map((s) => shuffle(s.lessons.flatMap((l) => l.grammar || []))).filter((b) => b.length > 0);
    const secSentBuckets = targetSections.map((s) => shuffle(s.lessons.flatMap((l) => l.sentences || []))).filter((b) => b.length > 0);

    function drawStratified(buckets, count) {
      const result = [];
      const order = shuffle(buckets.map((b) => b.slice()));
      let guard = 0;
      while (result.length < count && order.length > 0 && guard < count * 5) {
        guard++;
        for (let i = order.length - 1; i >= 0 && result.length < count; i--) {
          if (order[i].length > 0) result.push(order[i].pop());
          else order.splice(i, 1);
        }
      }
      return result;
    }

    const n = Math.min(totalQuestions, Math.max(10, allPoolWords.length));
    const gramTarget = Math.min(secGramBuckets.reduce((a, b) => a + b.length, 0), Math.max(2, Math.round(n * 0.12)));
    const sentTarget = Math.min(secSentBuckets.reduce((a, b) => a + b.length, 0), Math.max(2, Math.round(n * 0.12)));
    const typingTarget = Math.max(2, Math.round(n * 0.12));
    const wordQuestionsNeeded = Math.max(4, n - gramTarget - sentTarget);

    const chosenWords = drawStratified(secWordBuckets, wordQuestionsNeeded);
    const chosenGrams = drawStratified(secGramBuckets, gramTarget);
    const chosenSents = drawStratified(secSentBuckets, sentTarget);

    const q = [];
    const listenTarget = SpeechEngine.supported ? Math.max(2, Math.round(chosenWords.length * 0.22)) : 0;
    const ukSkTarget = Math.max(2, Math.round(chosenWords.length * 0.34));
    const actualTyping = Math.min(typingTarget, Math.max(1, chosenWords.length - listenTarget - ukSkTarget - 2));

    let wi = 0;
    for (let i = 0; i < actualTyping && chosenWords[wi]; i++, wi++) {
      q.push({ type: 'typing', word: chosenWords[wi] });
    }
    for (let i = 0; i < listenTarget && chosenWords[wi]; i++, wi++) {
      q.push({ type: 'listen_mc', word: chosenWords[wi], pool: allPoolWords });
    }
    for (let i = 0; i < ukSkTarget && chosenWords[wi]; i++, wi++) {
      q.push({ type: 'mc_uk_sk', word: chosenWords[wi], pool: allPoolWords });
    }
    while (chosenWords[wi]) {
      q.push({ type: 'mc_sk_uk', word: chosenWords[wi], pool: allPoolWords });
      wi++;
    }
    chosenGrams.forEach((g) => q.push({ type: 'grammar', gram: g }));
    chosenSents.forEach((s) => q.push({ type: 'word_bank', sentence: s, lessonWords: allPoolWords }));

    return shuffle(q);
  }

  function launchMajorExamSession(cfg, targetSections, isPracticeOnly = false) {
    const studiedWordCnt = targetSections.reduce((sum, s) => sum + s.lessons.reduce((ls, l) => ls + l.words.length, 0), 0);
    const qCount = isPracticeOnly
      ? Math.min(40, Math.max(16, Math.round(studiedWordCnt * 0.4)))
      : cfg.questions;
    const maxErr = isPracticeOnly
      ? Math.max(2, Math.round(qCount * 0.1))
      : cfg.maxMistakes;
    const xpReward = isPracticeOnly ? 40 : cfg.xp;

    activeStory = null;
    activeSession = {
      mode: 'exam',
      examKind: 'major',
      examConfig: cfg,
      targetSections,
      isPracticeOnly,
      id: cfg.id,
      title: isPracticeOnly ? 'Пробний мега-екзамен (по вивченому)' : cfg.title,
      queue: buildMajorExamQueue(targetSections, qCount),
      idx: 0,
      mistakes: 0,
      maxMistakes: maxErr,
      examXp: xpReward,
      missedWords: [],
      xpEarned: 0,
      selection: null,
      checked: false
    };
    openOverlayUI(true, maxErr);
    renderCurrentExercise();
  }

  function openMajorExamModal(examId) {
    const cfg = getLevelExamConfig(examId);
    if (!cfg) return;
    const unlocked = isLevelExamUnlocked(cfg.id);
    const passed = state.passedLevelExams.includes(cfg.id);
    const secs = getLevelSections(cfg.level);
    const wordTotal = secs.reduce((sum, s) => sum + s.lessons.reduce((ls, l) => ls + l.words.length, 0), 0);
    const rem = getLevelExamRemaining(cfg.id);

    // Sections where user already completed at least 1 lesson (for practice mega-exam on studied material)
    const studiedSecs = SECTIONS
      .map((s) => ({ ...s, lessons: s.lessons.filter((l) => state.completedLessons.includes(l.id)) }))
      .filter((s) => s.lessons.length > 0);
    const studiedLessonsCount = state.completedLessons.length;
    const canPracticeStudied = cfg.level === 'ALL' && studiedLessonsCount >= 4 && !unlocked;

    if (!unlocked) {
      const needText = cfg.level === 'ALL'
        ? `Щоб відкрити офіційний фінальний мега-екзамен, заверши всі розділи курсу (залишилось розділів: <strong>${rem.sectionsLeft}</strong>${rem.levelExamsLeft > 0 ? `, великих екзаменів рівнів: <strong>${rem.levelExamsLeft}</strong>` : ''}).`
        : `Щоб відкрити <strong>${escHtml(cfg.title)}</strong>, спочатку склади екзамени всіх розділів рівня ${cfg.level} (залишилось: <strong>${rem.sectionsLeft}</strong>).`;

      openModal(`
        <h3>${cfg.icon} ${escHtml(cfg.title)}</h3>
        <p class="muted" style="font-size:14px;margin-bottom:14px;">${needText}</p>
        <div class="card" style="background:var(--surface-2);font-size:13px;margin-bottom:14px;">
          <div>• Питань: <strong>${cfg.questions}</strong> (з бази ${wordTotal} слів)</div>
          <div>• Ліміт помилок: <strong>макс. ${cfg.maxMistakes}</strong></div>
          <div>• Нагорода: <strong>+${cfg.xp} XP</strong> і сертифікат <strong>${escHtml(cfg.badge)}</strong></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${canPracticeStudied ? `<button class="btn btn-blue btn-full" id="m-maj-studied">🧪 Пробний мега-екзамен по вивченому (${studiedLessonsCount * 6} слів)</button>` : ''}
          <button class="btn btn-outline btn-full" id="m-maj-close">Зрозуміло</button>
        </div>
      `);
      document.getElementById('m-maj-close').onclick = closeModal;
      const stBtn = document.getElementById('m-maj-studied');
      if (stBtn) {
        stBtn.onclick = () => {
          closeModal();
          launchMajorExamSession(cfg, studiedSecs, true);
        };
      }
      return;
    }

    const showStudiedOption = cfg.level === 'ALL' && studiedLessonsCount >= 4 && rem.sectionsLeft > 0;
    openModal(`
      <h3>${cfg.icon} ${escHtml(cfg.title)}</h3>
      <p class="muted" style="font-size:13.5px;margin-bottom:12px;">${escHtml(cfg.subtitle)}</p>
      <div class="card" style="background:var(--surface-2);font-size:13.5px;margin-bottom:14px;">
        <div>📚 Охоплення: <strong>${secs.length} розд. (${wordTotal} слів)</strong></div>
        <div>📝 Кількість питань: <strong>${cfg.questions}</strong> (переклад, аудіо, граматика, речення, письмо)</div>
        <div>🎯 Поріг складання: <strong>макс. ${cfg.maxMistakes} ${cfg.maxMistakes === 1 ? 'помилка' : (cfg.maxMistakes <= 4 ? 'помилки' : 'помилок')}</strong></div>
        <div>⚡ Нагорода: <strong>+${cfg.xp} XP</strong> ${passed ? '(вже складено ✓)' : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-orange btn-full" id="m-maj-start">${passed ? '🔁 ПЕРЕСКЛАСТИ ЕКЗАМЕН' : '🚀 ПОЧАТИ ВЕЛИКИЙ ЕКЗАМЕН'}</button>
        ${showStudiedOption ? `<button class="btn btn-blue btn-full" id="m-maj-studied">🧪 Тільки по моїх пройдених темах (${studiedLessonsCount * 6} слів)</button>` : ''}
        <button class="btn btn-outline btn-full" id="m-maj-cancel">Повернутися</button>
      </div>
    `);
    document.getElementById('m-maj-cancel').onclick = closeModal;
    document.getElementById('m-maj-start').onclick = () => {
      closeModal();
      launchMajorExamSession(cfg, secs, false);
    };
    const stBtn = document.getElementById('m-maj-studied');
    if (stBtn) {
      stBtn.onclick = () => {
        closeModal();
        launchMajorExamSession(cfg, studiedSecs, true);
      };
    }
  }

  function openOverlayUI(isExam, maxMistakes = 1) {
    const overlay = document.getElementById('lesson-overlay');
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('btn-hearts-lesson').classList.toggle('hidden', isExam);
    const ep = document.getElementById('exam-err-pill');
    ep.classList.toggle('hidden', !isExam);
    if (isExam) {
      ep.classList.remove('danger');
      document.getElementById('exam-err-val').textContent = `0/${maxMistakes}`;
    }
    updateHeader();
  }

  function exitOverlay() {
    MicEngine.stop();
    SpeechEngine.cancel();
    hideFeedback();
    const overlay = document.getElementById('lesson-overlay');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    activeSession = null;
    activeStory = null;
    if (activeTab === 'course') renderCourseTab();
    else if (activeTab === 'review') renderReviewTab();
  }

  document.getElementById('lesson-close').onclick = exitOverlay;

  function startLesson(lessonId) {
    if (!state.infiniteHearts && state.hearts <= 0) {
      openHeartsModal(true);
      return;
    }
    const lesson = ALL_LESSONS.find((l) => l.id === lessonId);
    if (!lesson) return;
    activeStory = null;
    activeSession = {
      mode: 'lesson',
      id: lesson.id,
      title: `Урок ${lesson.code}: ${lesson.title}`,
      queue: buildLessonQueue(lesson),
      idx: 0,
      mistakes: 0,
      missedWords: [],
      xpEarned: 0,
      selection: null,
      checked: false
    };
    openOverlayUI(false);
    renderCurrentExercise();
  }

  function startSectionExam(sec) {
    openModal(`
      <h3>🎓 Екзамен розділу</h3>
      <p style="font-weight:800;margin-bottom:6px;">${escHtml(sec.title)}</p>
      <p class="muted" style="font-size:14px;margin-bottom:14px;">
        12 запитань по всіх словах і граматиці розділу.<br/>
        <strong>Правило:</strong> допускається максимум <strong>1 помилка</strong>. Зробиш 2 — потрібно буде повторити тему і перездати, щоб відкрити наступний розділ.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-orange btn-full" id="m-start-exam">ПОЧАТИ ЕКЗАМЕН</button>
        <button class="btn btn-outline btn-full" id="m-cancel-exam">Повторити ще трохи</button>
      </div>
    `);
    document.getElementById('m-cancel-exam').onclick = closeModal;
    document.getElementById('m-start-exam').onclick = () => {
      closeModal();
      activeStory = null;
      activeSession = {
        mode: 'exam',
        examKind: 'section',
        section: sec,
        id: sec.id,
        title: `Екзамен: ${sec.title}`,
        queue: buildExamQueue(sec),
        idx: 0,
        mistakes: 0,
        maxMistakes: 1,
        examXp: XP_EXAM,
        missedWords: [],
        xpEarned: 0,
        selection: null,
        checked: false
      };
      openOverlayUI(true, 1);
      renderCurrentExercise();
    };
  }

  function startCustomDrill(queue, title, mode = 'custom') {
    if (!state.infiniteHearts && state.hearts <= 0) {
      openHeartsModal(true);
      return;
    }
    activeStory = null;
    activeSession = {
      mode,
      id: mode,
      title,
      queue,
      idx: 0,
      mistakes: 0,
      missedWords: [],
      xpEarned: 0,
      selection: null,
      checked: false
    };
    openOverlayUI(false);
    renderCurrentExercise();
  }

  function updateSessionProgress() {
    if (!activeSession) return;
    const pct = Math.min(100, Math.round((activeSession.idx / activeSession.queue.length) * 100));
    document.getElementById('lesson-progress-fill').style.width = pct + '%';
    if (activeSession.mode === 'exam') {
      const ep = document.getElementById('exam-err-pill');
      document.getElementById('exam-err-val').textContent = `${activeSession.mistakes}/${activeSession.maxMistakes}`;
      ep.classList.toggle('danger', activeSession.mistakes >= activeSession.maxMistakes);
    }
  }

  function showFeedback(isOk, title, sub, audioText = '') {
    const sheet = document.getElementById('feedback-sheet');
    const icon = document.getElementById('feedback-icon');
    const titleEl = document.getElementById('feedback-title');
    const subEl = document.getElementById('feedback-sub');
    const audioBtn = document.getElementById('feedback-audio-btn');
    const nextBtn = document.getElementById('feedback-next-btn');

    sheet.classList.remove('ok', 'bad', 'show');
    sheet.classList.add(isOk ? 'ok' : 'bad');
    icon.textContent = isOk ? '✓' : '✕';
    titleEl.textContent = title;
    subEl.innerHTML = sub || '';
    nextBtn.className = 'btn btn-full ' + (isOk ? 'btn-primary' : 'btn-danger');
    nextBtn.textContent = (activeSession && activeSession.mode === 'exam' && activeSession.mistakes > activeSession.maxMistakes)
      ? 'ЗАВЕРШИТИ ЕКЗАМЕН'
      : 'ДАЛІ';

    if (audioText && SpeechEngine.supported) {
      audioBtn.classList.remove('hidden');
      audioBtn.onclick = () => SpeechEngine.speak(audioText, false);
    } else {
      audioBtn.classList.add('hidden');
    }
    requestAnimationFrame(() => sheet.classList.add('show'));
  }

  function hideFeedback() {
    document.getElementById('feedback-sheet').classList.remove('show');
  }

  document.getElementById('feedback-next-btn').onclick = () => {
    hideFeedback();
    if (!activeSession) return;

    // Strict exam failure check (>1 mistake)
    if (activeSession.mode === 'exam' && activeSession.mistakes > activeSession.maxMistakes) {
      finishExamFailed();
      return;
    }

    if (activeSession.mode !== 'exam' && !state.infiniteHearts && state.hearts <= 0) {
      openHeartsModal(true);
      return;
    }

    activeSession.idx += 1;
    if (activeSession.idx >= activeSession.queue.length) {
      finishSession();
    } else {
      renderCurrentExercise();
    }
  };

  function recordCorrect(wordId) {
    srsMarkCorrect(wordId, activeSession && activeSession.mode === 'srs');
    saveState();
  }

  function recordMistake(ex) {
    activeSession.mistakes += 1;
    if (ex.word && ex.word.id) {
      srsMarkWrong(ex.word.id);
      if (!activeSession.missedWords.some((w) => w.id === ex.word.id)) {
        activeSession.missedWords.push(ex.word);
      }
    }
    if (activeSession.mode === 'exam') {
      updateSessionProgress();
      saveState();
      return; // No re-queue in exams!
    }
    if (!state.infiniteHearts) {
      state.hearts = Math.max(0, state.hearts - 1);
    }
    saveState();
    if (!ex._retried) {
      activeSession.queue.push({ ...ex, _retried: true });
    }
  }

  function examMistakeNote() {
    if (!activeSession || activeSession.mode !== 'exam') return '';
    const m = activeSession.mistakes;
    const max = activeSession.maxMistakes || 1;
    if (m <= max) {
      const left = max - m;
      if (left === 0) {
        return `<br/><span style="color:var(--orange);font-weight:800;">⚠️ Помилка ${m}/${max} — більше помилятися не можна!</span>`;
      }
      return `<br/><span style="color:var(--orange);font-weight:800;">⚠️ Помилка ${m}/${max} — залишилось право ще на ${left} ${left === 1 ? 'помилку' : 'помилки'}.</span>`;
    }
    return `<br/><span style="color:var(--red);font-weight:800;">❌ Перевищено ліміт (${m} помилок із ${max}) — екзамен не складено.</span>`;
  }

  function renderCurrentExercise() {
    if (!activeSession) return;
    MicEngine.stop();
    hideFeedback();
    updateSessionProgress();

    const ex = activeSession.queue[activeSession.idx];
    const stage = document.getElementById('lesson-stage');
    const actionBtn = document.getElementById('lesson-action-btn');
    const footer = document.getElementById('lesson-footer');
    footer.classList.remove('hidden');
    activeSession.selection = null;
    activeSession.checked = false;

    const retryBadge = ex._retried ? `<span class="badge-warn" style="margin-bottom:8px;">🔁 Виправляємо помилку</span>` : '';
    const examTag = activeSession.mode === 'exam' ? `<span class="badge-warn" style="margin-bottom:8px;">🎓 ЕКЗАМЕН • Питання ${activeSession.idx + 1}/${activeSession.queue.length}</span>` : '';

    // 1. INTRO CARD
    if (ex.type === 'intro') {
      const w = ex.word;
      stage.innerHTML = `
        <div class="ex-kicker new-word">✨ НОВЕ СЛОВО</div>
        <div class="ex-title">Запам’ятай це слово</div>
        <div class="intro-card">
          <div class="intro-word">${escHtml(w.sk)}</div>
          <div class="intro-tr">[${escHtml(w.tr)}]</div>
          <div class="audio-controls">
            <button class="audio-btn" id="intro-play">🔊 Слухати</button>
            <button class="audio-btn slow" id="intro-slow">🐢 Повільно</button>
          </div>
          <div class="intro-uk">${escHtml(w.uk)}</div>
          <div class="intro-tip">💡 ${escHtml(w.tip)}</div>
        </div>
      `;
      document.getElementById('intro-play').onclick = () => SpeechEngine.speak(w.sk, false);
      document.getElementById('intro-slow').onclick = () => SpeechEngine.speak(w.sk, true);
      if (state.autoSpeak && SpeechEngine.supported) SpeechEngine.speak(w.sk, false);

      actionBtn.disabled = false;
      actionBtn.textContent = 'ЗАПАМ’ЯТАВ, ДАЛІ';
      actionBtn.onclick = () => {
        SoundFX.tap();
        activeSession.idx += 1;
        renderCurrentExercise();
      };
      return;
    }

    // 2. MULTIPLE CHOICE (SK->UK, UK->SK, LISTEN)
    if (ex.type === 'mc_sk_uk' || ex.type === 'mc_uk_sk' || ex.type === 'listen_mc') {
      const w = ex.word;
      const dist = pickDistractors(w, ex.pool || ALL_WORDS, 3);
      const opts = shuffle([w, ...dist]);

      let kicker = 'ПЕРЕКЛАД';
      let title = 'Обери правильний переклад';
      let promptHtml = '';

      if (ex.type === 'mc_sk_uk') {
        promptHtml = `
          <div class="prompt-box">
            <div>
              <div class="prompt-main">${escHtml(w.sk)}</div>
              <div class="prompt-sub">[${escHtml(w.tr)}]</div>
            </div>
            <button class="audio-mini-btn" id="prompt-audio">🔊</button>
          </div>
        `;
      } else if (ex.type === 'mc_uk_sk') {
        title = 'Як це буде словацькою?';
        promptHtml = `<div class="prompt-box"><div class="prompt-main">${escHtml(w.uk)}</div></div>`;
      } else {
        kicker = 'АУДІЮВАННЯ';
        title = 'Послухай і обери переклад';
        promptHtml = `
          <div class="card" style="text-align:center;padding:20px;">
            <div class="audio-controls" style="margin:0;">
              <button class="audio-btn" id="prompt-audio">🔊 Слухати</button>
              <button class="audio-btn slow" id="prompt-slow">🐢 Повільно</button>
            </div>
          </div>
        `;
      }

      stage.innerHTML = `
        ${examTag}${retryBadge}
        <div class="ex-kicker">${kicker}</div>
        <div class="ex-title">${title}</div>
        ${promptHtml}
        <div class="options-list">
          ${opts.map((o, i) => `
            <button class="option-btn" data-id="${o.id}">
              <div>
                <div>${escHtml(ex.type === 'mc_uk_sk' ? o.sk : o.uk)}</div>
                ${ex.type === 'mc_uk_sk' ? `<span class="opt-tr">[${escHtml(o.tr)}]</span>` : ''}
              </div>
              <span class="muted">${i + 1}</span>
            </button>
          `).join('')}
        </div>
      `;

      const pa = document.getElementById('prompt-audio');
      if (pa) pa.onclick = () => SpeechEngine.speak(w.sk, false);
      const ps = document.getElementById('prompt-slow');
      if (ps) ps.onclick = () => SpeechEngine.speak(w.sk, true);
      if (state.autoSpeak && SpeechEngine.supported && (ex.type === 'mc_sk_uk' || ex.type === 'listen_mc')) {
        SpeechEngine.speak(w.sk, false);
      }

      actionBtn.disabled = true;
      actionBtn.textContent = 'ПЕРЕВІРИТИ';

      stage.querySelectorAll('.option-btn').forEach((btn) => {
        btn.onclick = () => {
          if (activeSession.checked) return;
          SoundFX.tap();
          stage.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          activeSession.selection = btn.dataset.id;
          if (ex.type === 'mc_uk_sk' && SpeechEngine.supported) {
            const chosenObj = opts.find((o) => o.id === btn.dataset.id);
            if (chosenObj) SpeechEngine.speak(chosenObj.sk, false);
          }
          actionBtn.disabled = false;
        };
      });

      actionBtn.onclick = () => {
        if (!activeSession.selection || activeSession.checked) return;
        activeSession.checked = true;
        const ok = activeSession.selection === w.id;
        stage.querySelectorAll('.option-btn').forEach((b) => {
          if (b.dataset.id === w.id) b.classList.add('correct');
          else if (b.dataset.id === activeSession.selection && !ok) b.classList.add('wrong');
        });
        if (ok) {
          SoundFX.ok();
          activeSession.xpEarned += 5;
          recordCorrect(w.id);
          showFeedback(true, 'Чудово!', `${escHtml(w.sk)} [${escHtml(w.tr)}] — ${escHtml(w.uk)}`, w.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильна відповідь:', `<strong>${escHtml(w.sk)}</strong> [${escHtml(w.tr)}] = ${escHtml(w.uk)}${examMistakeNote()}`, w.sk);
        }
      };
      return;
    }

    // 3. GRAMMAR FILL-IN-THE-BLANK
    if (ex.type === 'grammar') {
      const g = ex.gram;
      const opts = shuffle(g.options);
      const fullSent = `${g.before} ${g.answer} ${g.after}`.replace(/\s+([.,!?])/g, '$1').trim();

      stage.innerHTML = `
        ${examTag}${retryBadge}
        <div class="ex-kicker grammar">🧩 ГРАМАТИКА</div>
        <div class="ex-title">Підстав правильне слово</div>
        <div class="card" style="padding:18px;margin-bottom:16px;">
          <div class="gram-sentence">
            ${escHtml(g.before)} <span class="gram-blank" id="gram-blank-val">___</span> ${escHtml(g.after)}
          </div>
          <div class="muted" style="margin-top:8px;font-size:14px;">🇺🇦 ${escHtml(g.uk)}</div>
        </div>
        <div class="options-list">
          ${opts.map((o, i) => `
            <button class="option-btn" data-val="${escHtml(o)}">
              <span>${escHtml(o)}</span>
              <span class="muted">${i + 1}</span>
            </button>
          `).join('')}
        </div>
      `;

      actionBtn.disabled = true;
      actionBtn.textContent = 'ПЕРЕВІРИТИ';

      stage.querySelectorAll('.option-btn').forEach((btn) => {
        btn.onclick = () => {
          if (activeSession.checked) return;
          SoundFX.tap();
          stage.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          activeSession.selection = btn.dataset.val;
          document.getElementById('gram-blank-val').textContent = btn.dataset.val;
          actionBtn.disabled = false;
        };
      });

      actionBtn.onclick = () => {
        if (!activeSession.selection || activeSession.checked) return;
        activeSession.checked = true;
        const ok = activeSession.selection === g.answer;
        stage.querySelectorAll('.option-btn').forEach((b) => {
          if (b.dataset.val === g.answer) b.classList.add('correct');
          else if (b.dataset.val === activeSession.selection && !ok) b.classList.add('wrong');
        });
        document.getElementById('gram-blank-val').textContent = g.answer;
        if (ok) {
          SoundFX.ok();
          activeSession.xpEarned += 7;
          showFeedback(true, 'Точно!', `<strong>${escHtml(fullSent)}</strong><br/>${escHtml(g.explain)}`, fullSent);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильний варіант:', `<strong>${escHtml(fullSent)}</strong><br/>${escHtml(g.explain)}${examMistakeNote()}`, fullSent);
        }
      };
      return;
    }

    // 4. MATCH PAIRS
    if (ex.type === 'match_pairs') {
      footer.classList.add('hidden');
      const left = shuffle(ex.words);
      const right = shuffle(ex.words);
      let selLeft = null;
      let selRight = null;
      let matchedCount = 0;

      stage.innerHTML = `
        <div class="ex-kicker">ЗНАЙДИ ПАРИ</div>
        <div class="ex-title">З’єднай словацькі слова з перекладом</div>
        <div class="match-grid">
          <div class="match-col" id="m-left">
            ${left.map((w) => `<button class="match-tile" data-side="l" data-id="${w.id}">${escHtml(w.sk)}</button>`).join('')}
          </div>
          <div class="match-col" id="m-right">
            ${right.map((w) => `<button class="match-tile" data-side="r" data-id="${w.id}">${escHtml(w.uk)}</button>`).join('')}
          </div>
        </div>
      `;

      function tryPair() {
        if (!selLeft || !selRight) return;
        const lEl = selLeft;
        const rEl = selRight;
        if (lEl.dataset.id === rEl.dataset.id) {
          SoundFX.ok();
          lEl.classList.remove('selected');
          rEl.classList.remove('selected');
          lEl.classList.add('matched');
          rEl.classList.add('matched');
          recordCorrect(lEl.dataset.id);
          matchedCount += 1;
          selLeft = null;
          selRight = null;
          if (matchedCount === ex.words.length) {
            activeSession.xpEarned += 10;
            showFeedback(true, 'Чудова робота!', 'Усі 6 пар знайдено!');
          }
        } else {
          SoundFX.bad();
          lEl.classList.add('wrong-flash');
          rEl.classList.add('wrong-flash');
          selLeft = null;
          selRight = null;
          setTimeout(() => {
            lEl.classList.remove('selected', 'wrong-flash');
            rEl.classList.remove('selected', 'wrong-flash');
          }, 360);
        }
      }

      stage.querySelectorAll('.match-tile').forEach((tile) => {
        tile.onclick = () => {
          if (tile.classList.contains('matched')) return;
          SoundFX.tap();
          if (tile.dataset.side === 'l') {
            stage.querySelectorAll('#m-left .match-tile').forEach((t) => t.classList.remove('selected'));
            tile.classList.add('selected');
            selLeft = tile;
            const wObj = ex.words.find((x) => x.id === tile.dataset.id);
            if (wObj && SpeechEngine.supported) SpeechEngine.speak(wObj.sk, false);
          } else {
            stage.querySelectorAll('#m-right .match-tile').forEach((t) => t.classList.remove('selected'));
            tile.classList.add('selected');
            selRight = tile;
          }
          tryPair();
        };
      });
      return;
    }

    // 5. WORD BANK
    if (ex.type === 'word_bank') {
      const s = ex.sentence;
      const tokens = s.sk.replace(/[.,!?]/g, '').split(/\s+/).filter(Boolean);
      const distractors = shuffle(
        (ex.lessonWords || ALL_WORDS)
          .map((w) => w.sk.split(/\s+/)[0].replace(/[.,!?]/g, ''))
          .filter((t) => !tokens.some((x) => normLoose(x) === normLoose(t)))
      ).slice(0, 3);
      const bankItems = shuffle([...tokens, ...distractors]).map((txt, i) => ({ id: i, txt }));
      let picked = [];

      stage.innerHTML = `
        ${examTag}${retryBadge}
        <div class="ex-kicker">ЗБЕРИ РЕЧЕННЯ</div>
        <div class="ex-title">Склади фразу словацькою</div>
        <div class="prompt-box">
          <div>
            <div class="prompt-main">${escHtml(s.uk)}</div>
            <div class="muted" style="margin-top:4px;">Збери зі слів нижче</div>
          </div>
          ${activeSession.mode === 'exam' ? '' : '<button class="audio-mini-btn" id="wb-hint-audio" title="Підказка аудіо">🔊</button>'}
        </div>
        <div class="answer-zone" id="wb-answer"></div>
        <div class="bank-zone" id="wb-bank"></div>
      `;

      const ha = document.getElementById('wb-hint-audio');
      if (ha) ha.onclick = () => SpeechEngine.speak(s.sk, true);

      function renderBank() {
        const ansEl = document.getElementById('wb-answer');
        const bankEl = document.getElementById('wb-bank');
        ansEl.innerHTML = picked.length
          ? picked.map((item) => `<button class="word-chip in-answer" data-id="${item.id}">${escHtml(item.txt)}</button>`).join('')
          : `<span class="muted" style="padding:10px;">Натискай на слова нижче...</span>`;

        bankEl.innerHTML = bankItems.map((item) => {
          const used = picked.some((p) => p.id === item.id);
          return `<button class="word-chip ${used ? 'used' : ''}" data-id="${item.id}">${escHtml(item.txt)}</button>`;
        }).join('');

        ansEl.querySelectorAll('.word-chip').forEach((btn) => {
          btn.onclick = () => {
            if (activeSession.checked) return;
            SoundFX.tap();
            picked = picked.filter((p) => p.id !== Number(btn.dataset.id));
            renderBank();
          };
        });
        bankEl.querySelectorAll('.word-chip').forEach((btn) => {
          btn.onclick = () => {
            if (activeSession.checked) return;
            SoundFX.tap();
            const item = bankItems.find((b) => b.id === Number(btn.dataset.id));
            if (item && !picked.some((p) => p.id === item.id)) {
              picked.push(item);
              renderBank();
            }
          };
        });
        actionBtn.disabled = picked.length === 0;
      }

      renderBank();
      actionBtn.textContent = 'ПЕРЕВІРИТИ';
      actionBtn.onclick = () => {
        if (activeSession.checked || picked.length === 0) return;
        activeSession.checked = true;
        const userStr = picked.map((p) => p.txt).join(' ');
        const ok = normLoose(userStr) === normLoose(s.sk);
        if (ok) {
          SoundFX.ok();
          activeSession.xpEarned += 8;
          showFeedback(true, 'Відмінно!', `${escHtml(s.sk)} [${escHtml(s.tr)}]`, s.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильний варіант:', `<strong>${escHtml(s.sk)}</strong><br/>[${escHtml(s.tr)}]${examMistakeNote()}`, s.sk);
        }
      };
      return;
    }

    // 6. TYPING
    if (ex.type === 'typing') {
      const w = ex.word;
      stage.innerHTML = `
        ${examTag}${retryBadge}
        <div class="ex-kicker">ПИСЬМО</div>
        <div class="ex-title">Напиши словацькою</div>
        <div class="prompt-box">
          <div>
            <div class="prompt-main">${escHtml(w.uk)}</div>
            ${activeSession.mode === 'exam' ? '' : `<div class="muted" style="margin-top:4px;">Вимова: [${escHtml(w.tr)}]</div>`}
          </div>
          ${activeSession.mode === 'exam' ? '' : '<button class="audio-mini-btn" id="type-audio" title="Послухати">🔊</button>'}
        </div>
        <input type="text" class="text-input" id="type-input" placeholder="Введи слово..." autocomplete="off" autocorrect="off" spellcheck="false" />
        <div class="diacritic-bar" id="dia-bar">
          ${DIACRITICS.map((ch) => `<button type="button" class="dia-key" data-ch="${ch}">${ch}</button>`).join('')}
        </div>
      `;

      const inp = document.getElementById('type-input');
      const ta = document.getElementById('type-audio');
      if (ta) ta.onclick = () => SpeechEngine.speak(w.sk, true);

      document.getElementById('dia-bar').querySelectorAll('.dia-key').forEach((k) => {
        k.onclick = () => {
          SoundFX.tap();
          const start = inp.selectionStart || inp.value.length;
          const end = inp.selectionEnd || inp.value.length;
          inp.value = inp.value.slice(0, start) + k.dataset.ch + inp.value.slice(end);
          inp.focus();
          inp.setSelectionRange(start + 1, start + 1);
          actionBtn.disabled = inp.value.trim().length === 0;
        };
      });

      actionBtn.disabled = true;
      actionBtn.textContent = 'ПЕРЕВІРИТИ';
      inp.addEventListener('input', () => { actionBtn.disabled = inp.value.trim().length === 0; });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !actionBtn.disabled) actionBtn.click(); });

      actionBtn.onclick = () => {
        if (activeSession.checked) return;
        activeSession.checked = true;
        const val = inp.value.trim();
        const exact = normStrict(val) === normStrict(w.sk);
        const loose = normLoose(val) === normLoose(w.sk);

        if (exact) {
          SoundFX.ok();
          activeSession.xpEarned += 10;
          recordCorrect(w.id);
          showFeedback(true, 'Ідеально!', `${escHtml(w.sk)} [${escHtml(w.tr)}]`, w.sk);
        } else if (loose) {
          SoundFX.ok();
          activeSession.xpEarned += 8;
          recordCorrect(w.id);
          showFeedback(true, 'Зараховано!', `Зверни увагу на діакритику: <strong>${escHtml(w.sk)}</strong>`, w.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильне написання:', `<strong>${escHtml(w.sk)}</strong> [${escHtml(w.tr)}]${examMistakeNote()}`, w.sk);
        }
      };
      return;
    }

    // 7. SPEAKING (Microphone)
    if (ex.type === 'speak') {
      const s = ex.sentence;
      let isRec = false;
      stage.innerHTML = `
        ${retryBadge}
        <div class="ex-kicker">ВИМОВА (МІКРОФОН)</div>
        <div class="ex-title">Прочитай фразу вголос</div>
        <div class="mic-box">
          <div style="font-size:23px;font-weight:900;margin-bottom:4px;">${escHtml(s.sk)}</div>
          <div class="intro-tr" style="margin-bottom:6px;">[${escHtml(s.tr)}]</div>
          <div class="muted" style="margin-bottom:12px;">${escHtml(s.uk)}</div>
          <div class="audio-controls" style="margin-bottom:14px;">
            <button class="audio-btn slow" id="sp-listen">🔊 Послухати зразок</button>
          </div>
          <button class="mic-big-btn" id="sp-mic-btn" aria-label="Говорити">🎙️</button>
          <div class="muted" id="sp-status">Натисни на мікрофон і скажи фразу словацькою</div>
          <div class="heard-pill" id="sp-heard">...</div>
          <button class="btn btn-outline btn-sm" id="sp-skip" style="margin-top:14px;">Не можу зараз говорити (пропустити)</button>
        </div>
      `;
      footer.classList.add('hidden');
      document.getElementById('sp-listen').onclick = () => SpeechEngine.speak(s.sk, true);
      document.getElementById('sp-skip').onclick = () => {
        MicEngine.stop();
        activeSession.idx += 1;
        if (activeSession.idx >= activeSession.queue.length) finishSession();
        else renderCurrentExercise();
      };

      const micBtn = document.getElementById('sp-mic-btn');
      const statusEl = document.getElementById('sp-status');
      const heardEl = document.getElementById('sp-heard');
      micBtn.onclick = () => {
        if (isRec) { MicEngine.stop(); return; }
        isRec = true;
        micBtn.classList.add('recording');
        statusEl.textContent = 'Слухаю... Говори словацькою!';
        heardEl.textContent = '🎙️ ...';

        MicEngine.listen(
          (transcript, alts) => {
            heardEl.textContent = `Почув: «${transcript}»`;
            const targetWords = normLoose(s.sk).split(' ').filter(Boolean);
            let bestRatio = 0;
            alts.forEach((alt) => {
              const spokenWords = normLoose(alt).split(' ').filter(Boolean);
              const hits = targetWords.filter((tw) => spokenWords.includes(tw)).length;
              const ratio = targetWords.length ? hits / targetWords.length : 0;
              if (ratio > bestRatio) bestRatio = ratio;
            });
            if (bestRatio >= 0.65) {
              SoundFX.ok();
              activeSession.xpEarned += 10;
              showFeedback(true, 'Чудова вимова!', `Ти сказав: «${escHtml(transcript)}»`, s.sk);
            } else {
              SoundFX.bad();
              statusEl.textContent = 'Спробуй ще раз чіткіше (наголос на 1-й склад) або пропусти.';
            }
          },
          (errMsg) => { statusEl.textContent = errMsg; },
          () => { isRec = false; micBtn.classList.remove('recording'); }
        );
      };
    }
  }

  function finishExamFailed() {
    SoundFX.bad();
    const isMajor = activeSession.examKind === 'major';
    const sec = activeSession.section;
    const cfg = activeSession.examConfig;
    const targetSecs = activeSession.targetSections;
    const isPracticeOnly = !!activeSession.isPracticeOnly;
    const maxErr = activeSession.maxMistakes || 1;
    const mCount = activeSession.mistakes;

    const missedHtml = activeSession.missedWords.length
      ? `<div class="card" style="text-align:left;margin-bottom:14px;">
          <div style="font-weight:800;margin-bottom:6px;">Додано у слабкі слова:</div>
          ${activeSession.missedWords.slice(0, 8).map((w) => `<div class="muted">• <strong>${escHtml(w.sk)}</strong> — ${escHtml(w.uk)}</div>`).join('')}
        </div>`
      : '';

    openModal(`
      <div style="text-align:center;">
        <div style="font-size:52px;margin-bottom:6px;">📝</div>
        <h3 style="color:var(--red);">${isMajor ? 'Великий екзамен не складено' : 'Екзамен не складено'}</h3>
        <p class="muted" style="margin-bottom:14px;">Зроблено ${mCount} ${mCount <= 4 ? 'помилки' : 'помилок'} (дозволено максимум ${maxErr}). Усі помилкові слова додано у «Повтор → Слабкі слова» — потренуй їх і спробуй ще раз!</p>
        ${missedHtml}
        <div style="display:flex;flex-direction:column;gap:9px;">
          <button class="btn btn-orange btn-full" id="m-exam-retry">🔁 Перездати екзамен</button>
          <button class="btn btn-outline btn-full" id="m-exam-exit">Повернутися до курсу</button>
        </div>
      </div>
    `, false);

    document.getElementById('m-exam-retry').onclick = () => {
      closeModal();
      if (isMajor && cfg) {
        launchMajorExamSession(cfg, targetSecs || getLevelSections(cfg.level), isPracticeOnly);
      } else if (sec) {
        activeSession = {
          mode: 'exam',
          examKind: 'section',
          section: sec,
          id: sec.id,
          title: `Екзамен: ${sec.title}`,
          queue: buildExamQueue(sec),
          idx: 0,
          mistakes: 0,
          maxMistakes: 1,
          examXp: XP_EXAM,
          missedWords: [],
          xpEarned: 0,
          selection: null,
          checked: false
        };
        openOverlayUI(true, 1);
        renderCurrentExercise();
      }
    };
    document.getElementById('m-exam-exit').onclick = () => {
      closeModal();
      exitOverlay();
    };
  }

  function finishSession() {
    SoundFX.win();
    const isExam = activeSession.mode === 'exam';
    const isMajor = isExam && activeSession.examKind === 'major';
    const xp = isExam
      ? (activeSession.examXp || XP_EXAM)
      : (activeSession.mode === 'lesson' ? XP_LESSON : XP_REVIEW);
    addXP(xp);

    if (activeSession.mode === 'lesson' && !state.completedLessons.includes(activeSession.id)) {
      state.completedLessons.push(activeSession.id);
      saveState();
    }
    if (isExam && !isMajor) {
      if (!state.passedExams.includes(activeSession.id)) {
        state.passedExams.push(activeSession.id);
        expandedSections[activeSession.id] = false;
        const idx = SECTIONS.findIndex((s) => s.id === activeSession.id);
        if (idx >= 0 && SECTIONS[idx + 1] && SECTIONS[idx + 1].level === SECTIONS[idx].level) {
          expandedSections[SECTIONS[idx + 1].id] = true;
        }
        saveState();
      }
    }
    if (isMajor && !activeSession.isPracticeOnly) {
      if (!state.passedLevelExams.includes(activeSession.id)) {
        state.passedLevelExams.push(activeSession.id);
        // Auto-expand the first section of the next level!
        const nextLevelMap = { lvl_A0: 'A1', lvl_A1: 'A2', lvl_A2: 'B1' };
        const nextLv = nextLevelMap[activeSession.id];
        if (nextLv) {
          const nextSec = SECTIONS.find((s) => s.level === nextLv);
          if (nextSec) expandedSections[nextSec.id] = true;
        }
        saveState();
      }
    }

    const totalChecks = Math.max(1, activeSession.queue.length);
    const acc = Math.max(50, Math.round(((totalChecks - activeSession.mistakes) / totalChecks) * 100));
    const maxErr = activeSession.maxMistakes || 1;
    const icon = isMajor ? (activeSession.examConfig?.icon || '👑') : (isExam ? '🎓' : '🏆');
    const heading = isMajor
      ? (activeSession.isPracticeOnly ? 'Пробний мега-екзамен складено!' : `${activeSession.examConfig.title} складено!`)
      : (isExam ? 'Екзамен складено!' : 'Урок завершено!');
    const subMsg = isMajor
      ? (activeSession.isPracticeOnly
          ? `Помилок: ${activeSession.mistakes}/${maxErr}. Чудова перевірка вивчених тем!`
          : (activeSession.id === 'lvl_FINAL'
              ? `Помилок: ${activeSession.mistakes}/${maxErr}. Ти пройшов повну фінальну атестацію SlovoSK!`
              : `Помилок: ${activeSession.mistakes}/${maxErr}. Рівень ${activeSession.examConfig.level} підтверджено — наступний рівень відкрито!`
            )
        )
      : (isExam
          ? `Помилок: ${activeSession.mistakes}/${maxErr}. Наступний крок відкрито!`
          : escHtml(activeSession.title)
        );

    openModal(`
      <div style="text-align:center;">
        <div style="font-size:58px;margin-bottom:6px;">${icon}</div>
        <h3>${escHtml(heading)}</h3>
        <p class="muted" style="margin-bottom:14px;">${subMsg}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">
          <div class="card" style="margin:0;padding:12px;">
            <div class="muted">Отримано</div>
            <div style="font-size:22px;font-weight:900;color:var(--yellow);">+${xp} XP</div>
          </div>
          <div class="card" style="margin:0;padding:12px;">
            <div class="muted">Точність</div>
            <div style="font-size:22px;font-weight:900;color:var(--green);">${acc}%</div>
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="m-finish-ok">ПРОДОВЖИТИ</button>
      </div>
    `, false);

    document.getElementById('m-finish-ok').onclick = () => {
      closeModal();
      exitOverlay();
    };
  }

  // =====================================================
  // MINI-DIALOGUE STORY PLAYER
  // =====================================================
  let activeStory = null;

  function startStory(sec) {
    activeSession = null;
    activeStory = {
      sec,
      story: sec.story,
      step: 0, // revealed index up to step inclusive
      translationsOpen: {},
      answeredQuestions: {} // stepIdx -> true
    };
    openOverlayUI(false);
    document.getElementById('btn-hearts-lesson').classList.add('hidden');
    renderStory();
  }

  function renderStory() {
    if (!activeStory) return;
    const lines = activeStory.story.lines;
    const stage = document.getElementById('lesson-stage');
    const actionBtn = document.getElementById('lesson-action-btn');
    const footer = document.getElementById('lesson-footer');
    footer.classList.remove('hidden');

    const pct = Math.min(100, Math.round(((activeStory.step + 1) / lines.length) * 100));
    document.getElementById('lesson-progress-fill').style.width = pct + '%';

    let html = `
      <div class="ex-kicker new-word">💬 МІНІ-ДІАЛОГ</div>
      <div class="ex-title">${escHtml(activeStory.story.title)}</div>
      <div class="story-feed" id="story-feed">
    `;

    for (let i = 0; i <= activeStory.step && i < lines.length; i++) {
      const item = lines[i];
      if (item.type === 'question') {
        const doneQ = !!activeStory.answeredQuestions[i];
        html += `
          <div class="story-q-card">
            <div style="font-weight:900;margin-bottom:10px;">❓ ${escHtml(item.prompt)}</div>
            <div class="options-list">
              ${item.options.map((opt, oi) => `
                <button class="option-btn ${doneQ && oi === item.answer ? 'correct' : ''}" data-sq="${i}" data-oi="${oi}" ${doneQ ? 'disabled' : ''}>
                  <span>${escHtml(opt)}</span>
                </button>
              `).join('')}
            </div>
          </div>
        `;
      } else {
        const showUk = !!activeStory.translationsOpen[i];
        html += `
          <div class="story-bubble side-${item.side || 'l'}">
            <div class="story-speaker">${escHtml(item.speaker)}</div>
            <div style="font-size:16px;font-weight:800;">${escHtml(item.sk)}</div>
            <div class="msg-actions">
              <button class="msg-mini-btn" data-st-say="${i}">🔊 Слухати</button>
              <button class="msg-mini-btn" data-st-slow="${i}">🐢 Повільно</button>
              <button class="msg-mini-btn" data-st-uk="${i}">${showUk ? 'Сховати' : '🇺🇦 Переклад'}</button>
            </div>
            ${showUk ? `<div class="msg-translation">${escHtml(item.uk)}</div>` : ''}
          </div>
        `;
      }
    }
    html += `</div>`;
    stage.innerHTML = html;

    // Auto-speak newly revealed dialogue line
    const curItem = lines[activeStory.step];
    if (curItem && curItem.type !== 'question' && !curItem._spokenOnce) {
      curItem._spokenOnce = true;
      if (state.autoSpeak && SpeechEngine.supported) SpeechEngine.speak(curItem.sk, false);
    }

    stage.querySelectorAll('[data-st-say]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(lines[Number(b.dataset.stSay)].sk, false);
    });
    stage.querySelectorAll('[data-st-slow]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(lines[Number(b.dataset.stSlow)].sk, true);
    });
    stage.querySelectorAll('[data-st-uk]').forEach((b) => {
      b.onclick = () => {
        const idx = Number(b.dataset.stUk);
        activeStory.translationsOpen[idx] = !activeStory.translationsOpen[idx];
        renderStory();
      };
    });

    stage.querySelectorAll('[data-sq]').forEach((b) => {
      b.onclick = () => {
        const qIdx = Number(b.dataset.sq);
        const oi = Number(b.dataset.oi);
        if (oi === lines[qIdx].answer) {
          SoundFX.ok();
          activeStory.answeredQuestions[qIdx] = true;
          renderStory();
        } else {
          SoundFX.bad();
          b.classList.add('wrong');
          showToast('Не зовсім, спробуй інший варіант!');
        }
      };
    });

    const bodyEl = document.getElementById('lesson-stage');
    bodyEl.scrollTop = bodyEl.scrollHeight;

    const waitingQuestion = curItem && curItem.type === 'question' && !activeStory.answeredQuestions[activeStory.step];
    actionBtn.disabled = waitingQuestion;
    const isLast = activeStory.step >= lines.length - 1;
    actionBtn.textContent = isLast ? 'ЗАВЕРШИТИ ДІАЛОГ (+15 XP)' : 'ДАЛІ';

    actionBtn.onclick = () => {
      if (waitingQuestion) return;
      SoundFX.tap();
      if (isLast) {
        SoundFX.win();
        addXP(15);
        if (!state.completedStories.includes(activeStory.story.id)) {
          state.completedStories.push(activeStory.story.id);
          saveState();
        }
        lines.forEach((l) => { delete l._spokenOnce; });
        openModal(`
          <div style="text-align:center;">
            <div style="font-size:52px;margin-bottom:6px;">💬</div>
            <h3>Діалог пройдено!</h3>
            <p class="muted" style="margin-bottom:16px;">Ти розібрав реальну розмову і отримав <strong>+15 XP</strong>.</p>
            <button class="btn btn-primary btn-full" id="m-st-done">ЧУДОВО</button>
          </div>
        `, false);
        document.getElementById('m-st-done').onclick = () => { closeModal(); exitOverlay(); };
      } else {
        activeStory.step += 1;
        renderStory();
      }
    };
  }

  // =====================================================
  // TAB 2: REVIEW (SRS + 3D Flashcards + Hands-Free Headphones Audio)
  // =====================================================
  let fcFilter = 'unlocked';
  let fcIndex = 0;
  let fcFlipped = false;

  // Hands-free Audio State
  let audioDeckFilter = 'unlocked';
  let audioPlaying = false;
  let audioIdx = 0;
  let audioPhase = 'idle'; // idle | sk | recall | uk
  let audioTimer = null;
  let wakeLockSentinel = null;

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }
  function releaseWakeLock() {
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }
  }

  function stopAudioMode() {
    audioPlaying = false;
    audioPhase = 'idle';
    clearTimeout(audioTimer);
    SpeechEngine.cancel();
    releaseWakeLock();
  }

  function getUnlockedWords() {
    if (state.freeUnlock) return ALL_WORDS;
    const ids = new Set(state.completedLessons);
    if (ALL_LESSONS[0]) ids.add(ALL_LESSONS[0].id);
    const nextLes = ALL_LESSONS.find((l) => !state.completedLessons.includes(l.id));
    if (nextLes) ids.add(nextLes.id);
    return ALL_WORDS.filter((w) => ids.has(w.lessonId));
  }

  function getDeckByFilter(filterKey) {
    const due = getDueSrsWords();
    const weak = state.weakWords.map((id) => WORD_MAP[id]).filter(Boolean);
    if (filterKey === 'due') return due;
    if (filterKey === 'weak') return weak;
    if (filterKey === 'all') return ALL_WORDS;
    if (filterKey === 'unlocked') return getUnlockedWords();
    if (filterKey.startsWith('lvl_')) {
      const lv = filterKey.slice(4);
      return ALL_WORDS.filter((w) => w.level === lv);
    }
    return ALL_WORDS.filter((w) => w.sectionId === filterKey);
  }

  function runAudioLoop() {
    if (!audioPlaying) return;
    const deck = getDeckByFilter(audioDeckFilter);
    if (deck.length === 0) {
      stopAudioMode();
      renderReviewTab();
      return;
    }
    if (audioIdx >= deck.length) audioIdx = 0;
    const w = deck[audioIdx];
    audioPhase = 'sk';
    updateAudioCardUI(w, deck.length);

    SpeechEngine.speak(w.sk, state.audioSlow, () => {
      if (!audioPlaying) return;
      audioPhase = 'recall';
      updateAudioCardUI(w, deck.length);

      audioTimer = setTimeout(() => {
        if (!audioPlaying) return;
        audioPhase = 'uk';
        updateAudioCardUI(w, deck.length);

        const afterUk = () => {
          if (!audioPlaying) return;
          audioTimer = setTimeout(() => {
            if (!audioPlaying) return;
            audioIdx = (audioIdx + 1) % deck.length;
            runAudioLoop();
          }, 900);
        };

        if (state.audioSpeakUk) {
          SpeechEngine.speakUk(w.uk, afterUk);
        } else {
          audioTimer = setTimeout(afterUk, 1800);
        }
      }, (state.audioPauseSec || 3) * 1000);
    });
  }

  function updateAudioCardUI(w, total) {
    const phaseEl = document.getElementById('am-phase');
    const skEl = document.getElementById('am-sk');
    const trEl = document.getElementById('am-tr');
    const ukEl = document.getElementById('am-uk');
    const cntEl = document.getElementById('am-count');
    const playBtn = document.getElementById('am-play');
    if (!phaseEl || !w) return;

    cntEl.textContent = `${audioIdx + 1} / ${total}`;
    skEl.textContent = w.sk;
    trEl.textContent = `[${w.tr}]`;
    ukEl.textContent = (audioPhase === 'uk' || audioPhase === 'idle') ? w.uk : '🤔 Згадай переклад...';
    ukEl.style.opacity = (audioPhase === 'uk' || audioPhase === 'idle') ? '1' : '0.45';

    phaseEl.className = 'audio-phase-pill';
    if (audioPhase === 'sk') phaseEl.textContent = '🔊 Словацька...';
    else if (audioPhase === 'recall') {
      phaseEl.classList.add('recall');
      phaseEl.textContent = `⏳ Пауза ${state.audioPauseSec} сек — згадуй!`;
    } else if (audioPhase === 'uk') {
      phaseEl.classList.add('answer');
      phaseEl.textContent = '🇺🇦 Переклад';
    } else {
      phaseEl.textContent = '🎧 Готово до запуску';
    }

    if (playBtn) {
      playBtn.classList.toggle('playing', audioPlaying);
      playBtn.textContent = audioPlaying ? '⏸' : '▶';
    }
  }

  function renderReviewTab() {
    const sub = state.reviewSubtab || 'srs';
    const dueWords = getDueSrsWords();
    const weakList = state.weakWords.map((id) => WORD_MAP[id]).filter(Boolean);
    const unlockedWords = getUnlockedWords();

    let body = '';

    if (sub === 'srs') {
      const boxCounts = [0, 0, 0, 0, 0]; // 0, 1d, 3d, 7d, 14d+
      Object.values(state.srs).forEach((entry) => {
        const b = Math.min(4, entry.box || 0);
        boxCounts[b]++;
      });

      body = `
        <div class="card">
          <div class="row-between" style="margin-bottom:6px;">
            <div>
              <div style="font-weight:900;font-size:16px;">🧠 Розумне повторення (SRS)</div>
              <div class="muted">Інтервали: 1д → 3д → 7д → 14д</div>
            </div>
            <span class="${dueWords.length > 0 ? 'badge-warn' : 'badge-ok'}">
              ${dueWords.length > 0 ? `Сьогодні: ${dueWords.length}` : 'Усе повторено ✓'}
            </span>
          </div>
          <div class="srs-grid">
            <div class="srs-box"><div class="num" style="color:var(--red);">${boxCounts[0]}</div><div class="lbl">Сьогодні</div></div>
            <div class="srs-box"><div class="num" style="color:var(--orange);">${boxCounts[1]}</div><div class="lbl">1 день</div></div>
            <div class="srs-box"><div class="num" style="color:var(--blue);">${boxCounts[2]}</div><div class="lbl">3 дні</div></div>
            <div class="srs-box"><div class="num" style="color:var(--purple);">${boxCounts[3]}</div><div class="lbl">7 днів</div></div>
            <div class="srs-box"><div class="num" style="color:var(--green);">${boxCounts[4]}</div><div class="lbl">14д+</div></div>
          </div>
          <button class="btn btn-primary btn-full" id="rev-srs-btn" ${dueWords.length === 0 ? 'disabled' : ''}>
            🧠 Повторити за розкладом (${Math.min(10, dueWords.length)} слів)
          </button>
        </div>

        <div class="card">
          <div style="font-weight:900;font-size:16px;margin-bottom:6px;">🎯 Слабкі слова та бліц</div>
          <div class="muted" style="margin-bottom:12px;">Слова, у яких були помилки під час уроків або екзаменів: <strong>${weakList.length}</strong></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-orange btn-sm" id="rev-weak-btn" ${weakList.length === 0 ? 'disabled' : ''}>
              Робота над помилками (${weakList.length})
            </button>
            <button class="btn btn-blue btn-sm" id="rev-blitz-btn">⚡ Швидкий бліц (8 питань)</button>
          </div>
        </div>
      `;
    } else if (sub === 'cards') {
      const deck = getDeckByFilter(fcFilter);
      if (fcIndex >= deck.length) fcIndex = 0;
      const cardWord = deck[fcIndex] || null;

      body = `
        <div class="card">
          <div class="scenario-strip" id="fc-filters">
            <button class="chip-btn ${fcFilter === 'unlocked' ? 'active' : ''}" data-f="unlocked">Вивчені (${unlockedWords.length})</button>
            <button class="chip-btn ${fcFilter === 'due' ? 'active' : ''}" data-f="due">SRS (${dueWords.length})</button>
            <button class="chip-btn ${fcFilter === 'weak' ? 'active' : ''}" data-f="weak">Слабкі (${weakList.length})</button>
            <button class="chip-btn ${fcFilter === 'all' ? 'active' : ''}" data-f="all">Усі (${ALL_WORDS.length})</button>
            ${['A0', 'A1', 'A2', 'B1'].filter((lv) => ALL_WORDS.some((w) => w.level === lv)).map((lv) => `<button class="chip-btn ${fcFilter === 'lvl_' + lv ? 'active' : ''}" data-f="lvl_${lv}">Рівень ${lv}</button>`).join('')}
            ${SECTIONS.map((s, i) => `<button class="chip-btn ${fcFilter === s.id ? 'active' : ''}" data-f="${s.id}">Розділ ${i + 1}</button>`).join('')}
          </div>

          ${cardWord ? `
            <div class="muted" style="text-align:center;margin-top:4px;">Картка ${fcIndex + 1} з ${deck.length} • Натисни, щоб перевернути</div>
            <div class="flashcard-wrap">
              <div class="flashcard ${fcFlipped ? 'flipped' : ''}" id="fc-card">
                <div class="fc-face fc-front">
                  <div class="muted" style="margin-bottom:8px;">Словацькою</div>
                  <div style="font-size:28px;font-weight:900;margin-bottom:6px;">${escHtml(cardWord.sk)}</div>
                  <div class="intro-tr" style="margin-bottom:14px;">[${escHtml(cardWord.tr)}]</div>
                  <button class="audio-btn" id="fc-speak">🔊 Послухати</button>
                </div>
                <div class="fc-face fc-back">
                  <div class="muted" style="margin-bottom:8px;">Українською</div>
                  <div style="font-size:26px;font-weight:900;color:var(--green);margin-bottom:10px;">${escHtml(cardWord.uk)}</div>
                  <div class="muted" style="font-size:13px;max-width:340px;">💡 ${escHtml(cardWord.tip)}</div>
                </div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <button class="btn btn-outline" id="fc-again">🔁 Ще раз</button>
              <button class="btn btn-primary" id="fc-know">✓ Знаю</button>
            </div>
          ` : `<div class="muted" style="text-align:center;padding:24px 0;">У цій категорії поки порожньо 🎉</div>`}
        </div>
      `;
    } else {
      // HANDS-FREE AUDIO MODE ("У навушниках")
      const deck = getDeckByFilter(audioDeckFilter);
      if (audioIdx >= deck.length) audioIdx = 0;
      const w = deck[audioIdx] || null;

      body = `
        <div class="card">
          <div style="font-weight:900;font-size:16px;margin-bottom:4px;">🎧 Режим «У навушниках»</div>
          <div class="muted" style="margin-bottom:10px;">Автоматично диктує по колу: словацьке слово → пауза (згадуєш) → український переклад.</div>

          <div class="scenario-strip" id="am-filters">
            <button class="chip-btn ${audioDeckFilter === 'unlocked' ? 'active' : ''}" data-af="unlocked">Вивчені (${unlockedWords.length})</button>
            <button class="chip-btn ${audioDeckFilter === 'due' ? 'active' : ''}" data-af="due">SRS (${dueWords.length})</button>
            <button class="chip-btn ${audioDeckFilter === 'weak' ? 'active' : ''}" data-af="weak">Слабкі (${weakList.length})</button>
            ${['A0', 'A1', 'A2', 'B1'].filter((lv) => ALL_WORDS.some((w) => w.level === lv)).map((lv) => `<button class="chip-btn ${audioDeckFilter === 'lvl_' + lv ? 'active' : ''}" data-af="lvl_${lv}">Рівень ${lv}</button>`).join('')}
            ${SECTIONS.map((s, i) => `<button class="chip-btn ${audioDeckFilter === s.id ? 'active' : ''}" data-af="${s.id}">Розділ ${i + 1}</button>`).join('')}
          </div>

          ${w ? `
            <div class="audio-stage">
              <div class="audio-phase-pill" id="am-phase">🎧 Готово до запуску</div>
              <div class="muted" id="am-count" style="margin-bottom:6px;">${audioIdx + 1} / ${deck.length}</div>
              <div style="font-size:30px;font-weight:900;margin-bottom:4px;" id="am-sk">${escHtml(w.sk)}</div>
              <div class="intro-tr" style="margin-bottom:12px;" id="am-tr">[${escHtml(w.tr)}]</div>
              <div style="font-size:21px;font-weight:800;color:var(--green);" id="am-uk">${escHtml(w.uk)}</div>

              <div class="audio-player-controls">
                <button class="icon-btn" id="am-prev" aria-label="Попереднє">⏮</button>
                <button class="play-circle-btn ${audioPlaying ? 'playing' : ''}" id="am-play" aria-label="Старт/Пауза">${audioPlaying ? '⏸' : '▶'}</button>
                <button class="icon-btn" id="am-next" aria-label="Наступне">⏭</button>
              </div>
            </div>

            <div class="row-between" style="padding:6px 0;">
              <span class="muted" style="font-weight:700;">Пауза на згадування:</span>
              <div style="display:flex;gap:6px;">
                ${[2, 3, 4].map((sec) => `<button class="chip-btn ${state.audioPauseSec === sec ? 'active' : ''}" data-apause="${sec}">${sec}с</button>`).join('')}
              </div>
            </div>
            <div class="row-between" style="padding:6px 0;">
              <span style="font-size:13.5px;font-weight:700;">🐢 Повільна вимова словацької</span>
              <label class="switch"><input type="checkbox" id="am-slow" ${state.audioSlow ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div class="row-between" style="padding:6px 0;">
              <span style="font-size:13.5px;font-weight:700;">🇺🇦 Озвучувати переклад українською</span>
              <label class="switch"><input type="checkbox" id="am-speak-uk" ${state.audioSpeakUk ? 'checked' : ''}><span class="slider"></span></label>
            </div>
          ` : `<div class="muted" style="text-align:center;padding:24px 0;">У цій категорії поки немає слів.</div>`}
        </div>
      `;
    }

    mainView.innerHTML = `
      <div class="subtabs" id="rev-subtabs">
        <button class="subtab ${sub === 'srs' ? 'active' : ''}" data-rs="srs">🧠 SRS (${dueWords.length})</button>
        <button class="subtab ${sub === 'cards' ? 'active' : ''}" data-rs="cards">🃏 Картки</button>
        <button class="subtab ${sub === 'audio' ? 'active' : ''}" data-rs="audio">🎧 Навушники</button>
      </div>
      ${body}
    `;

    document.getElementById('rev-subtabs').querySelectorAll('.subtab').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.rs !== 'audio') stopAudioMode();
        state.reviewSubtab = b.dataset.rs;
        saveState();
        renderReviewTab();
      };
    });

    // Bind SRS subtab
    const srsBtn = document.getElementById('rev-srs-btn');
    if (srsBtn) {
      srsBtn.onclick = () => {
        const q = dueWords.slice(0, 10).map((w, i) => ({
          type: i % 3 === 0 ? 'mc_sk_uk' : (i % 3 === 1 ? 'mc_uk_sk' : 'typing'),
          word: w,
          pool: ALL_WORDS
        }));
        startCustomDrill(q, 'Розумне повторення (SRS)', 'srs');
      };
    }

    const weakBtn = document.getElementById('rev-weak-btn');
    if (weakBtn) {
      weakBtn.onclick = () => {
        const q = shuffle(weakList).slice(0, 8).map((w, i) => ({
          type: i % 2 === 0 ? 'mc_sk_uk' : 'mc_uk_sk',
          word: w,
          pool: ALL_WORDS
        }));
        startCustomDrill(q, 'Робота над помилками', 'srs');
      };
    }

    const blitzBtn = document.getElementById('rev-blitz-btn');
    if (blitzBtn) {
      blitzBtn.onclick = () => {
        const src = shuffle(unlockedWords).slice(0, 8);
        const q = src.map((w, i) => ({
          type: i % 3 === 0 ? 'mc_sk_uk' : (i % 3 === 1 ? 'mc_uk_sk' : (SpeechEngine.supported ? 'listen_mc' : 'mc_sk_uk')),
          word: w,
          pool: unlockedWords.length >= 6 ? unlockedWords : ALL_WORDS
        }));
        startCustomDrill(q, 'Швидкий бліц', 'custom');
      };
    }

    // Bind Flashcards subtab
    const fcFilters = document.getElementById('fc-filters');
    if (fcFilters) {
      fcFilters.querySelectorAll('.chip-btn').forEach((b) => {
        b.onclick = () => {
          fcFilter = b.dataset.f;
          fcIndex = 0;
          fcFlipped = false;
          renderReviewTab();
        };
      });
    }
    const fcEl = document.getElementById('fc-card');
    if (fcEl) {
      const deck = getDeckByFilter(fcFilter);
      const cardWord = deck[fcIndex];
      fcEl.onclick = (e) => {
        if (e.target.id === 'fc-speak') return;
        fcFlipped = !fcFlipped;
        fcEl.classList.toggle('flipped', fcFlipped);
      };
      document.getElementById('fc-speak').onclick = (e) => {
        e.stopPropagation();
        SpeechEngine.speak(cardWord.sk, false);
      };
      document.getElementById('fc-again').onclick = () => {
        srsMarkWrong(cardWord.id);
        saveState();
        SoundFX.tap();
        fcFlipped = false;
        fcIndex = (fcIndex + 1) % deck.length;
        renderReviewTab();
      };
      document.getElementById('fc-know').onclick = () => {
        srsMarkCorrect(cardWord.id, true);
        saveState();
        SoundFX.ok();
        fcFlipped = false;
        fcIndex = (fcIndex + 1) % Math.max(1, deck.length);
        renderReviewTab();
      };
    }

    // Bind Audio Mode subtab
    const amFilters = document.getElementById('am-filters');
    if (amFilters) {
      amFilters.querySelectorAll('.chip-btn').forEach((b) => {
        b.onclick = () => {
          stopAudioMode();
          audioDeckFilter = b.dataset.af;
          audioIdx = 0;
          renderReviewTab();
        };
      });
    }
    const amPlay = document.getElementById('am-play');
    if (amPlay) {
      const deck = getDeckByFilter(audioDeckFilter);
      if (deck[audioIdx]) updateAudioCardUI(deck[audioIdx], deck.length);

      amPlay.onclick = () => {
        if (audioPlaying) {
          stopAudioMode();
          if (deck[audioIdx]) updateAudioCardUI(deck[audioIdx], deck.length);
        } else {
          audioPlaying = true;
          requestWakeLock();
          runAudioLoop();
        }
      };
      document.getElementById('am-prev').onclick = () => {
        clearTimeout(audioTimer);
        SpeechEngine.cancel();
        audioIdx = (audioIdx - 1 + deck.length) % deck.length;
        if (audioPlaying) runAudioLoop();
        else updateAudioCardUI(deck[audioIdx], deck.length);
      };
      document.getElementById('am-next').onclick = () => {
        clearTimeout(audioTimer);
        SpeechEngine.cancel();
        audioIdx = (audioIdx + 1) % deck.length;
        if (audioPlaying) runAudioLoop();
        else updateAudioCardUI(deck[audioIdx], deck.length);
      };
      mainView.querySelectorAll('[data-apause]').forEach((b) => {
        b.onclick = () => {
          state.audioPauseSec = Number(b.dataset.apause);
          saveState();
          renderReviewTab();
        };
      });
      document.getElementById('am-slow').onchange = (e) => { state.audioSlow = e.target.checked; saveState(); };
      document.getElementById('am-speak-uk').onchange = (e) => { state.audioSpeakUk = e.target.checked; saveState(); };
    }
  }

  // =====================================================
  // TAB 3: AI CHAT (Gemini + Offline)
  // =====================================================
  const chatHistory = {};
  function getScenario(id) {
    return REF.aiScenarios.find((s) => s.id === id) || REF.aiScenarios[0];
  }
  function ensureScenarioInit(scId) {
    if (!chatHistory[scId]) {
      const sc = getScenario(scId);
      if (!sc) return;
      chatHistory[scId] = [{ role: 'bot', sk: sc.first_sk, uk: sc.first_uk, tip: sc.hint, showUk: false }];
    }
  }

  function offlineBotReply(scId, userText) {
    const low = normLoose(userText);
    if (scId === 'interview') {
      if (/volam|dmytro|ukrajin|dobry|ahoj/.test(low)) {
        return {
          sk: 'Teší ma! Hľadáte prácu? Máte skúsenosť alebo vodičský preukaz?',
          uk: 'Приємно познайомитися! Ви шукаєте роботу? Маєте досвід або водійські права?',
          tip: 'Спробуй: «Áno, hľadám prácu. Mám vodičský preukaz.»'
        };
      }
      if (/ano|mam|vodic|skusen|prac|spolahliv/.test(low)) {
        return {
          sk: 'Výborne! Nástup je v pondelok o ôsmej. Môžete pracovať rannú aj nočnú zmenu?',
          uk: 'Чудово! Вихід у понеділок о восьмій. Можете працювати ранкову й нічну зміну?',
          tip: 'Спробуй: «Áno, môžem začať v pondelok.»'
        };
      }
      return {
        sk: 'Rozumiem. Tu je pracovná zmluva. Máte ešte otázku?',
        uk: 'Розумію. Ось трудовий договір. Маєте ще питання?',
        tip: 'Для повністю вільних діалогів додай безкоштовний ключ Gemini у Налаштуваннях!'
      };
    }
    if (scId === 'shift') {
      if (/ano|rozumiem|ok|dobre/.test(low)) {
        return {
          sk: 'Super! Sklad je vpravo. Pozor, veľká paleta!',
          uk: 'Супер! Склад праворуч. Обережно, велика палета!',
          tip: 'Спробуй: «Majster, je to hotovo.» або «Stroj nefunguje.»'
        };
      }
      if (/hotovo|stroj|nefunguje|chyba/.test(low)) {
        return {
          sk: 'Ďakujem! Počkaj päť minút, všetko je v poriadku. Teraz je prestávka.',
          uk: 'Дякую! Зачекай п’ять хвилин, усе гаразд. Зараз перерва.',
          tip: 'Відповідь: «Dobre, ďakujem!»'
        };
      }
      return {
        sk: 'Potrebuješ pomoc? Kde je krabica?',
        uk: 'Тобі потрібна допомога? Де коробка?',
        tip: 'Спробуй: «Áno, potrebujem pomoc.»'
      };
    }
    if (scId === 'shop') {
      if (/chlieb|voda|mlieko|syr|maso|caj|prosim/.test(low)) {
        return {
          sk: 'Tu, prosím. Desať eur. Kartou alebo v hotovosti?',
          uk: 'Ось, будь ласка. Десять євро. Карткою чи готівкою?',
          tip: 'Відповідь: «Kartou, prosím.»'
        };
      }
      return {
        sk: 'Ďakujem! Chcete bloček? Dovidenia!',
        uk: 'Дякую! Хочете чек? До побачення!',
        tip: 'Відповідь: «Nie, bloček nie, ďakujem. Dovidenia!»'
      };
    }
    return {
      sk: 'Pridaj bezplatný Gemini API kľúč v Nastaveniach pre živého učiteľa.',
      uk: 'Для живих відповідей репетитора встав безкоштовний ключ із aistudio.google.com у вкладці «Налашт.».',
      tip: 'Ключ зберігається тільки локально на твоєму телефоні.'
    };
  }

  async function callGemini(sc, history, userText) {
    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    const contents = [];
    history.slice(-8).forEach((m) => {
      contents.push({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.role === 'user' ? m.text : JSON.stringify({ sk: m.sk, uk: m.uk, tip: m.tip || '' }) }]
      });
    });
    contents.push({ role: 'user', parts: [{ text: userText }] });

    let lastErr = '';
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(state.geminiKey.trim())}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sc.system }] },
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
          })
        });
        const data = await res.json();
        if (!res.ok) { lastErr = data?.error?.message || `HTTP ${res.status}`; continue; }
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          return { sk: parsed.sk || raw, uk: parsed.uk || '', tip: parsed.tip || '' };
        } catch {
          return { sk: raw, uk: '', tip: '' };
        }
      } catch (e) {
        lastErr = e.message || 'Помилка мережі';
      }
    }
    throw new Error(lastErr || 'Не вдалося з’єднатися з Gemini API');
  }

  function renderAiTab() {
    const sc = getScenario(state.aiScenario);
    if (!sc) return;
    ensureScenarioInit(sc.id);
    const msgs = chatHistory[sc.id];
    const hasKey = !!state.geminiKey.trim();

    mainView.innerHTML = `
      <div class="chat-wrap">
        <div class="scenario-strip" id="ai-scenarios">
          ${REF.aiScenarios.map((s) => `<button class="chip-btn ${s.id === sc.id ? 'active' : ''}" data-sc="${s.id}">${escHtml(s.name)}</button>`).join('')}
        </div>

        <div class="row-between" style="margin-bottom:6px;padding:6px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;">
          <div style="font-size:12.5px;">
            ${hasKey ? '<span class="badge-ok">✨ Gemini AI активний</span>' : '<span class="badge-warn">⚡ Офлайн-тренажер</span>'}
          </div>
          <div style="display:flex;gap:6px;">
            ${!hasKey ? '<button class="msg-mini-btn" id="ai-go-key">🔑 Ключ</button>' : ''}
            <button class="msg-mini-btn" id="ai-reset">↻ Скинути</button>
          </div>
        </div>

        <div class="chat-messages" id="chat-messages">
          ${msgs.map((m, idx) => {
            if (m.role === 'user') return `<div class="msg user">${escHtml(m.text)}</div>`;
            return `
              <div class="msg bot">
                <div style="font-weight:800;">${escHtml(m.sk)}</div>
                <div class="msg-actions">
                  <button class="msg-mini-btn" data-speak="${idx}">🔊 Слухати</button>
                  <button class="msg-mini-btn" data-slow="${idx}">🐢 Повільно</button>
                  ${m.uk ? `<button class="msg-mini-btn" data-tr="${idx}">${m.showUk ? 'Сховати' : '🇺🇦 Переклад'}</button>` : ''}
                </div>
                ${m.showUk && m.uk ? `<div class="msg-translation">${escHtml(m.uk)}</div>` : ''}
                ${m.tip ? `<div class="msg-tip">💡 ${escHtml(m.tip)}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>

        <div class="chat-input-bar">
          ${MicEngine.supported ? '<button class="icon-btn" id="chat-mic" title="Сказати словацькою">🎙️</button>' : ''}
          <input type="text" id="chat-input" placeholder="Пиши словацькою або українською..." autocomplete="off" />
          <button class="btn btn-primary btn-sm" id="chat-send">➤</button>
        </div>
      </div>
    `;

    const msgBox = document.getElementById('chat-messages');
    msgBox.scrollTop = msgBox.scrollHeight;

    document.getElementById('ai-scenarios').querySelectorAll('.chip-btn').forEach((b) => {
      b.onclick = () => { state.aiScenario = b.dataset.sc; saveState(); renderAiTab(); };
    });
    const goKey = document.getElementById('ai-go-key');
    if (goKey) goKey.onclick = () => setTab('settings');
    document.getElementById('ai-reset').onclick = () => { delete chatHistory[sc.id]; renderAiTab(); };

    msgBox.querySelectorAll('[data-speak]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(msgs[Number(b.dataset.speak)].sk, false);
    });
    msgBox.querySelectorAll('[data-slow]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(msgs[Number(b.dataset.slow)].sk, true);
    });
    msgBox.querySelectorAll('[data-tr]').forEach((b) => {
      b.onclick = () => { msgs[Number(b.dataset.tr)].showUk = !msgs[Number(b.dataset.tr)].showUk; renderAiTab(); };
    });

    const inp = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');

    async function sendChat() {
      const txt = inp.value.trim();
      if (!txt) return;
      inp.value = '';
      msgs.push({ role: 'user', text: txt });
      renderAiTab();

      if (state.geminiKey.trim()) {
        msgs.push({ role: 'bot', sk: 'Друкує відповідь...', uk: '', tip: '' });
        renderAiTab();
        try {
          const reply = await callGemini(sc, msgs.slice(0, -1), txt);
          msgs.pop();
          msgs.push({ role: 'bot', ...reply, showUk: sc.id === 'grammar' });
          addXP(3);
          if (state.autoSpeak && SpeechEngine.supported && reply.sk) SpeechEngine.speak(reply.sk, false);
        } catch (err) {
          msgs.pop();
          msgs.push({ role: 'bot', sk: 'Помилка Gemini API.', uk: err.message, tip: 'Перевір ключ у Налаштуваннях.', showUk: true });
        }
        renderAiTab();
      } else {
        setTimeout(() => {
          const reply = offlineBotReply(sc.id, txt);
          msgs.push({ role: 'bot', ...reply, showUk: false });
          addXP(2);
          renderAiTab();
          if (state.autoSpeak && SpeechEngine.supported) SpeechEngine.speak(reply.sk, false);
        }, 300);
      }
    }

    sendBtn.onclick = sendChat;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    const micBtn = document.getElementById('chat-mic');
    if (micBtn) {
      micBtn.onclick = () => {
        micBtn.textContent = '🔴';
        MicEngine.listen(
          (transcript) => { inp.value = transcript; inp.focus(); },
          (err) => showToast(err),
          () => { micBtn.textContent = '🎙️'; }
        );
      };
    }
  }

  // =====================================================
  // TAB 4: REFERENCE (Dictionary, Pronunciation, Traps, Grammar)
  // =====================================================
  let dictQuery = '';
  function renderRefTab() {
    const st = state.refSubtab || 'dict';
    let body = '';

    if (st === 'dict') {
      const q = normLoose(dictQuery);
      const filtered = ALL_WORDS.filter((w) => !q || normLoose(w.sk).includes(q) || normLoose(w.uk).includes(q));
      body = `
        <input type="search" class="text-input" id="dict-search" placeholder="🔍 Пошук словацькою або українською..." value="${escHtml(dictQuery)}" style="margin-bottom:12px;" />
        <div class="muted" style="margin-bottom:8px;">Слів у завантажених модулях: ${filtered.length} з ${ALL_WORDS.length}</div>
        ${filtered.map((w) => `
          <div class="dict-row">
            <div style="min-width:0;">
              <div style="font-weight:900;font-size:15px;">${escHtml(w.sk)} <span style="color:var(--blue);font-weight:600;font-size:13px;">[${escHtml(w.tr)}]</span></div>
              <div style="font-size:14px;color:var(--green);font-weight:700;">${escHtml(w.uk)}</div>
            </div>
            <button class="audio-mini-btn" data-say="${escHtml(w.sk)}">🔊</button>
          </div>
        `).join('')}
      `;
    } else if (st === 'pron') {
      body = REF.pronunciation.map((r) => `
        <div class="card" style="padding:12px 14px;">
          <div style="font-weight:900;color:var(--blue);font-size:15px;">${escHtml(r.symbol)}</div>
          <div style="font-weight:700;margin:3px 0;">${escHtml(r.sound)}</div>
          <div class="muted">Приклади: ${escHtml(r.ex)}</div>
        </div>
      `).join('');
    } else if (st === 'traps') {
      body = REF.falseFriends.map((f) => `
        <div class="dict-row">
          <div>
            <div style="font-weight:900;font-size:15px;">${escHtml(f.sk)} → <span style="color:var(--green);">${escHtml(f.uk)}</span></div>
            <div style="font-size:12.5px;color:var(--orange);font-weight:700;">${escHtml(f.trap)}</div>
          </div>
          <button class="audio-mini-btn" data-say="${escHtml(f.sk)}">🔊</button>
        </div>
      `).join('');
    } else {
      body = REF.grammar.map((g) => `
        <div class="card">
          <div style="font-weight:900;font-size:15px;color:var(--purple);margin-bottom:8px;">${escHtml(g.title)}</div>
          <div style="white-space:pre-line;font-size:14px;line-height:1.55;">${escHtml(g.body)}</div>
        </div>
      `).join('');
    }

    mainView.innerHTML = `
      <div class="subtabs" id="ref-subtabs">
        <button class="subtab ${st === 'dict' ? 'active' : ''}" data-st="dict">Словник</button>
        <button class="subtab ${st === 'pron' ? 'active' : ''}" data-st="pron">Вимова</button>
        <button class="subtab ${st === 'traps' ? 'active' : ''}" data-st="traps">Пастки</button>
        <button class="subtab ${st === 'gram' ? 'active' : ''}" data-st="gram">Граматика</button>
      </div>
      ${body}
    `;

    document.getElementById('ref-subtabs').querySelectorAll('.subtab').forEach((b) => {
      b.onclick = () => { state.refSubtab = b.dataset.st; saveState(); renderRefTab(); };
    });

    const searchEl = document.getElementById('dict-search');
    if (searchEl) {
      searchEl.addEventListener('input', (e) => {
        dictQuery = e.target.value;
        renderRefTab();
        const fresh = document.getElementById('dict-search');
        if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
      });
    }

    mainView.querySelectorAll('[data-say]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(b.dataset.say, false);
    });
  }

  // =====================================================
  // TAB 5: SETTINGS (Modules, Android TTS, PWA, Gemini, Backup)
  // =====================================================
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (activeTab === 'settings') renderSettingsTab();
  });

  SpeechEngine.onChange(() => {
    if (activeTab === 'settings') renderSettingsTab();
  });

  function renderSettingsTab() {
    const skVoices = SpeechEngine.getSlovakVoices();
    const allVoices = SpeechEngine.getAllVoices();
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    const voiceBadge = !SpeechEngine.supported
      ? '<span class="badge-warn">⚠️ Браузер не підтримує синтез мовлення</span>'
      : (skVoices.length > 0
          ? `<span class="badge-ok">✅ Словацький голос: ${escHtml(skVoices[0].name)}</span>`
          : '<span class="badge-warn">⚠️ Пакет sk-SK не знайдено — вмикаємо системний</span>');

    mainView.innerHTML = `
      <div class="card">
        <div class="row-between" style="margin-bottom:8px;">
          <div style="font-weight:900;font-size:16px;">📦 Підключені модулі (${LOADED_MODULES.length})</div>
          <button class="btn btn-outline btn-sm" id="set-refresh-mods">🔄 Оновити</button>
        </div>
        ${LOADED_MODULES.map((m) => `
          <div class="muted" style="padding:4px 0;">• <strong>${escHtml(m.id)}.js</strong> — ${escHtml(m.name || '')} (${(m.sections || []).length} розд.)</div>
        `).join('')}
        <div class="muted" style="margin-top:8px;font-size:12px;">
          Щоб розширити курс: просто закинь наступний файл <strong>m${LOADED_MODULES.length + 1}.js</strong> на GitHub і натисни «Оновити». Весь прогрес збережеться!
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">📲 Встановлення на телефон (PWA)</div>
        ${isStandalone
          ? '<div class="badge-ok">✅ Додаток вже встановлено!</div>'
          : (deferredInstallPrompt
              ? '<button class="btn btn-primary btn-full" id="set-pwa-install">📲 Встановити SlovoSK на телефон</button>'
              : '<div class="muted">У Chrome натисни меню <strong>⋮</strong> → <strong>«Додати на головний екран»</strong>.</div>')
        }
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🔊 Озвучка та мікрофон</div>
        <div style="margin-bottom:10px;">${voiceBadge}</div>
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button class="btn btn-blue btn-sm" id="set-test-tts">🔊 Тест словацької</button>
          <button class="btn btn-outline btn-sm" id="set-test-slow">🐢 Повільно</button>
        </div>

        ${allVoices.some((v) => /^(sk|cs)/i.test(v.lang)) ? `
          <label class="muted" style="display:block;margin-bottom:4px;">Голос озвучки:</label>
          <select id="set-voice-select" class="text-input" style="padding:10px;font-size:13px;margin-bottom:12px;">
            <option value="">Авто (найкращий словацький sk-SK)</option>
            ${allVoices.filter((v) => /^(sk|cs)/i.test(v.lang)).map((v) =>
              `<option value="${escHtml(v.voiceURI)}" ${state.preferredVoiceURI === v.voiceURI ? 'selected' : ''}>${escHtml(v.name)} (${escHtml(v.lang)})</option>`
            ).join('')}
          </select>
        ` : ''}

        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">Автоозвучка нових слів</div>
            <div class="muted">Промовляти слово одразу при відкритті картки</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-autospeak" ${state.autoSpeak ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">Звукові ефекти</div>
            <div class="muted">Звуки правильної / неправильної відповіді</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-sfx" ${state.soundFx ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">Вправи з мікрофоном</div>
            <div class="muted">${MicEngine.supported ? 'Перевірка вимови в уроках' : 'Не підтримується в цьому браузері'}</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-mic" ${state.micEnabled ? 'checked' : ''} ${MicEngine.supported ? '' : 'disabled'}><span class="slider"></span></label>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🤖 ШІ-Репетитор (Gemini API)</div>
        <div class="muted" style="margin-bottom:10px;">
          Безкоштовний ключ із <strong>aistudio.google.com</strong> (<em>Get API key</em>). Зберігається тільки на твоєму телефоні.
        </div>
        <input type="password" class="text-input" id="set-gemini-key" placeholder="AIzaSy..." value="${escHtml(state.geminiKey)}" style="margin-bottom:10px;" />
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" id="set-save-key">Зберегти ключ</button>
          <button class="btn btn-outline btn-sm" id="set-clear-key">Очистити</button>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🎮 Навчання та вигляд</div>
        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">♾️ Безкінечні серця</div>
            <div class="muted">Не діє на екзаменах розділу (там завжди макс. 1 помилка)</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-inf-hearts" ${state.infiniteHearts ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">🌙 Темна тема</div>
            <div class="muted">Комфортна для очей увечері</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-dark" ${state.theme === 'dark' ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div style="margin-top:10px;">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="muted" style="font-weight:700;">Денна норма XP (1 урок = ${XP_LESSON} XP):</span>
            <span style="font-size:12.5px;font-weight:800;color:var(--green);">~${Math.max(1, Math.round(state.dailyGoal / XP_LESSON))} ур./день</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
            ${[20, 40, 60, 100, 150, 200].map((g) => `<button class="chip-btn ${state.dailyGoal === g ? 'active' : ''}" data-goal="${g}">${g} XP</button>`).join('')}
          </div>
          <div class="goal-stepper">
            <button type="button" class="icon-btn" id="set-goal-minus" aria-label="Зменшити на 10">−10</button>
            <input type="number" class="text-input goal-num-input" id="set-goal-input" min="10" max="1000" step="10" value="${state.dailyGoal}" />
            <button type="button" class="icon-btn" id="set-goal-plus" aria-label="Збільшити на 10">+10</button>
            <button type="button" class="btn btn-primary btn-sm" id="set-goal-save">OK</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">💾 Резервна копія прогресу</div>
        <div class="row-between" style="padding:4px 0 10px;">
          <div>
            <div style="font-weight:700;">📅 Щотижневий експорт на телефон</div>
            <div class="muted">Раз на 7 днів нагадує зберегти <strong>slovosk_backup.json</strong> (останній: ${formatShortDate(state.lastFileExportAt)})</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-weekly-backup" ${state.weeklyBackupEnabled ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" id="set-export">⬇️ Експорт JSON</button>
          <button class="btn btn-outline btn-sm" id="set-import">⬆️ Імпорт JSON</button>
          ${getAutoSnapshot() ? `<button class="btn btn-outline btn-sm" id="set-restore-snap">⏪ Авто-копія (${formatShortDate(getAutoSnapshot().savedAt)})</button>` : ''}
          <button class="btn btn-outline btn-sm" id="set-reset" style="color:var(--red);">🗑️ Скинути все</button>
          <input type="file" id="import-file" accept=".json" class="hidden" />
        </div>
        <div class="muted" style="margin-top:9px;font-size:11.5px;">
          Внутрішня авто-копія сама перезаписує стару щотижня й перед скиданням. Браузер Android не дозволяє сайтам автоматично видаляти файли в «Завантаженнях», але <strong>slovosk_backup.json</strong> важить лише ~3 КБ.
        </div>
      </div>
    `;

    document.getElementById('set-refresh-mods').onclick = () => {
      showToast('Оновлюємо курс...');
      location.reload();
    };

    const installBtn = document.getElementById('set-pwa-install');
    if (installBtn) {
      installBtn.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        renderSettingsTab();
      };
    }

    document.getElementById('set-test-tts').onclick = () => SpeechEngine.speak('Dobrý deň! Hľadám prácu na Slovensku.', false);
    document.getElementById('set-test-slow').onclick = () => SpeechEngine.speak('Dobrý deň! Hľadám prácu na Slovensku.', true);

    const vs = document.getElementById('set-voice-select');
    if (vs) {
      vs.onchange = () => { state.preferredVoiceURI = vs.value; saveState(); SpeechEngine.speak('Dobrý deň, ďakujem.', false); };
    }

    document.getElementById('set-autospeak').onchange = (e) => { state.autoSpeak = e.target.checked; saveState(); };
    document.getElementById('set-sfx').onchange = (e) => { state.soundFx = e.target.checked; saveState(); };
    document.getElementById('set-mic').onchange = (e) => { state.micEnabled = e.target.checked; saveState(); };
    document.getElementById('set-inf-hearts').onchange = (e) => {
      state.infiniteHearts = e.target.checked;
      if (state.infiniteHearts) state.hearts = 5;
      saveState();
    };
    document.getElementById('set-dark').onchange = (e) => { state.theme = e.target.checked ? 'dark' : 'light'; applyTheme(); saveState(); };

    function applyDailyGoal(val) {
      const clamped = Math.max(10, Math.min(1000, Math.round((Number(val) || 60) / 5) * 5));
      state.dailyGoal = clamped;
      saveState();
      renderSettingsTab();
      showToast(`Денна норма: ${clamped} XP 🎯`);
    }
    mainView.querySelectorAll('[data-goal]').forEach((b) => {
      b.onclick = () => applyDailyGoal(Number(b.dataset.goal));
    });
    const goalInp = document.getElementById('set-goal-input');
    document.getElementById('set-goal-minus').onclick = () => applyDailyGoal((Number(goalInp.value) || state.dailyGoal) - 10);
    document.getElementById('set-goal-plus').onclick = () => applyDailyGoal((Number(goalInp.value) || state.dailyGoal) + 10);
    document.getElementById('set-goal-save').onclick = () => applyDailyGoal(goalInp.value);
    goalInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyDailyGoal(goalInp.value); });

    document.getElementById('set-save-key').onclick = () => {
      state.geminiKey = document.getElementById('set-gemini-key').value.trim();
      saveState();
      showToast(state.geminiKey ? 'Ключ Gemini збережено! ✨' : 'Ключ порожній');
    };
    document.getElementById('set-clear-key').onclick = () => { state.geminiKey = ''; saveState(); renderSettingsTab(); };

    document.getElementById('set-weekly-backup').onchange = (e) => {
      state.weeklyBackupEnabled = e.target.checked;
      if (state.weeklyBackupEnabled && !state.lastFileExportAt) state.lastFileExportAt = Date.now();
      saveState();
      showToast(state.weeklyBackupEnabled ? 'Щотижневий бекап увімкнено 📅' : 'Щотижневі нагадування вимкнено');
    };

    document.getElementById('set-export').onclick = async () => {
      await exportProgressFile();
      renderSettingsTab();
    };

    const snapBtn = document.getElementById('set-restore-snap');
    if (snapBtn) {
      snapBtn.onclick = () => {
        const snap = getAutoSnapshot();
        if (!snap) return;
        openModal(`
          <h3>⏪ Відновити внутрішню авто-копію?</h3>
          <p class="muted" style="margin-bottom:16px;">Збережено: <strong>${formatShortDate(snap.savedAt)}</strong> • Уроків: <strong>${(snap.data.completedLessons || []).length}</strong> • XP: <strong>${snap.data.xp || 0}</strong>.</p>
          <div style="display:flex;gap:10px;">
            <button class="btn btn-outline btn-full" id="m-cancel-snap">Скасувати</button>
            <button class="btn btn-primary btn-full" id="m-ok-snap">Відновити</button>
          </div>
        `);
        document.getElementById('m-cancel-snap').onclick = closeModal;
        document.getElementById('m-ok-snap').onclick = () => {
          state = { ...defaultState(), ...snap.data };
          applyTheme();
          saveState();
          closeModal();
          renderSettingsTab();
          showToast('Прогрес відновлено з авто-копії! ✓');
        };
      };
    }

    const importFile = document.getElementById('import-file');
    document.getElementById('set-import').onclick = () => importFile.click();
    importFile.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state = { ...defaultState(), ...JSON.parse(reader.result) };
          applyTheme();
          saveState();
          renderSettingsTab();
          showToast('Прогрес відновлено! 🎉');
        } catch {
          showToast('Невірний формат JSON');
        }
      };
      reader.readAsText(file);
    };

    document.getElementById('set-reset').onclick = () => {
      openModal(`
        <h3>🗑️ Скинути весь прогрес?</h3>
        <p class="muted" style="margin-bottom:16px;">Будуть очищені пройдені уроки, екзамени, SRS, XP і серія.</p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-outline btn-full" id="m-cancel-rst">Скасувати</button>
          <button class="btn btn-danger btn-full" id="m-confirm-rst">Скинути</button>
        </div>
      `);
      document.getElementById('m-cancel-rst').onclick = closeModal;
      document.getElementById('m-confirm-rst').onclick = () => {
        state = defaultState();
        applyTheme();
        saveState();
        closeModal();
        renderSettingsTab();
        showToast('Прогрес скинуто');
      };
    };
  }

  // =====================================================
  // BOOTSTRAP
  // =====================================================
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  applyTheme();
  updateHeader();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncDailyRollover(true);
  });
  window.addEventListener('focus', () => syncDailyRollover(true));
  setInterval(() => syncDailyRollover(true), 60000);

  discoverModules().then(() => {
    syncDailyRollover(false);
    checkAutoBackupTimers();
    updateSrsBadge();
    setTab('course');
  });
})();
