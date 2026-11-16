// DOM 层：字幕、提示、章节卡、黑场与闪白。

const $ = (id) => document.getElementById(id);

/**
 * 绑定标题画面的加载进度条。
 * @returns {{update: (state: import('./loading.js').LoadingState) => void, fail: (message: string) => void}}
 *   update 刷新进度和阶段说明；fail 把进度条标成失败并显示 message。
 */
export function createLoadingView() {
  const root = $('loading');
  const bar = root.querySelector('.loading-track i');
  const label = root.querySelector('.loading-label');
  const percent = root.querySelector('.loading-percent');
  return {
    update({ value, label: text }) {
      const rounded = Math.floor(value * 100);
      bar.style.transform = `scaleX(${value})`;
      label.textContent = text;
      percent.textContent = `${rounded}%`;
      root.setAttribute('aria-valuenow', String(rounded));
      root.setAttribute('aria-valuetext', `${text} ${rounded}%`);
    },
    fail(message) {
      root.classList.add('failed');
      label.textContent = message;
      percent.textContent = '';
      root.setAttribute('aria-valuetext', message);
    },
  };
}

/** 创建负责字幕、提示、章节卡、黑场与设置面板的界面控制器。 */
export function createUI(timeline) {
  const el = {
    title: $('title'),
    start: $('btn-start'),
    free: $('btn-free'),
    hud: $('hud'),
    tag: $('chapter-tag'),
    converge: $('converge'),
    prompt: $('prompt'),
    promptText: $('prompt').querySelector('span'),
    sub: $('subtitle'),
    speaker: $('subtitle').querySelector('.speaker'),
    text: $('subtitle').querySelector('.text'),
    fade: $('fade'),
    flash: $('flash'),
    slash: $('slash'),
    card: $('card'),
    cardH: $('card').querySelector('h2'),
    cardP: $('card').querySelector('p'),
    pause: $('pause'),
    sound: $('btn-sound'),
    settings: $('btn-settings'),
    settingsBox: $('settings'),
    volume: $('volume'),
    volumeValue: $('volume-value'),
    antialias: $('antialias'),
    help: $('btn-help'),
    helpBox: $('help'),
    joystick: $('joystick'),
    joyKnob: $('joystick').querySelector('i'),
    act: $('btn-act'),
    sit: $('btn-sit'),
  };

  let sayToken = 0;
  let skipRequested = false;
  let saying = false;
  const queue = [];
  let queueRunning = false;

  /** 显示一行字幕并等它读完；hold 为停留秒数，glyph 启用抖动字效。 */
  async function say(text, o = {}) {
    const token = ++sayToken;
    saying = true;
    skipRequested = false;
    el.sub.hidden = false;
    el.sub.classList.toggle('glyph', !!o.glyph);
    el.speaker.textContent = o.speaker ? `【${o.speaker}】` : '';
    el.text.textContent = '';
    // 打字机
    const chars = [...text];
    let shown = 0;
    let acc = 0;
    const cps = 34;
    await timeline.until((dt) => {
      if (token !== sayToken) return true;
      acc += dt;
      const want = skipRequested ? chars.length : Math.min(chars.length, Math.floor(acc * cps));
      if (want !== shown) {
        shown = want;
        el.text.textContent = chars.slice(0, shown).join('');
      }
      if (shown >= chars.length) {
        skipRequested = false;
        return true;
      }
      return false;
    });
    if (token !== sayToken) return;
    // 停留
    const hold = o.hold ?? 1.5 + chars.length * 0.085;
    let t = 0;
    await timeline.until((dt) => {
      t += dt;
      return token !== sayToken || t >= hold || skipRequested;
    });
    skipRequested = false;
    if (token !== sayToken) return;
    saying = false;
    el.sub.hidden = true;
  }

  /** 不打断行动的旁白：排队依次显示 */
  function narrate(lines) {
    for (const l of lines) queue.push(typeof l === 'string' ? { text: l } : l);
    if (!queueRunning) runQueue();
  }
  async function runQueue() {
    queueRunning = true;
    while (queue.length) {
      const l = queue.shift();
      await say(l.text, l);
      await timeline.wait(0.25);
    }
    queueRunning = false;
  }
  function clearNarration() {
    queue.length = 0;
    sayToken++;
    saying = false;
    el.sub.hidden = true;
  }

  function fade(to, seconds = 1.2) {
    el.fade.style.transitionDuration = `${seconds}s`;
    // 强制一次回流，保证过渡生效
    void el.fade.offsetWidth;
    el.fade.style.opacity = String(to);
    return timeline.wait(seconds);
  }

  function retrigger(node) {
    node.classList.remove('on');
    void node.offsetWidth;
    node.classList.add('on');
  }

  async function card(title, sub = '', seconds = 3.2) {
    el.cardH.textContent = title;
    el.cardP.textContent = sub;
    el.card.hidden = false;
    void el.card.offsetWidth;
    el.card.classList.add('on');
    await timeline.wait(seconds);
    el.card.classList.remove('on');
    await timeline.wait(1.1);
    el.card.hidden = true;
  }

  let promptHandler = null;
  function setPrompt(text, handler = null) {
    promptHandler = text ? handler : null;
    if (!text) {
      el.prompt.hidden = true;
      el.act.hidden = true;
      return;
    }
    if (el.promptText.textContent !== text) el.promptText.textContent = text;
    el.prompt.hidden = false;
    if (isTouch) {
      el.act.textContent = text;
      el.act.hidden = false;
      el.prompt.hidden = true;
    }
  }

  let isTouch = false;
  function setTouchMode() {
    if (isTouch) return;
    isTouch = true;
    el.sit.hidden = false;
  }

  // 右上角一次只展开一个面板，避免设置遮住操作说明。
  function showPanel(panel) {
    el.settingsBox.hidden = panel !== 'settings';
    el.helpBox.hidden = panel !== 'help';
    el.settings.setAttribute('aria-expanded', String(!el.settingsBox.hidden));
    el.help.setAttribute('aria-expanded', String(!el.helpBox.hidden));
  }
  el.help.addEventListener('click', () => showPanel(el.helpBox.hidden ? 'help' : null));
  el.settings.addEventListener('click', () => {
    showPanel(el.settingsBox.hidden ? 'settings' : null);
    if (!el.settingsBox.hidden) el.volume.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.settingsBox.hidden) return;
    showPanel(null);
    el.settings.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!el.settingsBox.hidden && !el.settingsBox.contains(e.target) && !el.settings.contains(e.target)) {
      showPanel(null);
    }
  });

  return {
    el,
    get settingsOpen() {
      return !el.settingsBox.hidden;
    },
    say,
    narrate,
    clearNarration,
    get busy() {
      return saying || queue.length > 0;
    },
    /** 点击或按空格时，先补全正在打印的文字，再跳过等待进入下一句。 */
    advance() {
      if (saying) skipRequested = true;
    },
    fade,
    flash() {
      retrigger(el.flash);
    },
    slash() {
      retrigger(el.slash);
    },
    card,
    setPrompt,
    triggerPrompt() {
      if (promptHandler) {
        const h = promptHandler;
        h();
        return true;
      }
      return false;
    },
    setTag(text) {
      el.tag.textContent = text;
    },
    setConverge(n) {
      el.converge.hidden = n <= 0;
      el.converge.textContent = `再收束 × ${n}`;
    },
    showHud(v) {
      el.hud.hidden = !v;
    },
    hideTitle() {
      el.title.classList.add('gone');
    },
    /** 收起加载进度条，显示并启用两个开始按钮。 */
    setReady() {
      $('loading').hidden = true;
      el.start.disabled = false;
      el.free.disabled = false;
      el.start.closest('.actions').hidden = false;
    },
    /**
     * 显示或收起暂停界面。
     * @param {boolean} isPaused - 是否暂停。
     * @returns {void}
     */
    setPaused(isPaused) {
      el.pause.hidden = !isPaused;
    },
    setSound(isOn) {
      el.sound.classList.toggle('off', !isOn);
      el.sound.setAttribute('aria-pressed', String(isOn));
      el.sound.setAttribute('aria-label', isOn ? '关闭声音' : '开启声音');
      el.sound.title = isOn ? '关闭声音' : '开启声音';
    },
    /**
     * 显示音量滑条和百分比。
     * @param {number} value - 音量，取 0 至 1。
     * @returns {void}
     */
    setVolume(value) {
      const percentage = Math.round(value * 100);
      el.volume.value = String(percentage);
      el.volume.setAttribute('aria-valuetext', `${percentage}%`);
      el.volumeValue.textContent = `${percentage}%`;
    },
    setTouchMode,
    get isTouch() {
      return isTouch;
    },
    setJoystick(on, x, y, dx, dy) {
      el.joystick.hidden = !on;
      if (on) {
        el.joystick.style.left = `${x}px`;
        el.joystick.style.top = `${y}px`;
        el.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      }
    },
    setSitLabel(sitting) {
      el.sit.textContent = sitting ? '起身' : '坐下';
    },
  };
}
