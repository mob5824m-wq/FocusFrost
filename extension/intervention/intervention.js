/* FocusFrost — the intervention gate (the one-sec half of the product). */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const $ = (id) => document.getElementById(id);

  /**
   * Navigate, with one escape hatch: inside the offline sandbox there is no
   * real internet, so the fake browser handles the jump instead.
   */
  function goTo(url, tabId) {
    const demo = window.__FF_DEMO && window.parent && window.parent.__FF_DEMO_NAV__;
    if (demo) return window.parent.__FF_DEMO_NAV__(tabId, url);
    location.replace(url);
  }

  const params = new URLSearchParams(location.search);
  const site = params.get('site') || '';
  const target = params.get('target') || '';
  const siteLabel = params.get('label') || Util.siteLabel(site) || site;
  const mode = params.get('mode') === 'again' ? 'again' : 'enter';
  const urlTabId = Number(params.get('tab')) || null;
  // The settings page embeds this screen as a live preview. Nothing there
  // should actually grant a pass or navigate, so it says so instead of lying.
  const preview = params.get('preview') === '1';

  const el = {
    sitePill: $('sitePill'),
    breath: $('stage-breath'),
    reflect: $('stage-reflect'),
    type: $('stage-type'),
    done: $('stage-done'),
    orb: $('orb'),
    orbit: $('orbit'),
    phaseLabel: $('phaseLabel'),
    phaseCount: $('phaseCount'),
    breathTitle: $('breathTitle'),
    breathLede: $('breathLede'),
    reflectTitle: $('reflectTitle'),
    reflectLede: $('reflectLede'),
    questions: $('questions'),
    intentWrap: $('intentWrap'),
    intention: $('intention'),
    intentHint: $('intentHint'),
    phrase: $('phrase'),
    typed: $('typed'),
    typeStatus: $('typeStatus'),
    doneTitle: $('doneTitle'),
    doneLede: $('doneLede'),
    alternative: $('alternative'),
    altText: $('altText'),
    choices: $('choices'),
    closeBtn: $('closeBtn'),
    continueBtn: $('continueBtn'),
    continueSub: $('continueSub'),
    pauseBtn: $('pauseBtn'),
    pauseNote: $('pauseNote'),
    toast: $('toast'),
  };

  let status = null;
  let config = null;
  let finished = false;
  let answers = [];
  let tabId = urlTabId;
  let toastTimer = null;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => ({ ok: false }));
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  async function boot() {
    if (!preview) await reportTab();
    // Pull the live config from the worker so the gate always matches settings.
    const res = await send({ type: 'interventionConfig', url: target || `https://${site}/` });
    status = res && res.ok ? res : null;
    config = (status && status.intervention) || {
      type: 'breath',
      durationSeconds: 10,
      requireIntention: false,
      showAlternative: true,
      alternative: '',
      allowSkip: false,
    };

    el.sitePill.textContent = siteLabel;
    el.sitePill.className = 'badge grace';

    if (config.showAlternative && config.alternative) {
      el.altText.textContent = config.alternative;
      el.alternative.classList.remove('hidden');
    } else {
      el.alternative.classList.add('hidden');
    }

    if (mode === 'again') {
      el.breathTitle.textContent = 'Still here?';
      el.breathLede.textContent = 'Another breath before you keep scrolling.';
    }

    renderGateButtons();

    if (config.type === 'type') startTyping();
    else if (config.type === 'reflect' || config.type === 'intention') startReflection();
    else startBreathing(config.type === 'breathe478');

    el.typed.addEventListener('input', onTyped);
    el.intention.addEventListener('input', onIntention);
    el.closeBtn.addEventListener('click', closeInstead);
    el.continueBtn.addEventListener('click', continueOn);
    el.pauseBtn.addEventListener('click', openPause);

    // Keyboard: Enter/Esc should not let anyone sneak through.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && config.allowSkip) finish('continue');
    });
  }

  /**
   * Show exactly one stage. Every stage lives in the same <main>, and the page
   * does not scroll, so a stage left visible under the current one pushes the
   * footer — and every button in it — off the bottom of the screen.
   *
   * `choices` is the footer with the continue / close buttons, so it is tied to
   * the stage rather than toggled separately: only the outcome stage hides it.
   */
  function showStage(name) {
    const stages = { breath: el.breath, reflect: el.reflect, type: el.type, done: el.done };
    for (const [key, node] of Object.entries(stages)) {
      if (node) node.classList.toggle('hidden', key !== name);
    }
    showChoices(name !== 'done');
  }

  /**
   * The stage sections sit above the footer, so a footer only makes sense for
   * the stage you are actually on. Breathing keeps its choices hidden until the
   * breath is done; the text stages show them straight away (the continue
   * button stays disabled until they are satisfied, so it doubles as the
   * "here is what is left" hint).
   */
  function showChoices(show) {
    el.choices.classList.toggle('hidden', !show);
  }

  function renderGateButtons() {
    const pause = status && status.pause;
    if (pause) {
      el.pauseBtn.disabled = !pause.canStart;
      el.pauseNote.textContent = pause.canStart
        ? `${pause.remainingToday} left today`
        : pause.blockedReason === 'daily-limit'
        ? 'none left today'
        : pause.blockedReason === 'too-soon'
        ? 'too soon'
        : 'unavailable';
    } else {
      el.pauseBtn.disabled = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* breathing                                                          */
  /* ------------------------------------------------------------------ */

  function startBreathing(fourSevenEight) {
    showStage('breath');
    showChoices(false); // the breath comes first; the buttons come after it
    el.continueBtn.disabled = true;

    // 4-7-8 runs one structured cycle; the plain breath gets two calm cycles.
    const phases = fourSevenEight
      ? [
          { name: 'Breathe in', seconds: 4, cls: 'inhale' },
          { name: 'Hold', seconds: 7, cls: 'hold' },
          { name: 'Breathe out', seconds: 8, cls: 'exhale' },
        ]
      : [
          { name: 'Breathe in', seconds: 4, cls: 'inhale' },
          { name: 'Hold', seconds: 2, cls: 'hold' },
          { name: 'Breathe out', seconds: 5, cls: 'exhale' },
        ];

    const totalWanted = Math.max(4, Number(config.durationSeconds) || 10);
    const queue = [];
    let accumulated = 0;
    let guard = 0;
    while (accumulated < totalWanted && guard < 24) {
      for (const phase of phases) {
        if (accumulated >= totalWanted) break;
        queue.push(phase);
        accumulated += phase.seconds;
      }
      guard++;
    }

    let index = 0;
    const runPhase = () => {
      if (finished) return;
      if (index >= queue.length) return completeBreathing();
      const phase = queue[index++];
      el.orb.className = 'orb ' + phase.cls;
      el.orbit.style.transform = phase.cls === 'inhale' ? 'scale(1.06)' : phase.cls === 'exhale' ? 'scale(0.94)' : 'scale(1.06)';
      el.phaseLabel.textContent = phase.name;

      let left = phase.seconds;
      el.phaseCount.textContent = String(left);
      const ticker = setInterval(() => {
        if (finished) return clearInterval(ticker);
        left -= 1;
        el.phaseCount.textContent = String(Math.max(0, left));
        if (left <= 0) {
          clearInterval(ticker);
          runPhase();
        }
      }, 1000);
    };
    runPhase();
  }

  function completeBreathing() {
    if (finished) return;
    el.orb.className = 'orb';
    el.phaseLabel.textContent = 'Done';
    el.phaseCount.textContent = '✓';
    el.breathTitle.textContent = 'That was the whole point.';
    el.breathLede.textContent = 'Notice whether you still want this.';
    showChoices(true);
    unlockContinue('Continue to ' + siteLabel);
  }

  /* ------------------------------------------------------------------ */
  /* reflection + intention                                             */
  /* ------------------------------------------------------------------ */

  function startReflection() {
    showStage('reflect');
    showChoices(true);

    if (config.type === 'intention') {
      el.reflectTitle.textContent = 'One sentence first.';
      el.reflectLede.textContent = 'What are you actually about to do here?';
    } else {
      el.reflectTitle.textContent = 'What are you here for?';
      el.reflectLede.textContent = 'Answer honestly. Nobody is reading this but you.';
    }

    const questions = [
      {
        id: 'why',
        text: 'Why are you opening ' + siteLabel + ' right now?',
        options: ['Bored', 'Procrastinating', 'Habit', 'Someone sent me something', 'Actual task'],
      },
      {
        id: 'need',
        text: 'Do you need it, or do you want it?',
        options: ['I need it', 'I want it', 'Not sure yet'],
      },
      {
        id: 'how',
        text: 'How long do you plan to stay?',
        options: ['Under a minute', 'A few minutes', 'Honestly, a while'],
      },
    ];

    answers = [];
    el.questions.innerHTML = '';
    questions.forEach((q, qi) => {
      const box = document.createElement('div');
      box.className = 'question';
      box.innerHTML = `<p>${q.text}</p><div class="options"></div>`;
      const wrap = box.querySelector('.options');
      q.options.forEach((label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'opt';
        b.textContent = label;
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => {
          answers[qi] = label;
          for (const other of wrap.children) other.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
          updateReflectReady();
        });
        wrap.appendChild(b);
      });
      el.questions.appendChild(box);
    });

    el.intentWrap.classList.remove('hidden');

    updateReflectReady();
  }

  const INTENT_HINT = {
    intention: 'Saved to today’s log so you can check yourself later.',
    reflect: 'Optional, but it makes the second look cheaper.',
  };

  function updateReflectReady() {
    // Intention mode insists on a sentence; reflection wants the three answers,
    // or at least a written line (which is the honest version of the same thing).
    const typedSomething = el.intention.value.trim().length >= 4;
    const answered = answers.filter(Boolean).length >= 3;
    const ready = config.type === 'intention' ? typedSomething : answered || typedSomething;

    if (ready) {
      el.intentHint.textContent = INTENT_HINT[config.type] || INTENT_HINT.reflect;
      unlockContinue('Continue to ' + siteLabel);
      return;
    }

    el.continueBtn.disabled = true;
    if (config.type === 'intention') {
      // Say exactly why the button is asleep, right where the sentence goes.
      const left = Math.max(0, 4 - el.intention.value.trim().length);
      el.continueSub.textContent = 'write your intention first';
      el.intentHint.textContent =
        el.intention.value.trim().length === 0
          ? 'One short line is all it takes — then the button below wakes up.'
          : 'Just ' + left + ' more character' + (left === 1 ? '' : 's') + '.';
      return;
    }
    const missing = 3 - answers.filter(Boolean).length;
    el.continueSub.textContent = 'answer the questions or write a line';
    el.intentHint.textContent =
      missing > 0
        ? missing + ' question' + (missing === 1 ? '' : 's') + ' to go — or skip straight to the one line.'
        : INTENT_HINT.reflect;
  }

  function onIntention() {
    if (config.type === 'intention' || config.type === 'reflect') updateReflectReady();
  }

  /* ------------------------------------------------------------------ */
  /* typing friction                                                    */
  /* ------------------------------------------------------------------ */

  const PHRASES = [
    'one tab, one task',
    'i chose this, it did not choose me',
    'close it and get back to work',
    'the scroll can wait 10 minutes',
    'attention is the whole game',
    'breathe first, scroll later',
    'twenty seconds of honesty',
  ];

  function startTyping() {
    showStage('type');
    showChoices(true);

    const words = PHRASES[Math.floor(Math.random() * PHRASES.length)].split(' ');
    const phrase = words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1) + (Math.random() < 0.4 ? ' ' + Math.floor(Math.random() * 90 + 10) : ''))
      .join(' ');
    el.phrase.dataset.phrase = phrase;
    paintPhrase('');
    el.typed.focus();
  }

  function paintPhrase(typed) {
    const phrase = el.phrase.dataset.phrase || '';
    const show = Math.min(typed.length, phrase.length);
    const good = phrase.slice(0, show);
    const bad = typed.slice(show);
    const rest = phrase.slice(show);
    el.phrase.innerHTML =
      `<span class="ok">${escapeHtml(good)}</span>` +
      (bad ? `<span class="bad">${escapeHtml(bad)}</span>` : '') +
      escapeHtml(rest);
  }

  function onTyped() {
    const phrase = el.phrase.dataset.phrase || '';
    const typed = el.typed.value;
    const exactSoFar = phrase.toLowerCase().startsWith(typed.toLowerCase());
    el.typed.classList.toggle('bad', !exactSoFar && typed.length > 0);
    el.typed.classList.toggle('ok', exactSoFar && typed.length === phrase.length);
    paintPhrase(exactSoFar ? typed : '');

    if (exactSoFar && typed.length >= phrase.length) {
      el.typeStatus.textContent = 'Matched. Good.';
      unlockContinue('Continue to ' + siteLabel);
      el.continueBtn.focus();
    } else {
      el.typeStatus.textContent = `${typed.length}/${phrase.length} characters`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* shared outcome                                                     */
  /* ------------------------------------------------------------------ */

  function unlockContinue(label) {
    el.continueBtn.disabled = false;
    el.continueBtn.querySelector('.choice-main').textContent = label;
    el.continueSub.textContent = 'You have done the pause. Your call.';
  }

  async function continueOn() {
    if (finished || el.continueBtn.disabled) return;
    const intention = el.intention.value.trim();
    if (preview) {
      // Show the real outcome without recording anything or leaving the page.
      finish('continue');
      el.doneLede.textContent =
        'This is the preview, so nothing was recorded. On the real screen ' + siteLabel + ' opens now.';
      return;
    }
    await send({
      type: 'interventionDone',
      outcome: 'continue',
      site,
      target,
      tabId,
      intention,
      answers: answers.filter(Boolean),
    });
    finish('continue');
  }

  async function reportTab() {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id != null) tabId = tab.id;
    } catch (_) {
      /* not fatal: the worker can use the sender tab */
    }
  }

  async function closeInstead() {
    if (finished) return;
    if (preview) {
      finish('close');
      return;
    }
    finished = true;
    await send({ type: 'interventionDone', outcome: 'close', site, target, tabId, answers: answers.filter(Boolean) });
    // Walk away: if there is a page behind us, go back; otherwise close the tab.
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id != null) {
        if (history.length > 1) history.back();
        else chrome.tabs.remove(tab.id);
      } else if (history.length > 1) {
        history.back();
      }
    } catch (_) {
      if (history.length > 1) history.back();
    }
  }

  function finish(outcome) {
    if (finished) return;
    finished = true;
    showStage('done');
    el.alternative.classList.add('hidden');
    el.doneTitle.textContent = outcome === 'continue' ? 'Your call.' : 'Good choice.';
    el.doneLede.textContent =
      outcome === 'continue' ? 'Opening ' + siteLabel + ' — the clock starts now.' : 'Closing this tab.';

    if (outcome === 'continue' && target) {
      setTimeout(() => goTo(target, tabId), 420);
    }
  }

  /* ------------------------------------------------------------------ */
  /* pause escape hatch                                                 */
  /* ------------------------------------------------------------------ */

  async function openPause() {
    if (!status || !status.pause || !status.pause.canStart) {
      toast('No pauses left right now');
      return;
    }
    const minutes = (status.pause.presets || [5])[0];
    const res = await send({ type: 'startPause', minutes });
    if (res && res.ok) {
      toast(`Paused for ${minutes} min`);
      setTimeout(() => {
        if (target) goTo(target, tabId);
      }, 500);
    } else {
      toast('Could not pause');
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  boot();
})();
