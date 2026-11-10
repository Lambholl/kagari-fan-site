// DOM 层：字幕、提示、章节卡、黑场与闪白。

const $ = (id) => document.getElementById(id);

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

  /**
   * 显示一行字幕并等它读完。
   * @param {string} text
   * @param {{speaker?: string, hold?: number, glyph?: boolean}} [o]
   */
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

  el.help.addEventListener('click', () => {
    el.helpBox.hidden = !el.helpBox.hidden;
  });

  return {
    el,
    say,
    narrate,
    clearNarration,
    get busy() {
      return saying || queue.length > 0;
    },
    /** 点击 / 空格：先补全打字，再翻到下一句 */
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
    setReady() {
      el.start.disabled = false;
      el.free.disabled = false;
      el.start.textContent = '走上山丘';
    },
    setPaused(v) {
      el.pause.hidden = !v;
    },
    setSound(on) {
      el.sound.classList.toggle('off', !on);
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
