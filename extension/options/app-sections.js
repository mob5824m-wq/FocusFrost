/**
 * FocusFrost settings — the sections.
 *
 * Each section is a render function returning a DOM node, plus an optional
 * `after` hook for things that need the node in the document (auto-focus,
 * preview reloads). All mutations go through App.touch(), which autosaves.
 */
(function () {
  'use strict';

  const App = window.FFApp;
  const Config = window.FFConfig;
  const Util = window.FFUtil;
  const el = App.el;
  const H = App.escape;

  const ICONS = {
    overview: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 2"/>',
    shield: '<path d="M12 3.5 19.5 6.6v5.6c0 4.3-3.1 7.6-7.5 9-4.4-1.4-7.5-4.7-7.5-9V6.6z"/><path d="m9 12 2 2 4-4"/>',
    friction: '<path d="M4 12h3M17 12h3M12 4v3M12 17v3"/><circle cx="12" cy="12" r="3.4"/>',
    clock: '<rect x="3.5" y="4.5" width="17" height="15.5" rx="2.6"/><path d="M3.5 9.5h17M8 2.8v3M16 2.8v3"/>',
    hand: '<path d="M8.5 11V6.2a1.7 1.7 0 0 1 3.4 0V11"/><path d="M11.9 10.6V5.4a1.7 1.7 0 0 1 3.4 0v5.4"/><path d="M15.3 11V7.6a1.7 1.7 0 0 1 3.4 0v6.6c0 3.4-2.4 6-5.9 6-2.4 0-4-1.2-5.2-3.2L5.6 13a1.7 1.7 0 0 1 2.8-1.9l1.6 2"/><path d="M8.5 11V8.9a1.7 1.7 0 0 0-3.4 0"/>',
    spark: '<path d="M12 3v4M12 17v4M4.5 12h4M15.5 12h4M6.7 6.7l2.8 2.8M14.5 14.5l2.8 2.8M17.3 6.7l-2.8 2.8M9.5 14.5l-2.8 2.8"/>',
    data: '<path d="M4 19V9M9.5 19V5M15 19v-7M20.5 19V8"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-2-2-6.5-6.5L11 6l3.7.3z"/><circle cx="15.5" cy="8.5" r="1.2"/>',
    pages: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M3.5 9h17M8 4.5v4.5"/>',
  };

  function icon(name) {
    return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.shield}</svg>`;
  }

  const SECTIONS = [
    { id: 'overview', label: 'Overview', group: 'FocusFrost' },
    { id: 'sites', label: 'Sites', group: 'FocusFrost' },
    { id: 'friction', label: 'Friction', group: 'FocusFrost' },
    { id: 'guardrails', label: 'Guardrails', group: 'FocusFrost' },
    { id: 'schedule', label: 'Focus hours', group: 'FocusFrost' },
    { id: 'pause', label: 'Pause', group: 'FocusFrost' },
    { id: 'intentions', label: 'Intentions', group: 'Insight' },
    { id: 'pages', label: 'Pages', group: 'Insight' },
    { id: 'advanced', label: 'Advanced', group: 'System' },
  ];

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  function head(title, blurb) {
    return el('div', { class: 'section-head' }, [el('h2', { text: title }), el('p', { text: blurb })]);
  }

  function group(title, children) {
    return el('div', { class: 'group' }, [title ? el('div', { class: 'group-title', text: title }) : null].concat(children));
  }

  function siteState(pattern) {
    return (App.status && App.status.sites.find((s) => s.pattern === pattern)) || null;
  }

  function faviconCell(site) {
    const initial = (site.label || site.pattern).slice(0, 1).toUpperCase();
    return el('div', { class: 'favicon', html: `<img src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(site.pattern)}.ico" alt="" loading="lazy" onerror="this.remove()" />` + (initial ? `<span>${H(initial)}</span>` : '') });
  }

  function downloadBlob(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ================================================================== */
  /* OVERVIEW                                                           */
  /* ================================================================== */

  function renderOverview() {
    const s = App.settings;
    const st = App.status || { stats: {}, pause: {}, schedule: {}, totals: {} };
    const pause = st.pause || {};
    const stats = st.stats || {};
    const frag = document.createDocumentFragment();

    frag.appendChild(head('Overview', 'One place for the whole shield. Start here, then tune whichever layer is too soft or too strict.'));

    /* live state strip */
    const liveCards = el('div', { class: 'stat-grid' }, [
      statCell(
        pause.active ? App.clock(pause.remaining / 1000) : st.totals && st.totals.active ? 'focusing' : 'idle',
        pause.active ? 'paused — access granted' : 'current state'
      ),
      statCell(App.human(stats.focusSeconds || 0), 'focused today'),
      statCell(String(stats.blocked || 0), 'blocked today'),
      statCell(`${stats.turnedAway || 0}/${stats.interventions || 0}`, 'interventions you walked away from'),
    ]);
    frag.appendChild(liveCards);

    /* the three layers, explained in the app's own words */
    frag.appendChild(
      group('Three layers of friction', [
        layerRow('1', 'Intervention', s.intervention.enabled ? capLabel(s.intervention.type) : 'Off', App.human(s.intervention.durationSeconds),
          'A short pause on the way in. It catches the muscle memory before the page even loads.',
          () => App.go('friction')),
        layerRow('2', 'Guardrails', s.behavior.closeOnBlur ? 'Strict' : 'Relaxed',
          `${App.human(median(s.sites, 'cooldownSeconds'))} lock`,
          'Grace window, one tab, focus cap, then a cooldown you cannot reload your way out of.',
          () => App.go('guardrails')),
        layerRow('3', 'Pause', `${s.pause.maxPerDay} per day`, `${App.human(s.pause.holdMs / 1000)} hold`,
          'The deliberate escape hatch. Time-boxed, rationed, and slightly annoying on purpose.',
          () => App.go('pause')),
      ])
    );

    /* quick starts */
    frag.appendChild(
      group('Quick starts', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'I keep opening sites without thinking' }),
            el('p', { text: 'Turn the breathing intervention on and make the cooldown 10 minutes.' }),
          ]),
          el('button', { class: 'btn btn-sm', text: 'Apply', onclick: () => preset('gentle') }),
        ]),
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'I need this to be hard' }),
            el('p', { text: 'Strict guardrails: no new tabs, instant close on blur, 30 minute cooldowns, one 5 minute pause a day.' }),
          ]),
          el('button', { class: 'btn btn-sm', text: 'Apply', onclick: () => preset('strict') }),
        ]),
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Exam week, block everything' }),
            el('p', { text: 'Focus hours all day, every day, that a pause cannot override.' }),
          ]),
          el('button', { class: 'btn btn-sm btn-danger', text: 'Apply', onclick: () => preset('lockdown') }),
        ]),
      ])
    );

    /* status of the shield */
    frag.appendChild(
      group('At a glance', [
        App.switchRow({
          title: 'FocusFrost is enabled',
          hint: 'Turn this off and nothing is tracked, closed or blocked. Useful for a genuinely free evening.',
          value: s.enabled,
          onChange: (v) => {
            s.enabled = v;
            App.touch(true);
            App.renderChrome();
          },
        }),
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Tracked sites' }),
            el('p', { text: `${s.sites.length} domain${s.sites.length === 1 ? '' : 's'} under the shield.` }),
          ]),
          el('button', { class: 'btn btn-sm', text: 'Manage', onclick: () => App.go('sites') }),
        ]),
      ])
    );

    return frag;
  }

  function statCell(value, label) {
    return el('div', { class: 'stat-cell' }, [el('b', { text: String(value) }), el('span', { text: label })]);
  }

  function layerRow(num, title, value, meta, blurb, onclick) {
    return el('div', { class: 'row-card' }, [
      el('div', { class: 'rc-text' }, [
        el('h3', { text: `${num}. ${title} — ${value}` }),
        el('p', { text: blurb }),
      ]),
      el('div', { class: 'inline' }, [
        el('span', { class: 'badge off', text: meta }),
        el('button', { class: 'btn btn-sm btn-ghost', text: 'Open', onclick }),
      ]),
    ]);
  }

  function capLabel(type) {
    return (Config.INTERVENTIONS[type] || Config.INTERVENTIONS.breath).label;
  }

  function median(sites, key) {
    if (!sites.length) return 600;
    const vals = sites.map((x) => x[key]).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }

  function preset(name) {
    const s = App.settings;
    if (name === 'gentle') {
      s.intervention.enabled = true;
      s.intervention.type = 'breath';
      s.intervention.durationSeconds = 10;
      s.sites.forEach((site) => {
        site.cooldownSeconds = 600;
        site.graceSeconds = 20;
        site.maxSessionSeconds = 300;
      });
      s.behavior.closeOnBlur = true;
      s.pause.maxPerDay = 3;
    } else if (name === 'strict') {
      s.intervention.enabled = true;
      s.intervention.type = 'reflect';
      s.intervention.durationSeconds = 20;
      s.intervention.requireIntention = true;
      s.sites.forEach((site) => {
        site.cooldownSeconds = 1800;
        site.graceSeconds = 5;
        site.maxSessionSeconds = 180;
      });
      s.behavior.closeOnBlur = true;
      s.behavior.blockNewTabs = true;
      s.pause.maxPerDay = 1;
      s.pause.presets = [5];
      s.pause.minGapMinutes = 120;
    } else if (name === 'lockdown') {
      const all = [0, 1, 2, 3, 4, 5, 6];
      s.schedule.enabled = true;
      s.schedule.pausable = false;
      s.schedule.blocks = [
        { id: Util.uid('block'), label: 'Lockdown', days: all, start: '00:00', end: '23:59', enabled: true },
      ];
      s.pause.maxPerDay = 0;
    }
    App.touch(true);
    App.saveNow().then(() => App.toast('Preset applied'));
  }

  /* ================================================================== */
  /* SITES                                                              */
  /* ================================================================== */

  function renderSites() {
    const s = App.settings;
    const frag = document.createDocumentFragment();
    frag.appendChild(
      head('Sites', 'Each domain gets the full treatment. Tune the cooldown, grace window and focus cap per site — or apply one set everywhere.')
    );

    /* add */
    const input = el('input', {
      type: 'text',
      placeholder: 'add a site — instagram.com',
      spellcheck: 'false',
      autocomplete: 'off',
      onkeydown: (e) => {
        if (e.key === 'Enter') add();
      },
    });
    const add = () => {
      const pattern = Util.normalizeSite(input.value);
      if (!pattern) return App.toast('That does not look like a domain');
      if (s.sites.some((x) => x.pattern === pattern)) return App.toast('Already tracked');
      s.sites.push({
        id: Util.uid('site'),
        pattern,
        label: Util.siteLabel(pattern),
        enabled: true,
        cooldownSeconds: s.defaults.cooldownSeconds,
        graceSeconds: s.defaults.graceSeconds,
        maxSessionSeconds: s.defaults.maxSessionSeconds,
      });
      input.value = '';
      App.touch(true);
      App.refreshPane();
    };
    frag.appendChild(
      el('div', { class: 'card add-card' }, [
        el('div', { class: 'inline', style: 'flex-wrap:nowrap' }, [
          input,
          el('button', { class: 'btn btn-primary', text: 'Add site', onclick: add }),
        ]),
        el(
          'div',
          { class: 'chips', style: 'margin-top:10px' },
          Config.PRESET_SITES.filter((p) => !s.sites.some((x) => x.pattern === p))
            .slice(0, 8)
            .map((p) => el('button', { class: 'suggestion', text: '+ ' + p, onclick: () => { input.value = p; add(); } }))
        ),
      ])
    );

    if (!s.sites.length) {
      frag.appendChild(el('div', { class: 'empty-note', text: 'Nothing tracked yet. Add the sites that eat your day — the whole shield is idle until you do.' }));
      return frag;
    }

    /* one row per site */
    const list = el('div', { class: 'sites-list', style: 'display:flex;flex-direction:column;gap:10px' });
    for (const site of s.sites) list.appendChild(siteRow(site));
    frag.appendChild(list);

    /* bulk */
    frag.appendChild(
      group('Bulk', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Apply one set of values to every site' }),
            el('p', { text: 'Copies the cooldown, grace window and focus cap from the first site to all of them.' }),
          ]),
          el('button', {
            class: 'btn btn-sm',
            text: 'Apply to all',
            onclick: () => {
              const first = s.sites[0];
              if (!first) return;
              s.sites.forEach((x) => {
                x.cooldownSeconds = first.cooldownSeconds;
                x.graceSeconds = first.graceSeconds;
                x.maxSessionSeconds = first.maxSessionSeconds;
              });
              App.touch(true);
              App.refreshPane();
              App.toast('Applied to every site');
            },
          }),
        ]),
      ])
    );

    return frag;
  }

  function siteRow(site) {
    const live = siteState(site.pattern);
    const row = el('div', { class: 'site-row' + (site.enabled ? '' : ' off') + (live && live.session ? ' open' : live && live.cooldownUntil ? ' cooling' : '') });

    let chip = el('span', { class: 'badge off', text: 'ready' });
    if (live && live.session) {
      chip = el('span', {
        class: 'badge active',
        text: live.session.inGrace ? `grace ${Math.ceil(live.session.graceRemaining)}s` : App.clock(live.session.remainingSeconds),
      });
    } else if (live && live.cooldownUntil) {
      chip = el('span', { class: 'badge cooling', text: App.clock(live.cooldownRemaining / 1000) });
    }

    const toggle = el('label', { class: 'switch' }, [
      el('input', {
        type: 'checkbox',
        checked: site.enabled,
        onchange: (e) => {
          site.enabled = e.target.checked;
          row.classList.toggle('off', !site.enabled);
          App.touch(true);
        },
      }),
      el('span'),
    ]);
    toggle.addEventListener('click', (e) => e.stopPropagation());

    const top = el('div', { class: 'site-top' }, [
      faviconCell(site),
      el('div', {}, [el('div', { class: 'site-name', text: site.label }), el('div', { class: 'site-host', text: site.pattern })]),
      el('div', { class: 'site-chips' }, [
        chip,
        el('span', { class: 'badge off', text: App.human(site.cooldownSeconds) + ' lock' }),
        el('span', { class: 'badge off', text: App.human(site.graceSeconds) + ' grace' }),
        el('span', { class: 'badge off', text: App.human(site.maxSessionSeconds) + ' cap' }),
      ]),
      toggle,
    ]);
    top.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      row.classList.toggle('expanded');
    });

    const body = el('div', { class: 'site-body' }, [
      App.slider({
        label: 'Cooldown after you leave',
        value: Math.min(120, Math.round(site.cooldownSeconds / 60)),
        min: 1,
        max: 120,
        step: 1,
        format: (v) => App.human(v * 60),
        hint: 'How long the site stays locked once a visit ends badly.',
        onChange: (v) => {
          site.cooldownSeconds = v * 60;
          App.touch();
        },
      }),
      App.slider({
        label: 'Grace window',
        value: Math.min(120, site.graceSeconds),
        min: 0,
        max: 120,
        step: 1,
        format: (v) => v + 's',
        hint: 'Free time at the start of a visit. 0 means leaving immediately locks the site.',
        onChange: (v) => {
          site.graceSeconds = v;
          App.touch();
        },
      }),
      App.slider({
        label: 'Focus cap',
        value: Math.min(60, Math.round(site.maxSessionSeconds / 60)),
        min: 1,
        max: 60,
        step: 1,
        format: (v) => App.human(v * 60),
        hint: 'Focused time before the tab closes itself, even if you are being good.',
        onChange: (v) => {
          site.maxSessionSeconds = v * 60;
          App.touch();
        },
      }),
      el('div', { class: 'inline', style: 'justify-content:space-between' }, [
        el('span', {
          class: 'tiny dim',
          text: live && live.focusSecondsToday ? `${App.human(live.focusSecondsToday)} focused today · best ${App.human(live.bestFocusSeconds)}` : 'no focus logged today',
        }),
        el('div', { class: 'inline' }, [
          live && (live.cooldownUntil || live.session)
            ? el('button', {
                class: 'btn btn-sm btn-ghost',
                text: 'Clear lock',
                onclick: async (e) => {
                  e.stopPropagation();
                  await App.send({ type: 'clearSite', pattern: site.pattern });
                  await App.load();
                  App.refreshPane();
                  App.toast(`${site.label} unlocked`);
                },
              })
            : null,
          el('button', {
            class: 'btn btn-sm btn-danger',
            text: 'Remove',
            onclick: (e) => {
              e.stopPropagation();
              App.settings.sites = App.settings.sites.filter((x) => x.pattern !== site.pattern);
              App.touch(true);
              App.refreshPane();
            },
          }),
        ]),
      ]),
    ]);

    row.append(top, body);
    return row;
  }

  /* ================================================================== */
  /* FRICTION (interventions)                                           */
  /* ================================================================== */

  let previewFrame = null;

  function renderFriction() {
    const s = App.settings;
    const iv = s.intervention;
    const frag = document.createDocumentFragment();

    frag.appendChild(
      head(
        'Friction on the way in',
        'Borrowed from one sec: a short pause the moment you reach for a site. It does not block anything — it just makes the reach conscious. The cooldown handles the rest.'
      )
    );

    frag.appendChild(
      group('Status', [
        App.switchRow({
          title: 'Intervene before a tracked site loads',
          hint: 'When off, tracked sites open straight into the grace window with no friction screen.',
          value: iv.enabled,
          onChange: (v) => {
            iv.enabled = v;
            App.touch(true);
            // Only the tuning controls below depend on this; do not rebuild the
            // switch the user just clicked.
            App.refreshPane();
          },
        }),
      ])
    );

    /* picker */
    const grid = el('div', { class: 'iv-grid' });
    for (const type of Object.values(Config.INTERVENTIONS)) {
      const card = el(
        'button',
        {
          type: 'button',
          class: 'iv-card' + (iv.type === type.id ? ' on' : ''),
          onclick: () => {
            iv.type = type.id;
            iv.enabled = true;
            App.touch(true);
            App.refreshPane(); // the tuning controls depend on the type
            reloadPreview();
          },
        },
        [
          el('div', { class: 'iv-ico', html: typeIcon(type.id) }),
          el('b', { text: type.label }),
          el('span', { text: type.blurb }),
          el('svg', {
            class: 'tick',
            width: '14',
            height: '14',
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '2.6',
            'stroke-linecap': 'round',
            html: '<path d="M4 12.5 9 17.5 20 6.5"/>',
          }),
        ]
      );
      grid.appendChild(card);
    }
    frag.appendChild(group('Which interruption', [el('div', { style: 'padding:14px' }, [grid])]));

    /* tuning */
    const tuning = [];
    if (iv.type === 'breath' || iv.type === 'breathe478') {
      tuning.push(
        App.slider({
          label: 'Minimum time on the screen',
          value: iv.durationSeconds,
          min: 3,
          max: 60,
          step: 1,
          format: (v) => v + 's',
          hint: 'The breath cycle runs until at least this much time has passed.',
          onChange: (v) => {
            iv.durationSeconds = v;
            App.touch();
          },
        })
      );
    }
    tuning.push(
      App.slider({
        label: 'Second look during a visit',
        value: iv.reinterveneSeconds,
        min: 0,
        max: 900,
        step: 30,
        format: (v) => (v === 0 ? 'off' : 'every ' + App.human(v)),
        hint: 'Show the pause again after this much focused time — the doomscroll brake. 0 turns it off.',
        onChange: (v) => {
          iv.reinterveneSeconds = v;
          App.touch();
        },
      })
    );
    /* the cooling-down page: breathe your way back in */
    tuning.push(
      App.switchRow({
        title: 'Offer breathing on the cooldown page',
        hint: 'When a site is locked, the page offers a breathing exercise. Finishing it costs one of the day\u2019s pauses — the same ledger as the hold button, so a cooldown still costs something.',
        value: iv.breatheToPass,
        onChange: (v) => {
          iv.breatheToPass = v;
          App.touch(true);
          App.refreshPane();
        },
      })
    );
    if (iv.breatheToPass) {
      tuning.push(
        App.slider({
          label: 'Window the breath buys',
          value: iv.breatheMinutes,
          min: 1,
          max: 30,
          step: 1,
          format: (v) => (v === 1 ? '1 min' : v + ' min'),
          hint: 'How long the site opens for. In strict pause mode this is rounded up to the nearest allowed length.',
          onChange: (v) => {
            iv.breatheMinutes = v;
            App.touch();
          },
        })
      );
    }

    tuning.push(
      App.switchRow({
        title: 'Require an intention',
        hint: 'You cannot get through without writing one line about what you are actually doing.',
        value: iv.requireIntention,
        onChange: (v) => {
          iv.requireIntention = v;
          App.touch(true);
        },
      })
    );
    tuning.push(
      App.switchRow({
        title: 'Show a healthy alternative',
        hint: 'Suggests something better to do instead. Slightly cheesy; surprisingly effective.',
        value: iv.showAlternative,
        onChange: (v) => {
          iv.showAlternative = v;
          App.touch();
        },
      })
    );
    tuning.push(
      el('div', { class: 'row-card' }, [
        el('div', { class: 'rc-text', style: 'flex:1' }, [
          el('h3', { text: 'The alternative text' }),
          el('p', { text: 'Keep it concrete. “Go for a walk” is easy to ignore; “put the kettle on” is not.' }),
        ]),
      ]),
      el(
        'div',
        { style: 'padding:0 16px 16px' },
        [
          App.textField({
            value: iv.alternative,
            rows: 2,
            maxlength: 240,
            placeholder: 'Put the kettle on and come back in ten minutes…',
            onValue: (v) => {
              iv.alternative = v;
              App.touch();
            },
            onCommit: (v) => {
              iv.alternative = v;
              App.touch(true);
              reloadPreview();
            },
          }),
        ]
      )
    );

    frag.appendChild(group('Tuning', tuning));

    /* live preview */
    previewFrame = el('iframe', { title: 'Intervention preview', src: previewUrl() });
    frag.appendChild(
      group('Preview', [
        el('div', { style: 'padding:14px' }, [
          el('div', { class: 'preview-interest' }, [
            el('span', { class: 'tiny dim', text: 'This is the real screen, rendered live with your settings.' }),
            el('button', { class: 'btn btn-sm btn-ghost', text: 'Reload', onclick: reloadPreview }),
          ]),
          el('div', { class: 'preview-frame' }, [previewFrame]),
        ]),
      ])
    );

    return frag;
  }

  function previewUrl() {
    return (
      '../intervention/intervention.html?site=youtube.com&label=YouTube&target=%23&preview=1&t=' + Date.now()
    );
  }

  function reloadPreview() {
    if (previewFrame) previewFrame.src = previewUrl();
  }

  function typeIcon(id) {
    const paths = {
      breath: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 13.5c1-1.6 2.2-2.4 3.5-2.4s2.5.8 3.5 2.4"/>',
      breathe478: '<path d="M4 15c2.5 0 3-6 5.5-6S12 15 14.5 15 17 9 20 9"/>',
      reflect: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1.1.9-1.1 1.7v.3"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/>',
      type: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7.5 10.5h4M7.5 13.5h7"/>',
      intention: '<path d="M5 5.5h14v9H9l-4 3.5z"/><path d="M8.5 9h7M8.5 12h4"/>',
    };
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[id] || paths.breath}</svg>`;
  }

  /* ================================================================== */
  /* GUARDRAILS                                                         */
  /* ================================================================== */

  function renderGuardrails() {
    const s = App.settings;
    const frag = document.createDocumentFragment();
    frag.appendChild(
      head('Guardrails', 'What happens during and after a visit. This is the half that actually holds when willpower does not.')
    );

    frag.appendChild(
      group('Enforcement', [
        App.switchRow({
          title: 'Close the tab when you leave',
          hint: 'Switch tabs or windows after the grace window and the site is closed instantly.',
          value: s.behavior.closeOnBlur,
          onChange: (v) => {
            s.behavior.closeOnBlur = v;
            App.touch(true);
          },
        }),
        App.switchRow({
          title: 'One tab only',
          hint: 'A second tab pointing at a tracked site is bounced to the cooling-down page.',
          value: s.behavior.blockNewTabs,
          onChange: (v) => {
            s.behavior.blockNewTabs = v;
            App.touch(true);
          },
        }),
        App.switchRow({
          title: 'Show the on-page timer',
          hint: 'A small frosty chip with your grace and focus countdown. Click it to collapse.',
          value: s.behavior.showChip,
          onChange: (v) => {
            s.behavior.showChip = v;
            App.touch(true);
          },
        }),
        App.switchRow({
          title: 'Notifications',
          hint: 'Tell me when a session ends or a cooldown clears.',
          value: s.behavior.notifyOnEnd,
          onChange: (v) => {
            s.behavior.notifyOnEnd = v;
            App.touch(true);
          },
        }),
      ])
    );

    frag.appendChild(
      group('Defaults for new sites', [
        el('div', { style: 'padding:14px' }, [
          el('div', { class: 'grid3' }, [
            numberField('Cooldown', s.defaults.cooldownSeconds / 60, 'min', 1, 1440, (v) => {
              s.defaults.cooldownSeconds = Math.round(v * 60);
              App.touch();
            }),
            numberField('Grace window', s.defaults.graceSeconds, 'sec', 0, 600, (v) => {
              s.defaults.graceSeconds = Math.round(v);
              App.touch();
            }),
            numberField('Focus cap', s.defaults.maxSessionSeconds / 60, 'min', 1, 120, (v) => {
              s.defaults.maxSessionSeconds = Math.round(v * 60);
              App.touch();
            }),
          ]),
        ]),
      ])
    );

    frag.appendChild(
      group('How the clock works', [
        el('div', { style: 'padding:16px' }, [
          el(
            'ol',
            { class: 'steps' },
            [
              step('Grace.', 'The clock starts the second the page opens. Leave and come back inside the grace window and nothing happens.'),
              step('Focus.', 'Past grace, the stopwatch only runs while the tab is visible and the window has focus.'),
              step('Cooldown.', 'Leave, close, or hit the cap and the site locks. Reloading, restarting the browser, or opening a new tab all hit the same wall.'),
            ]
          ),
        ]),
      ])
    );

    return frag;
  }

  function step(bold, rest) {
    return el('li', {}, [el('b', { text: bold + ' ' }), document.createTextNode(rest)]);
  }

  function numberField(label, value, unit, min, max, onChange) {
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      el('div', { class: 'inline', style: 'flex-wrap:nowrap' }, [
        el('input', {
          type: 'number',
          value: String(Math.round(value)),
          min: String(min),
          max: String(max),
          onchange: (e) => {
            const v = Util.clamp(Number(e.target.value) || min, min, max);
            e.target.value = String(Math.round(v));
            onChange(v);
          },
        }),
        el('span', { class: 'unit', text: unit }),
      ]),
    ]);
  }

  /* ================================================================== */
  /* SCHEDULE                                                           */
  /* ================================================================== */

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function renderSchedule() {
    const s = App.settings;
    const frag = document.createDocumentFragment();
    const live = (App.status && App.status.schedule) || {};

    frag.appendChild(
      head(
        'Focus hours',
        'Windows where tracked sites are simply not available — no grace, no focus cap, just a wall. Good for mornings, deep work blocks, or a fixed bedtime.'
      )
    );

    frag.appendChild(
      group('Status', [
        App.switchRow({
          title: 'Enforce focus hours',
          hint: 'Off means only the cooldown and the pause are active. Blocks below are ignored.',
          value: s.schedule.enabled,
          onChange: (v) => {
            s.schedule.enabled = v;
            App.touch(true);
            App.refreshPane();
          },
        }),
        App.switchRow({
          title: 'A pause can override focus hours',
          hint: 'Leave this off if focus hours should be absolute. On means the hold-to-pause button punches through.',
          hintWarn: !s.schedule.pausable,
          value: s.schedule.pausable,
          onChange: (v) => {
            s.schedule.pausable = v;
            App.touch(true);
          },
        }),
      ])
    );

    /* live timeline */
    const now = Date.now();
    let timelineText;
    if (live.active) timelineText = el('div', { class: 'timeline' }, [
      el('span', { class: 'badge cooling', text: 'active' }),
      el('b', { text: live.block ? live.block.label : 'Focus hours' }),
      document.createTextNode(` until ${new Date(live.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
    ]);
    else if (live.nextStart) timelineText = el('div', { class: 'timeline' }, [
      el('span', { class: 'badge off', text: 'idle' }),
      document.createTextNode(`next: ${live.nextBlock ? live.nextBlock.label : 'focus hours'} at `),
      el('b', { text: new Date(live.nextStart).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) }),
    ]);
    else timelineText = el('div', { class: 'timeline' }, [el('span', { class: 'badge off', text: 'idle' }), document.createTextNode('no windows configured')]);
    frag.appendChild(timelineText);

    /* blocks */
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    for (const block of s.schedule.blocks) {
      list.appendChild(
        el('div', { class: 'block-row' + (block.enabled ? '' : ' off') }, [
          el('div', { class: 'inline', style: 'justify-content:space-between' }, [
            App.textField({
              value: block.label,
              placeholder: 'Deep work',
              maxlength: 40,
              onValue: (v) => {
                block.label = v;
                App.touch();
              },
              onCommit: (v) => {
                block.label = v;
                App.touch(true);
              },
            }),
            el('label', { class: 'switch' }, [
              el('input', {
                type: 'checkbox',
                checked: block.enabled,
                onchange: (e) => {
                  block.enabled = e.target.checked;
                  // Toggle the row in place: a full rebuild would steal focus
                  // and collapse the window you are editing.
                  e.target.closest('.block-row').classList.toggle('off', !block.enabled);
                  App.touch(true);
                },
              }),
              el('span'),
            ]),
          ]),
          el('div', { class: 'block-grid' }, [
            el('div', { class: 'field' }, [
              el('label', { text: 'Days' }),
              el(
                'div',
                { class: 'days' },
                DAY_NAMES.map((name, idx) =>
                  el('button', {
                    type: 'button',
                    class: 'day' + (block.days.includes(idx) ? ' on' : ''),
                    text: name.slice(0, 2),
                    title: name,
                    onclick: () => {
                      if (block.days.includes(idx)) block.days = block.days.filter((d) => d !== idx);
                      else block.days = block.days.concat(idx).sort();
                      const on = block.days.includes(idx);
                      e.target.classList.toggle('on', on);
                      e.target.setAttribute('aria-pressed', on ? 'true' : 'false');
                      App.touch(true);
                    },
                  })
                )
              ),
            ]),
            timeField('From', block.start, (v) => {
              block.start = v;
              App.touch(true);
            }),
            timeField('Until', block.end, (v) => {
              block.end = v;
              App.touch(true);
            }),
            el('button', {
              class: 'btn btn-sm btn-danger',
              text: 'Remove',
              onclick: () => {
                s.schedule.blocks = s.schedule.blocks.filter((b) => b.id !== block.id);
                App.touch(true);
                App.refreshPane();
              },
            }),
          ]),
          block.end <= block.start
            ? el('p', { class: 'tiny', style: 'color:var(--amber)', text: 'This window runs past midnight — that is allowed and handled.' })
            : null,
        ])
      );
    }
    frag.appendChild(list);

    frag.appendChild(
      el('div', { class: 'inline' }, [
        el('button', {
          class: 'btn btn-sm btn-primary',
          text: '+ Add focus window',
          onclick: () => {
            if (s.schedule.blocks.length >= 12) return App.toast('Twelve windows is plenty');
            s.schedule.blocks.push({
              id: Util.uid('block'),
              label: 'Deep work',
              days: [1, 2, 3, 4, 5],
              start: '09:00',
              end: '12:00',
              enabled: true,
            });
            s.schedule.enabled = true;
            App.touch(true);
            App.refreshPane();
          },
        }),
        el('button', {
          class: 'btn btn-sm',
          text: 'Add a wind-down block (21:00–07:00)',
          onclick: () => {
            s.schedule.blocks.push({
              id: Util.uid('block'),
              label: 'Wind down',
              days: [0, 1, 2, 3, 4, 5, 6],
              start: '21:00',
              end: '07:00',
              enabled: true,
            });
            s.schedule.enabled = true;
            App.touch(true);
            App.refreshPane();
          },
        }),
      ])
    );

    return frag;
  }

  function timeField(label, value, onChange) {
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      el('input', { type: 'time', value, onchange: (e) => onChange(e.target.value || value) }),
    ]);
  }

  /* ================================================================== */
  /* PAUSE                                                              */
  /* ================================================================== */

  function renderPause() {
    const s = App.settings;
    const pause = (App.status && App.status.pause) || {};
    const frag = document.createDocumentFragment();

    frag.appendChild(
      head(
        'Pause productivity shield',
        'The escape hatch for when you genuinely need a site. Deliberately slow to use, limited per day, and forced to rest between uses.'
      )
    );

    frag.appendChild(
      group('Today', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', {
              text: pause.active
                ? `Paused — ${App.clock(pause.remaining / 1000)} left`
                : `${pause.usedToday || 0} of ${s.pause.maxPerDay} pauses used today`,
            }),
            el('p', {
              text: pause.active
                ? `Tracked sites stay open. Resume early? The pause still counts against today.`
                : `${pause.remainingToday == null ? s.pause.maxPerDay : pause.remainingToday} left · at least ${s.pause.minGapMinutes} min between pauses.`,
            }),
          ]),
          el('button', {
            class: 'btn btn-sm' + (pause.active ? '' : ' btn-ghost'),
            text: pause.active ? 'Resume tracking now' : 'No pause active',
            disabled: !pause.active,
            onclick: async () => {
              await App.send({ type: 'stopPause' });
              await App.load();
              App.refreshPane();
              App.toast('Tracking resumed');
            },
          }),
        ]),
      ])
    );

    /* hold duration */
    frag.appendChild(
      group('The hold', [
        el('div', { style: 'padding:16px' }, [
          App.slider({
            label: 'Press and hold for',
            value: s.pause.holdMs,
            min: 3000,
            max: 10000,
            step: 500,
            format: (v) => (v / 1000).toFixed(1) + 's',
            hint: 'Long enough that you cannot do it by accident, short enough that you will not resent it.',
            onChange: (v) => {
              s.pause.holdMs = v;
              App.touch();
            },
          }),
        ]),
      ])
    );

    /* presets */
    const chips = el('div', { class: 'chips' });
    for (const minutes of s.pause.presets) {
      chips.appendChild(
        el('span', { class: 'chip-preset' }, [
          document.createTextNode(minutes + ' min'),
          el('button', {
            text: '✕',
            title: 'Remove',
            onclick: () => {
              if (s.pause.presets.length <= 1) return App.toast('Keep at least one option');
              s.pause.presets = s.pause.presets.filter((m) => m !== minutes);
              App.touch(true);
              App.refreshPane();
            },
          }),
        ])
      );
    }
    const newPreset = el('input', { type: 'number', min: '1', max: '30', placeholder: 'minutes', style: 'max-width:110px' });
    frag.appendChild(
      group('Allowed lengths', [
        el('div', { style: 'padding:16px;display:flex;flex-direction:column;gap:10px' }, [
          el('p', { class: 'hint', text: 'Pick up to four. In strict mode nothing else is accepted, so there is no “just this once”.' }),
          chips,
          el('div', { class: 'inline' }, [
            newPreset,
            el('button', {
              class: 'btn btn-sm',
              text: 'Add length',
              onclick: () => {
                const minutes = Util.clamp(Number(newPreset.value) || 0, 1, 30);
                if (!minutes) return;
                if (s.pause.presets.length >= 4) return App.toast('Four is the maximum');
                if (s.pause.presets.includes(minutes)) return App.toast('Already there');
                s.pause.presets = s.pause.presets.concat(minutes).sort((a, b) => a - b);
                newPreset.value = '';
                App.touch(true);
                App.refreshPane();
              },
            }),
          ]),
        ]),
      ])
    );

    /* limits */
    frag.appendChild(
      group('Rationing', [
        el('div', { style: 'padding:16px' }, [
          el('div', { class: 'grid2' }, [
            numberField('Pauses per day', s.pause.maxPerDay, 'per day', 0, 10, (v) => {
              s.pause.maxPerDay = Math.round(v);
              App.touch(true);
            }),
            numberField('Minimum gap', s.pause.minGapMinutes, 'min', 0, 480, (v) => {
              s.pause.minGapMinutes = Math.round(v);
              App.touch(true);
            }),
          ]),
          s.pause.maxPerDay === 0
            ? el('p', { class: 'hint', style: 'color:var(--amber);margin-top:8px', text: 'Pausing is disabled entirely. The escape hatch is welded shut.' })
            : null,
        ]),
        App.switchRow({
          title: 'Strict mode',
          hint: 'Only the lengths above are accepted and every duration is capped. A custom “45 minutes” is not possible.',
          value: s.pause.strict,
          onChange: (v) => {
            s.pause.strict = v;
            App.touch(true);
          },
        }),
      ])
    );

    return frag;
  }

  /* ================================================================== */
  /* INTENTIONS                                                         */
  /* ================================================================== */

  function renderIntentions() {
    const st = App.status || {};
    const stats = st.stats || {};
    const frag = document.createDocumentFragment();

    frag.appendChild(
      head(
        'Intentions',
        'What you said you were going to do, and what actually happened. A mirror, not a report card — nothing here leaves this browser.'
      )
    );

    frag.appendChild(
      el('div', { class: 'stat-grid' }, [
        statCell(String(stats.interventions || 0), 'interventions today'),
        statCell(String(stats.turnedAway || 0), 'walked away'),
        statCell(String(stats.intentions || 0), 'intentions written'),
        statCell(String(stats.sessions || 0), 'visits started'),
      ])
    );

    const log = (st.log || []).filter((e) => e.kind === 'intention ' .trim() || e.kind === 'turned-away' || e.kind === 'intervention');
    const intentions = log.filter((e) => e.kind === 'intention');

    frag.appendChild(
      group('Today’s intentions', [
        intentions.length
          ? el(
              'div',
              { style: 'padding:14px' },
              [
                el(
                  'div',
                  { class: 'intent-list' },
                  intentions.map((entry) =>
                    el('div', { class: 'intent' }, [
                      el('span', { class: 'when', text: new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
                      el('span', { class: 'what', text: entry.text || '(no intention written)' }),
                      el('span', { class: 'where', text: entry.site || '' }),
                    ])
                  )
                ),
              ]
            )
          : el('div', { style: 'padding:14px' }, [
              el('div', {
                class: 'empty-note',
                text: 'No intentions yet today. Turn on “Require an intention” under Friction, and every visit will start with one line about what you are actually doing.',
              }),
            ]),
      ])
    );

    frag.appendChild(
      group('Activity', [
        el('div', { style: 'padding:14px' }, [
          el(
            'div',
            { class: 'intent-list' },
            (st.log || []).slice(0, 12).map((entry) =>
              el('div', { class: 'intent' + (entry.kind === 'turned-away' ? ' turned' : '') }, [
                el('span', { class: 'when', text: new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
                el('span', { class: 'what', text: describe(entry) }),
                el('span', { class: 'where', text: entry.site || '' }),
              ])
            )
          ),
        ]),
      ])
    );

    return frag;
  }

  function describe(entry) {
    switch (entry.kind) {
      case 'visit':
        return 'Opened a tracked site';
      case 'visit-paused':
        return 'Opened while paused';
      case 'cooldown':
        return `Cooldown started (${entry.text})`;
      case 'blocked':
        return `Blocked — ${entry.text}`;
      case 'intervention':
        return 'Sat through the pause and continued';
      case 'turned-away':
        return 'Sat through the pause and closed the tab';
      case 'intention':
        return `“${entry.text}”`;
      default:
        return entry.kind;
    }
  }

  /* ================================================================== */
  /* PAGES                                                              */
  /* ================================================================== */

  function renderPages() {
    const frag = document.createDocumentFragment();
    frag.appendChild(
      head('Pages', 'The extension ships four surfaces besides this one. Open them here to see exactly what they look like with your current settings.')
    );

    const pages = [
      {
        title: 'Toolbar popup',
        blurb: 'Live state, the hold-to-pause button and per-site status.',
        path: '../popup/popup.html',
        note: 'Designed for a 372px window; opens fine as a tab too.',
      },
      {
        title: 'Dashboard',
        blurb: 'Today’s numbers, per-site focus time and a rules sandbox with a fake clock.',
        path: '../dashboard/dashboard.html',
        note: 'Useful for trying a ruleset change before committing to it.',
      },
      {
        title: 'Cooling-down page',
        blurb: 'What you see instead of a locked site.',
        path: '../blocked/blocked.html?site=youtube.com&reason=cooldown&until=' + (Date.now() + 420000),
        note: 'The countdown is live; the pause panel works from here.',
      },
      {
        title: 'Intervention screen',
        blurb: 'The friction gate from the Friction page, on its own.',
        path: '../intervention/intervention.html?site=youtube.com&label=YouTube&target=%23',
        note: 'Also previewed inline under Friction.',
      },
    ];

    const picker = el('div', { class: 'picker' });
    const frameWrap = el('div', { class: 'preview-frame', style: 'margin-top:4px' });
    const frame = el('iframe', { title: 'Page preview' });
    frameWrap.appendChild(frame);

    pages.forEach((page, index) => {
      picker.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'pick' + (index === 0 ? ' on' : ''),
            onclick: () => {
              for (const b of picker.children) b.classList.toggle('on', b === picker.children[index]);
              frame.src = page.path;
              note.textContent = page.note;
            },
          },
          [el('b', { text: page.title }), el('span', { text: page.blurb })]
        )
      );
    });

    const note = el('p', { class: 'tiny dim', text: pages[0].note });
    frame.src = pages[0].path;

    frag.appendChild(picker);
    frag.appendChild(el('div', { class: 'inline', style: 'justify-content:space-between' }, [
      note,
      el('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Open this page in a new tab ↗',
        onclick: () => {
          const active = [...picker.children].findIndex((b) => b.classList.contains('on'));
          window.open(pages[active < 0 ? 0 : active].path, '_blank');
        },
      }),
    ]));
    frag.appendChild(frameWrap);
    return frag;
  }

  /* ================================================================== */
  /* ADVANCED                                                           */
  /* ================================================================== */

  function renderAdvanced() {
    const frag = document.createDocumentFragment();
    frag.appendChild(head('Advanced', 'Maintenance, backups, and the emergency exits. Buried on purpose.'));

    frag.appendChild(
      group('Backup', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Export settings' }),
            el('p', { text: 'A single JSON file. Sites, interventions, schedules, pause policy — everything.' }),
          ]),
          el('button', {
            class: 'btn btn-sm',
            text: 'Export',
            onclick: () => {
              downloadBlob('focusfrost-settings.json', JSON.stringify(App.settings, null, 2));
              App.toast('Exported');
            },
          }),
        ]),
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Import settings' }),
            el('p', { text: 'Replaces everything on this machine. Values are clamped, so a broken file cannot do damage.' }),
          ]),
          el('button', { class: 'btn btn-sm', text: 'Choose file…', onclick: () => fileInput.click() }),
        ]),
      ])
    );

    const fileInput = el('input', {
      type: 'file',
      accept: 'application/json',
      style: 'display:none',
      onchange: async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          App.settings = Config.normalizeSettings(parsed);
          App.dirty = true;
          await App.saveNow();
          App.toast('Settings imported');
        } catch (_) {
          App.toast('That file is not valid FocusFrost settings');
        }
        e.target.value = '';
      },
    });
    frag.appendChild(fileInput);

    frag.appendChild(
      group('Emergency exits', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Clear every cooldown' }),
            el('p', { text: 'Lifts all lockouts and ends the current pause. For the genuine edge case, not for a weak moment.' }),
          ]),
          el('button', {
            class: 'btn btn-sm btn-danger',
            text: 'Release everything',
            onclick: async () => {
              if (!confirm('Release every cooldown and end the current pause?')) return;
              await App.send({ type: 'clearCooldowns' });
              await App.load();
              App.refreshPane();
              App.toast('All locks cleared');
            },
          }),
        ]),
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Reset statistics' }),
            el('p', { text: 'Clears today’s counts, focus time, intentions and the activity log. Settings are kept.' }),
          ]),
          el('button', {
            class: 'btn btn-sm',
            text: 'Reset stats',
            onclick: async () => {
              if (!confirm('Reset all statistics and clear the activity log?')) return;
              await App.send({ type: 'resetStats' });
              await App.load();
              App.refreshPane();
              App.toast('Statistics reset');
            },
          }),
        ]),
      ])
    );

    frag.appendChild(
      group('Danger zone', [
        el('div', { class: 'row-card' }, [
          el('div', { class: 'rc-text' }, [
            el('h3', { text: 'Reset FocusFrost completely' }),
            el('p', { class: 'warn', text: 'Deletes your sites, rules, schedules and history and returns to the stock defaults.' }),
          ]),
          el('button', {
            class: 'btn btn-sm btn-danger',
            text: 'Factory reset',
            onclick: async () => {
              if (!confirm('Delete all FocusFrost settings and history?')) return;
              const defaults = Config.defaultSettings();
              App.settings = defaults;
              App.dirty = true;
              await App.saveNow();
              App.toast('Reset to defaults');
            },
          }),
        ]),
      ])
    );

    const info = App.status || {};
    frag.appendChild(
      group('About', [
        el('div', { style: 'padding:16px' }, [
          el('p', { class: 'small muted', style: 'line-height:1.6', text:
            'FocusFrost stores everything in chrome.storage.local and mirrors settings to chrome.storage.sync. ' +
            'No accounts, no analytics, no network requests — the only external fetches are favicons on this page.' }),
          el('p', { class: 'tiny dim', style: 'margin-top:8px', text:
            `Version 1.1.0 · ${info.sites ? info.sites.length : 0} sites · ${Object.keys(info).length ? 'worker connected' : 'worker offline'}` }),
        ]),
      ])
    );

    return frag;
  }

  /* ================================================================== */
  /* registry                                                           */
  /* ================================================================== */

  const RENDERERS = {
    overview: renderOverview,
    sites: renderSites,
    friction: renderFriction,
    guardrails: renderGuardrails,
    schedule: renderSchedule,
    pause: renderPause,
    intentions: renderIntentions,
    pages: renderPages,
    advanced: renderAdvanced,
  };

  /** Rebuild the current section after a structural change (add/remove). */
  function rerender() {
    App.refreshPane();
  }

  /**
   * Explicit refreshers for sections that show live data.
   *
   * These are deliberately *not* used automatically after a save: replacing a
   * pane while the user is dragging a slider or typing into a field destroys the
   * control they are holding. The section that mutates something rebuilds itself
   * when it means to (e.g. adding a site), and App.renderChrome keeps the rest of
   * the page honest.
   */
  const REFRESHERS = {
    overview: renderOverview,
    sites: renderSites,
    schedule: renderSchedule,
    intentions: renderIntentions,
  };

  window.FFSections = { SECTIONS, RENDERERS, REFRESHERS, icon };
})();
