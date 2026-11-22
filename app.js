(function () {
  'use strict';

  const DATA = window.SLOVOSK_DATA;
  const STORAGE_KEY = 'slovosk_state_v1';
  const DIACRITICS = ['á', 'ä', 'č', 'ď', 'é', 'í', 'ĺ', 'ľ', 'ň', 'ó', 'ô', 'ŕ', 'š', 'ť', 'ú', 'ý', 'ž'];

  // Flatten lessons & words for quick lookup
  const ALL_LESSONS = [];
  const ALL_WORDS = [];
  const WORD_MAP = {};
  DATA.course.forEach((sec) => {
    sec.lessons.forEach((les) => {
      ALL_LESSONS.push({ ...les, sectionId: sec.id, sectionTitle: sec.title, sectionColor: sec.color });
      les.words.forEach((w) => {
        const enriched = { ...w, lessonId: les.id, sectionId: sec.id, lessonTitle: les.title };
        ALL_WORDS.push(enriched);
        WORD_MAP[w.id] = enriched;
      });
    });
  });

  // =====================================================
  // STATE MANAGEMENT
  // =====================================================
  const todayKey = () => new Date().toISOString().slice(0, 10);

  const defaultState = () => ({
    xp: 0,
    dailyXp: 0,
    dailyGoal: 50,
    lastDay: todayKey(),
    streak: 0,
    streakDay: '',
    hearts: 5,
    infiniteHearts: false,
    freeUnlock: false,
    completedLessons: [],
    weakWords: [],
    knownWords: [],
    theme: 'dark',
    soundFx: true,
    autoSpeak: true,
    micEnabled: true,
    preferredVoiceURI: '',
    geminiKey: '',
    refSubtab: 'dict',
    aiScenario: 'interview'
  });

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = { ...defaultState(), ...JSON.parse(raw) };
      const today = todayKey();
      if (parsed.lastDay !== today) {
        parsed.dailyXp = 0;
        parsed.lastDay = today;
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
  }

  function addXP(amount) {
    const today = todayKey();
    if (state.lastDay !== today) {
      state.dailyXp = 0;
      state.lastDay = today;
    }
    state.xp += amount;
    state.dailyXp += amount;

    if (state.streakDay !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (state.streakDay === yesterday) {
        state.streak += 1;
      } else {
        state.streak = Math.max(1, state.streak === 0 ? 1 : 1);
      }
      state.streakDay = today;
    }
    saveState();
  }

  // =====================================================
  // SOUND FX (Web Audio API — 100% Offline)
  // =====================================================
  const SoundFX = (() => {
    let ctx = null;
    function getCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
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
  // ANDROID CHROME TTS ENGINE (sk-SK)
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
      // Android Chrome often populates voices asynchronously
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

    function pickBestVoice() {
      const skVoices = getSlovakVoices();
      if (state.preferredVoiceURI) {
        const chosen = voices.find((v) => v.voiceURI === state.preferredVoiceURI);
        if (chosen) return chosen;
      }
      if (skVoices.length > 0) {
        const googleSk = skVoices.find((v) => /google/i.test(v.name));
        return googleSk || skVoices[0];
      }
      // Fallback: Czech voice is closest if Slovak not installed yet
      const csVoice = voices.find((v) => (v.lang || '').toLowerCase().startsWith('cs'));
      return csVoice || null;
    }

    function speak(text, slow = false) {
      if (!supported) {
        showToast('Озвучка недоступна в цьому браузері. Відкрий у Chrome.');
        return false;
      }
      refreshVoices();
      try {
        window.speechSynthesis.cancel();
      } catch {}

      const clean = String(text || '').trim();
      if (!clean) return false;

      // Short delay fixes Android Chrome speechSynthesis lockup after cancel()
      setTimeout(() => {
        try {
          const u = new SpeechSynthesisUtterance(clean);
          u.lang = 'sk-SK';
          u.rate = slow ? 0.62 : 0.94;
          u.pitch = 1.0;
          const v = pickBestVoice();
          if (v) {
            u.voice = v;
            if ((v.lang || '').toLowerCase().startsWith('sk')) {
              u.lang = v.lang;
            }
          }
          currentUtterance = u; // prevent GC on Android
          u.onend = () => { currentUtterance = null; };
          u.onerror = () => { currentUtterance = null; };
          window.speechSynthesis.speak(u);
        } catch {
          showToast('Не вдалося запустити голос. Перевір налаштування TTS.');
        }
      }, 45);
      return true;
    }

    return {
      supported,
      refreshVoices,
      getAllVoices: () => voices,
      getSlovakVoices,
      pickBestVoice,
      speak,
      onChange(fn) { listeners.push(fn); }
    };
  })();

  // =====================================================
  // SPEECH RECOGNITION ENGINE (sk-SK)
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
        for (let i = 0; i < e.results[0].length; i++) {
          alts.push(e.results[0][i].transcript);
        }
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
      try {
        rec.start();
      } catch {
        onError && onError('Не вдалося запустити мікрофон.');
      }
    }

    return { supported: !!SR, listen, stop };
  })();

  // =====================================================
  // STRING NORMALIZATION & UTILITIES
  // =====================================================
  function stripDiacritics(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function normStrict(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[.,!?;:«»"()—–-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2600);
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
  // MODAL HELPERS (Hearts, Install, Backup)
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
    if (e.target === modalOverlay && modalOverlay.dataset.dismissible === '1') {
      closeModal();
    }
  });

  function openHeartsModal(fromZero = false) {
    const statusText = state.infiniteHearts
      ? 'Увімкнено режим <strong>♾️ Безкінечні серця</strong> — можеш помилятися без обмежень.'
      : `Зараз у тебе <strong>${state.hearts} / 5 ❤️</strong>. Поновлення абсолютно безкоштовне.`;

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
      showToast(state.infiniteHearts ? 'Безкінечні серця увімкнено ♾️' : 'Звичайний режим сердець (5/5)');
    };
    const closeBtn = document.getElementById('m-close-hearts');
    if (closeBtn) closeBtn.onclick = closeModal;
    const exitBtn = document.getElementById('m-exit-lesson');
    if (exitBtn) exitBtn.onclick = () => { closeModal(); exitLesson(); };
  }

  // =====================================================
  // NAVIGATION & TABS
  // =====================================================
  let activeTab = 'course';
  const mainView = document.getElementById('main-view');

  function setTab(tab) {
    activeTab = tab;
    MicEngine.stop();
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
  // TAB 1: COURSE (Zero to A1)
  // =====================================================
  function isLessonUnlocked(idx) {
    if (state.freeUnlock || idx === 0) return true;
    const prevId = ALL_LESSONS[idx - 1].id;
    return state.completedLessons.includes(prevId);
  }

  function renderCourseTab() {
    const pct = Math.min(100, Math.round((state.dailyXp / state.dailyGoal) * 100));
    const doneCount = state.completedLessons.length;
    const totalLessons = ALL_LESSONS.length;
    const nextIdx = ALL_LESSONS.findIndex((l) => !state.completedLessons.includes(l.id));

    let html = `
      <div class="card goal-card">
        <div class="row-between">
          <div>
            <div style="font-weight:900;font-size:15px;">🎯 Ціль на сьогодні</div>
            <div class="muted">Пройдено уроків: <strong>${doneCount} / ${totalLessons}</strong> (${ALL_WORDS.length} слів A1)</div>
          </div>
          <div style="font-weight:900;color:var(--green);font-size:15px;">${state.dailyXp} / ${state.dailyGoal} XP</div>
        </div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
      </div>

      <div class="mode-toggle-bar">
        <div class="muted" style="font-weight:700;">Хронологія курсу</div>
        <button class="chip-btn ${state.freeUnlock ? 'active' : ''}" id="toggle-unlock-mode">
          ${state.freeUnlock ? '🔓 Вільний доступ' : '🔒 По порядку'}
        </button>
      </div>
    `;

    let globalIdx = 0;
    DATA.course.forEach((sec) => {
      html += `
        <div class="section-banner" style="background:${sec.color};">
          <h2>${escHtml(sec.title)}</h2>
          <p>${escHtml(sec.subtitle)}</p>
        </div>
        <div class="lesson-list">
      `;
      sec.lessons.forEach((les) => {
        const idx = globalIdx++;
        const done = state.completedLessons.includes(les.id);
        const unlocked = isLessonUnlocked(idx);
        const isNext = idx === nextIdx;
        const cls = done ? 'done' : (isNext ? 'next-up' : (!unlocked ? 'locked' : ''));
        const actionTag = done ? 'Повторити' : (unlocked ? 'Старт' : '🔒');

        html += `
          <button class="lesson-card ${cls}" data-lesson-id="${les.id}" ${unlocked ? '' : 'data-locked="1"'}>
            <div class="lesson-icon-box">
              <span>${les.icon}</span>
              ${done ? '<span class="lesson-check-badge">✓</span>' : ''}
            </div>
            <div class="lesson-meta">
              <div class="lesson-code">Урок ${escHtml(les.code)} • 6 слів</div>
              <div class="lesson-title">${escHtml(les.title)}</div>
              <div class="lesson-desc">${escHtml(les.desc)}</div>
            </div>
            <div class="lesson-action-tag">${actionTag}</div>
          </button>
        `;
      });
      html += `</div>`;
    });

    mainView.innerHTML = html;

    document.getElementById('toggle-unlock-mode').onclick = () => {
      state.freeUnlock = !state.freeUnlock;
      saveState();
      SoundFX.tap();
      renderCourseTab();
      showToast(state.freeUnlock ? 'Усі 24 уроки відкрито!' : 'Увімкнено сувору хронологію');
    };

    mainView.querySelectorAll('.lesson-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (card.dataset.locked === '1') {
          showToast('Спочатку пройди попередній урок (або увімкни «Вільний доступ» вгорі)');
          return;
        }
        startLesson(card.dataset.lessonId);
      });
    });
  }

  // =====================================================
  // LESSON ENGINE (Strict 4-Stage Zero-to-Hero)
  // =====================================================
  let activeLesson = null;

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
    const w = lesson.words; // 6 words
    const g1 = w.slice(0, 3);
    const g2 = w.slice(3, 6);
    const q = [];

    // STAGE 1: Introduce words 1..3 one by one
    g1.forEach((word) => q.push({ type: 'intro', word }));

    // STAGE 2: Practice ONLY words 1..3
    q.push({ type: 'mc_sk_uk', word: g1[0], pool: w });
    q.push({ type: 'mc_uk_sk', word: g1[1], pool: w });
    if (SpeechEngine.supported) {
      q.push({ type: 'listen_mc', word: g1[2], pool: w });
    } else {
      q.push({ type: 'mc_sk_uk', word: g1[2], pool: w });
    }
    q.push({ type: 'mc_uk_sk', word: g1[0], pool: w });

    // STAGE 3: Introduce words 4..6 one by one
    g2.forEach((word) => q.push({ type: 'intro', word }));

    // Practice ONLY words 4..6
    q.push({ type: 'mc_sk_uk', word: g2[0], pool: w });
    q.push({ type: 'mc_uk_sk', word: g2[1], pool: w });
    if (SpeechEngine.supported) {
      q.push({ type: 'listen_mc', word: g2[2], pool: w });
    } else {
      q.push({ type: 'mc_sk_uk', word: g2[2], pool: w });
    }

    // Match all 6 words of this lesson!
    q.push({ type: 'match_pairs', words: w });

    // STAGE 4: Build sentences from learned words + Typing + Speaking
    const sents = lesson.sentences || [];
    if (sents[0]) q.push({ type: 'word_bank', sentence: sents[0], lessonWords: w });
    if (sents[1]) q.push({ type: 'word_bank', sentence: sents[1], lessonWords: w });

    // Typing a core word from this lesson
    const typeWord = shuffle(w)[0];
    q.push({ type: 'typing', word: typeWord });

    // Optional speaking exercise (if enabled & supported)
    if (state.micEnabled && MicEngine.supported && sents[2]) {
      q.push({ type: 'speak', sentence: sents[2] });
    } else if (sents[2]) {
      q.push({ type: 'word_bank', sentence: sents[2], lessonWords: w });
    }

    return q;
  }

  function startLesson(lessonId, customQueue = null, customTitle = '') {
    if (!state.infiniteHearts && state.hearts <= 0) {
      openHeartsModal(true);
      return;
    }
    const lesson = ALL_LESSONS.find((l) => l.id === lessonId) || null;
    const queue = customQueue || buildLessonQueue(lesson);

    activeLesson = {
      id: lesson ? lesson.id : 'custom',
      title: customTitle || (lesson ? `Урок ${lesson.code}: ${lesson.title}` : 'Тренування'),
      isOfficial: !!lesson && !customQueue,
      queue,
      initialTotal: queue.length,
      idx: 0,
      mistakes: 0,
      xpEarned: 0,
      selection: null,
      checked: false
    };

    const overlay = document.getElementById('lesson-overlay');
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    updateHeader();
    renderCurrentExercise();
  }

  function exitLesson() {
    MicEngine.stop();
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    hideFeedback();
    const overlay = document.getElementById('lesson-overlay');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    activeLesson = null;
    if (activeTab === 'course') renderCourseTab();
    else if (activeTab === 'review') renderReviewTab();
  }

  document.getElementById('lesson-close').onclick = exitLesson;

  function updateLessonProgress() {
    if (!activeLesson) return;
    const pct = Math.min(100, Math.round((activeLesson.idx / activeLesson.queue.length) * 100));
    document.getElementById('lesson-progress-fill').style.width = pct + '%';
  }

  function showFeedback(isOk, title, sub, audioText = '', isWarning = false) {
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
    nextBtn.textContent = 'ДАЛІ';

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
    if (!activeLesson) return;
    if (!state.infiniteHearts && state.hearts <= 0) {
      openHeartsModal(true);
      return;
    }
    activeLesson.idx += 1;
    if (activeLesson.idx >= activeLesson.queue.length) {
      finishLesson();
    } else {
      renderCurrentExercise();
    }
  };

  function recordMistake(ex) {
    activeLesson.mistakes += 1;
    if (!state.infiniteHearts) {
      state.hearts = Math.max(0, state.hearts - 1);
      saveState();
    }
    if (ex.word && ex.word.id && !state.weakWords.includes(ex.word.id)) {
      state.weakWords.push(ex.word.id);
      saveState();
    }
    // Re-queue once at end for mastery
    if (!ex._retried) {
      activeLesson.queue.push({ ...ex, _retried: true });
    }
  }

  function markWordMastered(wordId) {
    if (!wordId) return;
    if (!state.knownWords.includes(wordId)) state.knownWords.push(wordId);
  }

  function renderCurrentExercise() {
    if (!activeLesson) return;
    MicEngine.stop();
    hideFeedback();
    updateLessonProgress();

    const ex = activeLesson.queue[activeLesson.idx];
    const stage = document.getElementById('lesson-stage');
    const actionBtn = document.getElementById('lesson-action-btn');
    const footer = document.getElementById('lesson-footer');
    footer.classList.remove('hidden');
    activeLesson.selection = null;
    activeLesson.checked = false;

    const retryBadge = ex._retried ? `<span class="badge-warn" style="margin-bottom:8px;">🔁 Виправляємо помилку</span>` : '';

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
        activeLesson.idx += 1;
        renderCurrentExercise();
      };
      return;
    }

    // 2. MULTIPLE CHOICE (SK -> UK, UK -> SK, LISTEN -> UK)
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
        promptHtml = `
          <div class="prompt-box">
            <div class="prompt-main">${escHtml(w.uk)}</div>
          </div>
        `;
      } else {
        kicker = 'АУДІЮВАННЯ';
        title = 'Послухай і обери переклад';
        promptHtml = `
          <div class="card" style="text-align:center;padding:20px;">
            <div class="audio-controls" style="margin:0;">
              <button class="audio-btn" id="prompt-audio">🔊 Слухати</button>
              <button class="audio-btn slow" id="prompt-slow">🐢 Повільно</button>
            </div>
            <div class="muted" style="margin-top:10px;">Не чути? Натисни ще раз або перевір озвучку в налаштуваннях</div>
          </div>
        `;
      }

      stage.innerHTML = `
        ${retryBadge}
        <div class="ex-kicker">${kicker}</div>
        <div class="ex-title">${title}</div>
        ${promptHtml}
        <div class="options-list" id="mc-options">
          ${opts.map((o, i) => `
            <button class="option-btn" data-id="${o.id}" data-idx="${i}">
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
          if (activeLesson.checked) return;
          SoundFX.tap();
          stage.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          activeLesson.selection = btn.dataset.id;
          if (ex.type === 'mc_uk_sk' && SpeechEngine.supported) {
            const chosenObj = opts.find((o) => o.id === btn.dataset.id);
            if (chosenObj) SpeechEngine.speak(chosenObj.sk, false);
          }
          actionBtn.disabled = false;
        };
      });

      actionBtn.onclick = () => {
        if (!activeLesson.selection || activeLesson.checked) return;
        activeLesson.checked = true;
        const ok = activeLesson.selection === w.id;
        stage.querySelectorAll('.option-btn').forEach((b) => {
          if (b.dataset.id === w.id) b.classList.add('correct');
          else if (b.dataset.id === activeLesson.selection && !ok) b.classList.add('wrong');
        });
        if (ok) {
          SoundFX.ok();
          activeLesson.xpEarned += 5;
          markWordMastered(w.id);
          showFeedback(true, 'Чудово!', `${escHtml(w.sk)} [${escHtml(w.tr)}] — ${escHtml(w.uk)}`, w.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильна відповідь:', `<strong>${escHtml(w.sk)}</strong> [${escHtml(w.tr)}] = ${escHtml(w.uk)}`, w.sk);
        }
      };
      return;
    }

    // 3. MATCH PAIRS (All 6 words)
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
          markWordMastered(lEl.dataset.id);
          matchedCount += 1;
          selLeft = null;
          selRight = null;
          if (matchedCount === ex.words.length) {
            activeLesson.xpEarned += 10;
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

    // 4. WORD BANK (Sentence assembly from learned words)
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
        ${retryBadge}
        <div class="ex-kicker">ЗБЕРИ РЕЧЕННЯ</div>
        <div class="ex-title">Склади фразу словацькою</div>
        <div class="prompt-box">
          <div>
            <div class="prompt-main">${escHtml(s.uk)}</div>
            <div class="muted" style="margin-top:4px;">Збери зі знайомих слів нижче</div>
          </div>
          <button class="audio-mini-btn" id="wb-hint-audio" title="Підказка аудіо">🔊</button>
        </div>
        <div class="answer-zone" id="wb-answer"></div>
        <div class="bank-zone" id="wb-bank"></div>
      `;

      document.getElementById('wb-hint-audio').onclick = () => SpeechEngine.speak(s.sk, true);

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
            if (activeLesson.checked) return;
            SoundFX.tap();
            picked = picked.filter((p) => p.id !== Number(btn.dataset.id));
            renderBank();
          };
        });
        bankEl.querySelectorAll('.word-chip').forEach((btn) => {
          btn.onclick = () => {
            if (activeLesson.checked) return;
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
        if (activeLesson.checked || picked.length === 0) return;
        activeLesson.checked = true;
        const userStr = picked.map((p) => p.txt).join(' ');
        const ok = normLoose(userStr) === normLoose(s.sk);
        if (ok) {
          SoundFX.ok();
          activeLesson.xpEarned += 8;
          showFeedback(true, 'Відмінно!', `${escHtml(s.sk)} [${escHtml(s.tr)}]`, s.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильний варіант:', `<strong>${escHtml(s.sk)}</strong><br/>[${escHtml(s.tr)}]`, s.sk);
        }
      };
      return;
    }

    // 5. TYPING WITH DIACRITICS BAR
    if (ex.type === 'typing') {
      const w = ex.word;
      stage.innerHTML = `
        ${retryBadge}
        <div class="ex-kicker">ПИСЬМО</div>
        <div class="ex-title">Напиши словацькою</div>
        <div class="prompt-box">
          <div>
            <div class="prompt-main">${escHtml(w.uk)}</div>
            <div class="muted" style="margin-top:4px;">Вимова: [${escHtml(w.tr)}]</div>
          </div>
          <button class="audio-mini-btn" id="type-audio" title="Послухати">🔊</button>
        </div>
        <input type="text" class="text-input" id="type-input" placeholder="Введи слово..." autocomplete="off" autocorrect="off" spellcheck="false" />
        <div class="diacritic-bar" id="dia-bar">
          ${DIACRITICS.map((ch) => `<button type="button" class="dia-key" data-ch="${ch}">${ch}</button>`).join('')}
        </div>
      `;

      const inp = document.getElementById('type-input');
      document.getElementById('type-audio').onclick = () => SpeechEngine.speak(w.sk, true);

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
      inp.addEventListener('input', () => {
        actionBtn.disabled = inp.value.trim().length === 0;
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !actionBtn.disabled) actionBtn.click();
      });

      actionBtn.onclick = () => {
        if (activeLesson.checked) return;
        activeLesson.checked = true;
        const val = inp.value.trim();
        const exact = normStrict(val) === normStrict(w.sk);
        const loose = normLoose(val) === normLoose(w.sk);

        if (exact) {
          SoundFX.ok();
          activeLesson.xpEarned += 10;
          markWordMastered(w.id);
          showFeedback(true, 'Ідеально!', `${escHtml(w.sk)} [${escHtml(w.tr)}]`, w.sk);
        } else if (loose) {
          SoundFX.ok();
          activeLesson.xpEarned += 8;
          markWordMastered(w.id);
          showFeedback(true, 'Майже ідеально! (Зараховано)', `Зверни увагу на діакритику: <strong>${escHtml(w.sk)}</strong>`, w.sk);
        } else {
          SoundFX.bad();
          recordMistake(ex);
          showFeedback(false, 'Правильне написання:', `<strong>${escHtml(w.sk)}</strong> [${escHtml(w.tr)}]`, w.sk);
        }
      };
      return;
    }

    // 6. SPEAKING CHECK (Microphone sk-SK)
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
        activeLesson.idx += 1;
        if (activeLesson.idx >= activeLesson.queue.length) finishLesson();
        else renderCurrentExercise();
      };

      const micBtn = document.getElementById('sp-mic-btn');
      const statusEl = document.getElementById('sp-status');
      const heardEl = document.getElementById('sp-heard');

      micBtn.onclick = () => {
        if (isRec) {
          MicEngine.stop();
          return;
        }
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
              activeLesson.xpEarned += 10;
              showFeedback(true, 'Чудова вимова!', `Ти сказав: «${escHtml(transcript)}»`, s.sk);
            } else {
              SoundFX.bad();
              statusEl.textContent = 'Спробуй ще раз чіткіше (наголос на 1-й склад) або пропусти.';
            }
          },
          (errMsg) => {
            statusEl.textContent = errMsg;
          },
          () => {
            isRec = false;
            micBtn.classList.remove('recording');
          }
        );
      };
    }
  }

  function finishLesson() {
    SoundFX.win();
    const xp = Math.max(15, activeLesson.xpEarned);
    addXP(xp);
    if (activeLesson.isOfficial && !state.completedLessons.includes(activeLesson.id)) {
      state.completedLessons.push(activeLesson.id);
      saveState();
    }

    const totalChecks = Math.max(1, activeLesson.queue.length);
    const acc = Math.max(50, Math.round(((totalChecks - activeLesson.mistakes) / totalChecks) * 100));

    openModal(`
      <div style="text-align:center;">
        <div style="font-size:56px;margin-bottom:6px;">🏆</div>
        <h3>Урок завершено!</h3>
        <p class="muted" style="margin-bottom:16px;">${escHtml(activeLesson.title)}</p>
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
      exitLesson();
    };
  }

  // =====================================================
  // TAB 2: REVIEW & 3D FLASHCARDS
  // =====================================================
  let fcFilter = 'unlocked';
  let fcIndex = 0;
  let fcFlipped = false;

  function getUnlockedWords() {
    if (state.freeUnlock) return ALL_WORDS;
    const ids = new Set(state.completedLessons);
    // Always include lesson 1.1
    ids.add(ALL_LESSONS[0].id);
    // Also include the next unlocked lesson
    const nextIdx = ALL_LESSONS.findIndex((l) => !state.completedLessons.includes(l.id));
    if (nextIdx >= 0) ids.add(ALL_LESSONS[nextIdx].id);
    return ALL_WORDS.filter((w) => ids.has(w.lessonId));
  }

  function renderReviewTab() {
    const weakList = state.weakWords.map((id) => WORD_MAP[id]).filter(Boolean);
    const unlockedWords = getUnlockedWords();

    let deck = unlockedWords;
    if (fcFilter === 'weak') deck = weakList;
    else if (fcFilter === 'all') deck = ALL_WORDS;
    else if (fcFilter.startsWith('sec')) deck = ALL_WORDS.filter((w) => w.sectionId === fcFilter);

    if (fcIndex >= deck.length) fcIndex = 0;
    const cardWord = deck[fcIndex] || null;

    mainView.innerHTML = `
      <div class="card">
        <div class="row-between" style="margin-bottom:10px;">
          <div>
            <div style="font-weight:900;font-size:16px;">🎯 Слабкі слова (${weakList.length})</div>
            <div class="muted">Слова, у яких були помилки під час уроків</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="rev-weak-btn" ${weakList.length === 0 ? 'disabled' : ''}>
            Тренувати слабкі (${weakList.length})
          </button>
          <button class="btn btn-blue btn-sm" id="rev-blitz-btn">⚡ Швидкий бліц (8 питань)</button>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🃏 3D-Флешкартки</div>
        <div class="scenario-strip" id="fc-filters">
          <button class="chip-btn ${fcFilter === 'unlocked' ? 'active' : ''}" data-f="unlocked">Вивчені (${unlockedWords.length})</button>
          <button class="chip-btn ${fcFilter === 'weak' ? 'active' : ''}" data-f="weak">Слабкі (${weakList.length})</button>
          <button class="chip-btn ${fcFilter === 'all' ? 'active' : ''}" data-f="all">Усі (${ALL_WORDS.length})</button>
          ${DATA.course.map((s, i) => `<button class="chip-btn ${fcFilter === s.id ? 'active' : ''}" data-f="${s.id}">Розділ ${i + 1}</button>`).join('')}
        </div>

        ${cardWord ? `
          <div class="muted" style="text-align:center;margin-top:6px;">Картка ${fcIndex + 1} з ${deck.length} • Натисни, щоб перевернути</div>
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
            <button class="btn btn-outline" id="fc-again">🔁 Повторити ще</button>
            <button class="btn btn-primary" id="fc-know">✓ Знаю</button>
          </div>
        ` : `<div class="muted" style="text-align:center;padding:24px 0;">У цій категорії поки порожньо 🎉</div>`}
      </div>
    `;

    document.getElementById('rev-weak-btn').onclick = () => {
      const q = shuffle(weakList).slice(0, 8).map((w, i) => ({
        type: i % 2 === 0 ? 'mc_sk_uk' : 'mc_uk_sk',
        word: w,
        pool: ALL_WORDS
      }));
      startLesson(null, q, 'Робота над помилками');
    };

    document.getElementById('rev-blitz-btn').onclick = () => {
      const src = shuffle(unlockedWords).slice(0, 8);
      const q = src.map((w, i) => ({
        type: i % 3 === 0 ? 'mc_sk_uk' : (i % 3 === 1 ? 'mc_uk_sk' : (SpeechEngine.supported ? 'listen_mc' : 'mc_sk_uk')),
        word: w,
        pool: unlockedWords.length >= 6 ? unlockedWords : ALL_WORDS
      }));
      startLesson(null, q, 'Швидкий бліц');
    };

    document.getElementById('fc-filters').querySelectorAll('.chip-btn').forEach((b) => {
      b.onclick = () => {
        fcFilter = b.dataset.f;
        fcIndex = 0;
        fcFlipped = false;
        renderReviewTab();
      };
    });

    const fcEl = document.getElementById('fc-card');
    if (fcEl && cardWord) {
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
        if (!state.weakWords.includes(cardWord.id)) {
          state.weakWords.push(cardWord.id);
          saveState();
        }
        SoundFX.tap();
        fcFlipped = false;
        fcIndex = (fcIndex + 1) % deck.length;
        renderReviewTab();
      };
      document.getElementById('fc-know').onclick = () => {
        state.weakWords = state.weakWords.filter((id) => id !== cardWord.id);
        markWordMastered(cardWord.id);
        saveState();
        SoundFX.ok();
        fcFlipped = false;
        fcIndex = (fcIndex + 1) % Math.max(1, deck.length);
        renderReviewTab();
      };
    }
  }

  // =====================================================
  // TAB 3: AI TUTOR (Gemini API + Offline Practice)
  // =====================================================
  const chatHistory = {}; // scenarioId -> [{role:'bot'|'user', sk, uk, tip, showUk}]

  function getScenario(id) {
    return DATA.aiScenarios.find((s) => s.id === id) || DATA.aiScenarios[0];
  }

  function ensureScenarioInit(scId) {
    if (!chatHistory[scId]) {
      const sc = getScenario(scId);
      chatHistory[scId] = [{
        role: 'bot',
        sk: sc.first_sk,
        uk: sc.first_uk,
        tip: sc.hint,
        showUk: false
      }];
    }
  }

  function offlineBotReply(scId, userText) {
    const low = normLoose(userText);
    if (scId === 'interview') {
      if (/volam|dmytro|ukrajin|dobry|ahoj/.test(low)) {
        return {
          sk: 'Teší ma! Hľadáte prácu na plný úväzok? Máte skúsenosť alebo vodičský preukaz?',
          uk: 'Приємно познайомитися! Ви шукаєте роботу на повну зайнятість? Маєте досвід або водійські права?',
          tip: 'Спробуй відповісти: «Áno, hľadám prácu na plný úväzok. Mám vodičský preukaz.»'
        };
      }
      if (/ano|mam|vodic|skusen|plny|prac/.test(low)) {
        return {
          sk: 'Výborne! Kedy môžete nastúpiť? Môžete začať v pondelok o ôsmej?',
          uk: 'Чудово! Коли Ви можете вийти на роботу? Можете почати в понеділок о восьмій?',
          tip: 'Спробуй: «Áno, môžem začať v pondelok. Aký je plat v čistom?»'
        };
      }
      if (/plat|kolko|euro|peniaz/.test(low)) {
        return {
          sk: 'Plat je 1050 eur v čistom plus príplatky za nočné zmeny. Vyhovuje vám to?',
          uk: 'Зарплата 1050 євро на руки плюс доплати за нічні зміни. Вам це підходить?',
          tip: 'Відповідь: «Áno, ďakujem. Som spoľahlivý a rýchlo sa učím.»'
        };
      }
      return {
        sk: 'Rozumiem. Povedzte mi ešte: môžete pracovať aj na rannú a nočnú zmenu?',
        uk: 'Розумію. Скажіть мені ще: Ви можете працювати і в ранкову, і в нічну зміну?',
        tip: 'Підключи безкоштовний ключ Gemini у Налаштуваннях, щоб ШІ відповідав повністю вільно!'
      };
    }
    if (scId === 'shift') {
      if (/ano|rozumiem|ok|dobre/.test(low)) {
        return {
          sk: 'Super! Prosím, prines dve krabice a skontroluj kvalitu. Keď bude hotovo, povedz mi.',
          uk: 'Супер! Будь ласка, принеси дві коробки і перевір якість. Коли буде готово — скажи мені.',
          tip: 'Спробуй відповісти: «Dobre, rozumiem.» або «Majster, je to hotovo.»'
        };
      }
      if (/hotovo|stroj|nefunguje|chyba|problem/.test(low)) {
        return {
          sk: 'Ďakujem, že si povedal! Pozriem sa na to. O desiatej je prestávka.',
          uk: 'Дякую, що сказав! Я подивлюся на це. О десятій перерва.',
          tip: '«Pozriem sa na to» = Я подивлюся на це.'
        };
      }
      return {
        sk: 'Pozor, paleta vpravo! Potrebuješ pomoc alebo rukavice?',
        uk: 'Обережно, палета праворуч! Тобі потрібна допомога чи рукавички?',
        tip: 'Спробуй: «Áno, potrebujem rukavice, ďakujem.»'
      };
    }
    if (scId === 'shop') {
      if (/chlieb|voda|mlieko|syr|maso|caj|prosim/.test(low)) {
        return {
          sk: 'Nech sa páči, spolu je to 6 eur a 50 centov. Kartou alebo v hotovosti?',
          uk: 'Прошу, разом це 6 євро 50 центів. Карткою чи готівкою?',
          tip: 'Відповідь на касі: «Kartou, prosím.» + «Bloček nie, ďakujem.»'
        };
      }
      return {
        sk: 'Ďakujem pekne! Chcete aj bloček? Pekný deň, dovidenia!',
        uk: 'Дуже дякую! Хочете також чек? Гарного дня, до побачення!',
        tip: 'Для живого діалогу на будь-які теми додай безкоштовний ключ Gemini в Налаштуваннях.'
      };
    }
    return {
      sk: 'Ahoj! Pre živé vysvetlenia gramatiky pridaj svoj bezplatný Gemini API kľúč.',
      uk: 'Для живих відповідей репетитора на будь-які твої питання встав безкоштовний ключ Google AI Studio у вкладці «Налашт.» — це займає 1 хвилину.',
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
        if (!res.ok) {
          lastErr = data?.error?.message || `HTTP ${res.status}`;
          continue;
        }
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          return {
            sk: parsed.sk || raw,
            uk: parsed.uk || '',
            tip: parsed.tip || ''
          };
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
    ensureScenarioInit(sc.id);
    const msgs = chatHistory[sc.id];
    const hasKey = !!state.geminiKey.trim();

    mainView.innerHTML = `
      <div class="chat-wrap">
        <div class="scenario-strip" id="ai-scenarios">
          ${DATA.aiScenarios.map((s) => `
            <button class="chip-btn ${s.id === sc.id ? 'active' : ''}" data-sc="${s.id}">${escHtml(s.name)}</button>
          `).join('')}
        </div>

        <div class="row-between" style="margin-bottom:6px;padding:6px 10px;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;">
          <div style="font-size:12.5px;">
            ${hasKey
              ? '<span class="badge-ok">✨ Gemini AI активний</span>'
              : '<span class="badge-warn">⚡ Офлайн-тренажер</span> <span class="muted">Додай безкоштовний ключ для живого ШІ</span>'
            }
          </div>
          <div style="display:flex;gap:6px;">
            ${!hasKey ? '<button class="msg-mini-btn" id="ai-go-key">🔑 Ключ</button>' : ''}
            <button class="msg-mini-btn" id="ai-reset">↻ Скинути</button>
          </div>
        </div>

        <div class="chat-messages" id="chat-messages">
          ${msgs.map((m, idx) => {
            if (m.role === 'user') {
              return `<div class="msg user">${escHtml(m.text)}</div>`;
            }
            return `
              <div class="msg bot">
                <div style="font-weight:800;">${escHtml(m.sk)}</div>
                <div class="msg-actions">
                  <button class="msg-mini-btn" data-speak="${idx}">🔊 Слухати</button>
                  <button class="msg-mini-btn" data-slow="${idx}">🐢 Повільно</button>
                  ${m.uk ? `<button class="msg-mini-btn" data-tr="${idx}">${m.showUk ? 'Сховати переклад' : '🇺🇦 Переклад'}</button>` : ''}
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
      b.onclick = () => {
        state.aiScenario = b.dataset.sc;
        saveState();
        renderAiTab();
      };
    });

    const goKey = document.getElementById('ai-go-key');
    if (goKey) goKey.onclick = () => setTab('settings');

    document.getElementById('ai-reset').onclick = () => {
      delete chatHistory[sc.id];
      renderAiTab();
    };

    msgBox.querySelectorAll('[data-speak]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(msgs[Number(b.dataset.speak)].sk, false);
    });
    msgBox.querySelectorAll('[data-slow]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(msgs[Number(b.dataset.slow)].sk, true);
    });
    msgBox.querySelectorAll('[data-tr]').forEach((b) => {
      b.onclick = () => {
        const m = msgs[Number(b.dataset.tr)];
        m.showUk = !m.showUk;
        renderAiTab();
      };
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
        msgs.push({ role: 'bot', sk: 'Друкує відповідь...', uk: '', tip: '', _loading: true });
        renderAiTab();
        try {
          const reply = await callGemini(sc, msgs.slice(0, -1), txt);
          msgs.pop();
          msgs.push({ role: 'bot', ...reply, showUk: sc.id === 'grammar' });
          addXP(3);
          if (state.autoSpeak && SpeechEngine.supported && reply.sk) {
            SpeechEngine.speak(reply.sk, false);
          }
        } catch (err) {
          msgs.pop();
          msgs.push({
            role: 'bot',
            sk: 'Помилка підключення до Gemini API.',
            uk: err.message,
            tip: 'Перевір ключ у вкладці Налаштування або інтернет-з’єднання.',
            showUk: true
          });
        }
        renderAiTab();
      } else {
        setTimeout(() => {
          const reply = offlineBotReply(sc.id, txt);
          msgs.push({ role: 'bot', ...reply, showUk: false });
          addXP(2);
          renderAiTab();
          if (state.autoSpeak && SpeechEngine.supported) SpeechEngine.speak(reply.sk, false);
        }, 320);
      }
    }

    sendBtn.onclick = sendChat;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

    const micBtn = document.getElementById('chat-mic');
    if (micBtn) {
      micBtn.onclick = () => {
        micBtn.textContent = '🔴';
        MicEngine.listen(
          (transcript) => {
            inp.value = transcript;
            inp.focus();
          },
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
      const filtered = ALL_WORDS.filter((w) =>
        !q || normLoose(w.sk).includes(q) || normLoose(w.uk).includes(q)
      );
      body = `
        <input type="search" class="text-input" id="dict-search" placeholder="🔍 Пошук словацькою або українською..." value="${escHtml(dictQuery)}" style="margin-bottom:12px;" />
        <div class="muted" style="margin-bottom:8px;">Показано слів: ${filtered.length} з ${ALL_WORDS.length}</div>
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
      body = `
        <div class="card">
          <div style="font-weight:900;font-size:16px;margin-bottom:6px;">🗣️ Правила читання для українців</div>
          <div class="muted">Словацька читається дуже логічно — достатньо запам’ятати ці 9 правил.</div>
        </div>
        ${DATA.pronunciation.map((r) => `
          <div class="card" style="padding:12px 14px;">
            <div style="font-weight:900;color:var(--blue);font-size:15px;">${escHtml(r.symbol)}</div>
            <div style="font-weight:700;margin:3px 0;">${escHtml(r.sound)}</div>
            <div class="muted">Приклади: ${escHtml(r.ex)}</div>
          </div>
        `).join('')}
      `;
    } else if (st === 'traps') {
      body = `
        <div class="card">
          <div style="font-weight:900;font-size:16px;margin-bottom:6px;">⚠️ 16 «фальшивих друзів»</div>
          <div class="muted">Слова, які звучать знайомо, але означають зовсім інше!</div>
        </div>
        ${DATA.falseFriends.map((f) => `
          <div class="dict-row">
            <div>
              <div style="font-weight:900;font-size:15px;">${escHtml(f.sk)} → <span style="color:var(--green);">${escHtml(f.uk)}</span></div>
              <div style="font-size:12.5px;color:var(--orange);font-weight:700;">${escHtml(f.trap)}</div>
            </div>
            <button class="audio-mini-btn" data-say="${escHtml(f.sk)}">🔊</button>
          </div>
        `).join('')}
      `;
    } else {
      body = DATA.grammar.map((g) => `
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
      b.onclick = () => {
        state.refSubtab = b.dataset.st;
        saveState();
        renderRefTab();
      };
    });

    const searchEl = document.getElementById('dict-search');
    if (searchEl) {
      searchEl.addEventListener('input', (e) => {
        dictQuery = e.target.value;
        renderRefTab();
        const fresh = document.getElementById('dict-search');
        if (fresh) {
          fresh.focus();
          fresh.setSelectionRange(fresh.value.length, fresh.value.length);
        }
      });
    }

    mainView.querySelectorAll('[data-say]').forEach((b) => {
      b.onclick = () => SpeechEngine.speak(b.dataset.say, false);
    });
  }

  // =====================================================
  // TAB 5: SETTINGS, ANDROID TTS, PWA INSTALL & BACKUP
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

    let voiceBadge = '';
    if (!SpeechEngine.supported) {
      voiceBadge = '<span class="badge-warn">⚠️ Браузер не підтримує синтез мовлення</span>';
    } else if (skVoices.length > 0) {
      voiceBadge = `<span class="badge-ok">✅ Словацький голос готовий (${escHtml(skVoices[0].name)})</span>`;
    } else {
      voiceBadge = '<span class="badge-warn">⚠️ Пакет sk-SK не знайдено — вмикаємо системний</span>';
    }

    mainView.innerHTML = `
      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">📲 Встановлення на телефон (PWA)</div>
        ${isStandalone
          ? '<div class="badge-ok">✅ Додаток вже встановлено на робочий стіл!</div>'
          : (deferredInstallPrompt
              ? '<button class="btn btn-primary btn-full" id="set-pwa-install">📲 Встановити SlovoSK на телефон</button>'
              : '<div class="muted">У Chrome натисни меню <strong>⋮</strong> (праворуч зверху) → <strong>«Додати на головний екран»</strong> або <strong>«Встановити додаток»</strong>.</div>')
        }
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🔊 Озвучка та мікрофон (Android)</div>
        <div style="margin-bottom:10px;">${voiceBadge}</div>
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button class="btn btn-blue btn-sm" id="set-test-tts">🔊 Тест словацької</button>
          <button class="btn btn-outline btn-sm" id="set-test-slow">🐢 Повільно</button>
        </div>

        ${skVoices.length > 0 || allVoices.length > 0 ? `
          <label class="muted" style="display:block;margin-bottom:4px;">Голос озвучки:</label>
          <select id="set-voice-select" class="text-input" style="padding:10px;font-size:13px;margin-bottom:12px;">
            <option value="">Авто (найкращий словацький sk-SK)</option>
            ${allVoices
              .filter((v) => /^(sk|cs)/i.test(v.lang))
              .map((v) => `<option value="${escHtml(v.voiceURI)}" ${state.preferredVoiceURI === v.voiceURI ? 'selected' : ''}>${escHtml(v.name)} (${escHtml(v.lang)})</option>`)
              .join('')}
          </select>
        ` : ''}

        <div class="muted" style="background:var(--surface-2);padding:10px 12px;border-radius:12px;margin-bottom:12px;font-size:12.5px;">
          💡 Якщо голос звучить дивно або мовчить на Android:<br/>
          <strong>Налаштування → Загальне керування → Синтез мовлення → Google → Встановити голосові дані → Словацька (Slovenčina)</strong>.
        </div>

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
            <div class="muted">Звук правильної / неправильної відповіді</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-sfx" ${state.soundFx ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="row-between" style="padding:8px 0;">
          <div>
            <div style="font-weight:700;">Вправи з мікрофоном</div>
            <div class="muted">${MicEngine.supported ? 'Перевірка вимови наприкінці уроків' : 'Браузер не підтримує розпізнавання голосу'}</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-mic" ${state.micEnabled ? 'checked' : ''} ${MicEngine.supported ? '' : 'disabled'}><span class="slider"></span></label>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">🤖 ШІ-Репетитор (Google Gemini API)</div>
        <div class="muted" style="margin-bottom:10px;">
          Встав безкоштовний ключ із <strong>aistudio.google.com</strong> (кнопка <em>Get API key</em>). Ключ зберігається тільки локально на твоєму телефоні.
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
            <div class="muted">Вчитися без втрати сердець за помилки</div>
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
          <div class="muted" style="margin-bottom:6px;">Денна ціль XP:</div>
          <div style="display:flex;gap:8px;">
            ${[30, 50, 100].map((g) => `<button class="chip-btn ${state.dailyGoal === g ? 'active' : ''}" data-goal="${g}">${g} XP</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div style="font-weight:900;font-size:16px;margin-bottom:8px;">💾 Резервна копія прогресу</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" id="set-export">⬇️ Експорт JSON</button>
          <button class="btn btn-outline btn-sm" id="set-import">⬆️ Імпорт JSON</button>
          <button class="btn btn-outline btn-sm" id="set-reset" style="color:var(--red);">🗑️ Скинути прогрес</button>
          <input type="file" id="import-file" accept=".json" class="hidden" />
        </div>
      </div>
    `;

    const installBtn = document.getElementById('set-pwa-install');
    if (installBtn) {
      installBtn.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const res = await deferredInstallPrompt.userChoice;
        if (res.outcome === 'accepted') showToast('Встановлення запущено! 🎉');
        deferredInstallPrompt = null;
        renderSettingsTab();
      };
    }

    document.getElementById('set-test-tts').onclick = () => SpeechEngine.speak('Dobrý deň! Hľadám prácu na Slovensku.', false);
    document.getElementById('set-test-slow').onclick = () => SpeechEngine.speak('Dobrý deň! Hľadám prácu na Slovensku.', true);

    const vs = document.getElementById('set-voice-select');
    if (vs) {
      vs.onchange = () => {
        state.preferredVoiceURI = vs.value;
        saveState();
        SpeechEngine.speak('Dobrý deň, ďakujem.', false);
      };
    }

    document.getElementById('set-autospeak').onchange = (e) => { state.autoSpeak = e.target.checked; saveState(); };
    document.getElementById('set-sfx').onchange = (e) => { state.soundFx = e.target.checked; saveState(); };
    document.getElementById('set-mic').onchange = (e) => { state.micEnabled = e.target.checked; saveState(); };
    document.getElementById('set-inf-hearts').onchange = (e) => {
      state.infiniteHearts = e.target.checked;
      if (state.infiniteHearts) state.hearts = 5;
      saveState();
    };
    document.getElementById('set-dark').onchange = (e) => {
      state.theme = e.target.checked ? 'dark' : 'light';
      applyTheme();
      saveState();
    };

    mainView.querySelectorAll('[data-goal]').forEach((b) => {
      b.onclick = () => {
        state.dailyGoal = Number(b.dataset.goal);
        saveState();
        renderSettingsTab();
        showToast(`Денна ціль: ${state.dailyGoal} XP`);
      };
    });

    document.getElementById('set-save-key').onclick = () => {
      state.geminiKey = document.getElementById('set-gemini-key').value.trim();
      saveState();
      showToast(state.geminiKey ? 'Ключ Gemini збережено! ✨' : 'Ключ порожній');
    };
    document.getElementById('set-clear-key').onclick = () => {
      state.geminiKey = '';
      saveState();
      renderSettingsTab();
      showToast('Ключ видалено');
    };

    document.getElementById('set-export').onclick = () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `slovosk_backup_${todayKey()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Файл резервної копії збережено');
    };

    const importFile = document.getElementById('import-file');
    document.getElementById('set-import').onclick = () => importFile.click();
    importFile.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          state = { ...defaultState(), ...parsed };
          applyTheme();
          saveState();
          renderSettingsTab();
          showToast('Прогрес успішно відновлено! 🎉');
        } catch {
          showToast('Невірний формат JSON-файлу');
        }
      };
      reader.readAsText(file);
    };

    document.getElementById('set-reset').onclick = () => {
      openModal(`
        <h3>🗑️ Скинути весь прогрес?</h3>
        <p class="muted" style="margin-bottom:16px;">Будуть видалені всі пройдені уроки, XP і серія днів (API-ключ можна буде ввести знову).</p>
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
  // SERVICE WORKER & INIT
  // =====================================================
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  applyTheme();
  updateHeader();
  setTab('course');
})();
