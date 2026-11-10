import * as THREE from 'three';
import { isOnPaper, distanceToPaper } from './world/paper.js';
import { clamp, lerp } from './util/noise.js';

// 剧情：Moon 线开头到「三杯咖啡」的一段，改写成可以亲自走一遍的小小流程。
//
// stage 0  陌生人：靠近就会被缎带斩杀（至少会“再收束”一次）
// stage 1  被容许待在纸边 → 想到去泡咖啡
// stage 2-4 第一、二、三杯咖啡
// stage 5  被请进纸上；此后自由活动

const SPAWN = { x: 2.5, z: 39, yaw: 0.06, pitch: 0.16 };
const RESPAWN = { x: -2.2, z: 19, yaw: -0.1, pitch: 0.12 };
const FREE_SPAWN = { x: -1.2, z: 8.5, yaw: -0.12, pitch: 0.0 };
const linear = (k) => k;

export function createStory({ ui, tl, player, kagari, ribbons, paper, sky, items, audio, post, camera }) {
  const S = {
    mode: 'title',
    stage: 0,
    deaths: 0,
    busy: false,
    alertT: 0,
    spikeT: 0,
    strike: 0,
    alertOn: false,
    edgeTimer: 0,
    glanceTimer: 6,
    glanceHold: 0,
    gazeTimer: 0,
    shareCooldown: 0,
    cupFollow: null,
    reachSide: null,
    boundaryCooldown: 0,
    once: new Set(),
  };
  const ps = player.state;
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const playerLocal = new THREE.Vector3();
  const once = (key) => {
    if (S.once.has(key)) return false;
    S.once.add(key);
    return true;
  };

  // ———————————————————— 小工具 ————————————————————
  function lockForScene(sit = true) {
    S.busy = true;
    ui.clearNarration();
    ui.setPrompt(null);
    ps.moveLocked = true;
    if (sit) player.setSitting(true);
  }
  function unlock() {
    ps.moveLocked = false;
    ps.leanTarget = 0;
    S.busy = false;
  }
  /** 把视线柔和地带向她（不强夺鼠标：只转一小段时间） */
  function faceKagari(seconds = 0.9, heightOffset = 0) {
    kagari.headWorld(v1);
    v1.y += heightOffset;
    const aim = player.aimAt(v1);
    const y0 = ps.yaw;
    const p0 = ps.pitch;
    let dy = aim.yaw - y0;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    return tl.tween(seconds, (k) => {
      ps.yaw = y0 + dy * k;
      ps.pitch = lerp(p0, aim.pitch, k);
    });
  }

  async function timeSkip(lines) {
    await ui.fade(0.5, 1.0);
    const dur = 5.2;
    const lapse = tl.tween(dur, (k, raw) => sky.setLapse(Math.sin(raw * Math.PI) ** 2), linear);
    for (const l of lines) await ui.say(l, { hold: 1.9 });
    await lapse;
    sky.setLapse(0);
    await ui.fade(0, 1.2);
  }

  async function handToKagari(side) {
    const from = items.cupWorldPosition(v1).clone();
    items.worldCup.position.copy(from);
    items.worldCup.visible = true;
    items.setPose('hidden');
    items.cup.visible = false;
    items.cup.position.y = -0.7;
    kagari.setReach(side, 1, from);
    S.reachSide = side;
    await tl.wait(0.75);
    const to = new THREE.Vector3();
    await tl.tween(0.55, (k) => {
      kagari.palmWorld(side, to);
      items.worldCup.position.lerpVectors(from, to, k);
    });
    S.cupFollow = side;
  }

  async function handToPlayer(side) {
    S.cupFollow = null;
    const from = items.worldCup.position.clone();
    const to = new THREE.Vector3();
    await tl.tween(0.55, (k) => {
      to.set(0.03, -0.17, -0.74);
      camera.localToWorld(to);
      items.worldCup.position.lerpVectors(from, to, k);
    });
    items.worldCup.visible = false;
    items.cup.position.set(0.03, -0.17, -0.74);
    items.cup.visible = true;
    items.setPose('hold');
    kagari.setReach(side, 0);
    S.reachSide = null;
  }

  // ———————————————————— 开场 ————————————————————
  async function begin(free = false) {
    if (S.mode !== 'title') return;
    S.mode = 'play';
    ui.hideTitle();
    ui.showHud(true);
    audio.init();
    audio.resume();
    ps.active = true;
    if (free) {
      S.stage = 5;
      S.glanceTimer = 0;
      S.once.add('free');
      player.teleport(FREE_SPAWN.x, FREE_SPAWN.z, FREE_SPAWN.yaw, FREE_SPAWN.pitch);
      items.setThermos(true);
      items.setFull(true);
      items.setPose('hold');
      ui.setTag('自由漫步');
      player.requestLock();
      await tl.wait(1.2);
      ui.narrate([
        '从时间里脱落的夜晚。月亮只要还挂在天上，这个夜晚就不会结束。',
        '她已经容许我待在身边。走到纸上去也没关系。',
      ]);
      return;
    }
    player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch);
    ui.setTag('月光散步');
    player.requestLock();
    ui.card('月光散步', '', 2.4);
    await tl.wait(2.2);
    ui.narrate([
      { text: '……睡不着的夜晚。不，是不需要入睡的夜晚。', speaker: '瑚太朗' },
      '要去的地方，好像早就定下了。山丘——该到那座山丘上去。',
      '明明是深夜，却亮得出奇。巨大的月亮，用没有温度的光照着世界。',
    ]);
  }

  // ———————————————————— 死亡与再收束 ————————————————————
  const DEATH_LINES = [
    ['踩上纸面的一瞬间，所有的缎带同时化作了利刃。', '看来，“踩纸”这件事本身就会被当成敌意。'],
    ['换成光脚踩上去试试——还是不行。', '被搅乱的水中月，又一次映回了水面。'],
    ['视野裂成了几片。……已经有点习惯了。', '散开一次，再收束一次。仅此而已。'],
  ];

  async function die() {
    if (S.busy) return;
    lockForScene(false);
    const first = S.deaths === 0;
    S.alertT = 1;
    S.spikeT = 1;
    kagari.setLook(1, 9);
    audio.bristle();
    audio.setTension(1);
    await tl.wait(0.4);
    audio.slash();
    await tl.tween(0.15, (k) => (S.strike = k), linear);
    ui.flash();
    ui.slash();
    ps.shake = 1.6;
    const p0 = ps.pitch;
    const tumble = tl.tween(1.5, (k) => {
      ps.roll = k * 2.1;
      ps.pitch = lerp(p0, 0.95, k);
      post.desat = k;
      post.warp = k * 0.6;
    });
    await tl.wait(0.5);
    await ui.fade(1, 0.8);
    await tumble;
    S.deaths++;
    S.strike = 0;
    S.alertT = 0;
    S.spikeT = 0;
    S.alertOn = false;
    ribbons.state.alert = 0;
    ribbons.state.spike = 0;
    audio.setTension(0);
    kagari.setLook(0, 9);
    if (first) {
      await ui.say('有什么未知的东西，翻卷而起。');
      await ui.say('天空在旋转。脚下的山丘上，倒着一具没有头的身体——是我的。');
      await ui.say('……没关系。映在水面的月亮，就算被搅乱，也会立刻复原。', { speaker: '瑚太朗' });
      await ui.say('只要月亮，还没有从夜空里消失。');
    } else {
      const lines = DEATH_LINES[(S.deaths - 2) % DEATH_LINES.length];
      for (const l of lines) await ui.say(l);
    }
    player.setSitting(false);
    player.teleport(RESPAWN.x, RESPAWN.z, RESPAWN.yaw, RESPAWN.pitch);
    post.desat = 0;
    post.warp = 0;
    ui.setConverge(S.deaths);
    await ui.fade(0, 1.6);
    unlock();
    if (first) {
      ui.setTag('少女篝');
      ui.card('少女篝', '', 2.2);
      await tl.wait(2.4);
      ui.narrate([
        '于是，夜晚再度来临。明亮的，带着一点温度的夜。',
        '去见她。此刻的我，执着的只剩下这一件事。',
        '这一次，停在纸的外面——不要踩上去。',
      ]);
    }
  }

  // ———————————————————— 第一次接近：有力量的语言 ————————————————————
  async function seqGlyph() {
    lockForScene(false);
    kagari.setLook(1, 6);
    faceKagari(0.8);
    await tl.wait(0.9);
    await ui.say('少女用不带感情的眼睛，把我从头顶到脚尖扫了一遍。', { hold: 1.6 });
    await ui.say('不眨眼，也没有多余的动作，像一幅静止的画。那双眼睛深处，看不到属于人的灯火。');
    audio.glyph();
    ps.shake = 1.3;
    post.aberr = 1.6;
    await ui.say('■', { speaker: '少女', glyph: true, hold: 1.0 });
    await ui.say('第一次听见的少女的声音，像异国的语言一样在脑中炸开。');
    audio.glyph();
    ps.shake = 1.6;
    post.aberr = 2.2;
    await ui.say('■', { speaker: '少女', glyph: true, hold: 1.0 });
    S.spikeT = 1;
    audio.bristle();
    unlock();
    ui.narrate([
      '——头好痛。信息被高密度地折叠在那个声音里，对不成熟的听者来说，就是毒。',
      { text: '（再靠近的话……）', speaker: '瑚太朗' },
    ]);
  }

  // ———————————————————— 纸边：看着她 ————————————————————
  async function seqWatch() {
    lockForScene(true);
    S.alertT = 0.15;
    S.spikeT = 0;
    await ui.say('这个距离，她似乎不再在意了。正好是巨大用纸的外侧。');
    await ui.say('她用指尖描过纸面。写在那里的图形展开成一条线，又重新聚拢，变成别的图形。');
    await ui.say('数列与记号，线与边。全部是超出人类智慧的记述，只看得出整体是一张流程图。');
    // 盯着看下去，纸面上浮出一棵树形的流程图
    const dizzy = tl.tween(5.5, (k, raw) => {
      const s = Math.sin(raw * Math.PI);
      post.warp = s * 0.9;
      post.aberr = s * 1.5;
      paper.setTheory(Math.min(1, s * 1.6));
    }, linear);
    await ui.say('眯起眼睛看，它又像一棵巨大的树。最初只有一条的流，伸出枝条，呈扇形铺开——');
    await ui.say('（不能再看了。再看下去会疯掉。）', { speaker: '瑚太朗' });
    await dizzy;
    post.warp = 0;
    post.aberr = 0;
    paper.setTheory(0);
    await ui.say('只拾到一粒信息，里面就装着几千册专业书的分量。那是，生命的理论。');
    await ui.say('她一刻也不休息。而我，只是看着。');
    kagari.setTracing(0);
    await tl.wait(1.6);
    await ui.say('……她的手停住了。很长时间，一动不动。研究并不顺利。');
    await ui.say('真的，没有我能做的事吗。', { speaker: '瑚太朗' });
    S.stage = 1;
    unlock();
  }

  async function seqCoffeeTrip() {
    lockForScene(false);
    await ui.fade(1, 1.4);
    await ui.say('想了一会儿，我下到了镇上。');
    await ui.say('没有一盏灯的街道。水龙头却还出水。久违地磨了咖啡豆，慢慢地滴滤。');
    await ui.say('把刚泡好的咖啡装进保温瓶，回到山丘上。');
    items.setThermos(true);
    items.setFull(false);
    items.setPose('hold');
    S.stage = 2;
    player.setSitting(true);
    ui.setTag('三杯咖啡');
    await ui.fade(0, 1.6);
    unlock();
    ui.card('三杯咖啡', '', 2.2);
  }

  // ———————————————————— 第一杯 ————————————————————
  async function seqCup1() {
    lockForScene(true);
    faceKagari(1.0, -0.15);
    ps.leanTarget = 0.3;
    audio.pour();
    items.setFull(true);
    items.setPose('offer');
    await ui.say('往纯白的内杯里倒得满满的，伸长了手臂递过去。这样，就不用踩到纸了。');
    kagari.setLook(1, 4);
    await tl.wait(1.1);
    await ui.say('………', { speaker: '篝', hold: 1.2 });
    S.spikeT = 0.7;
    S.alertT = 0.45;
    audio.bristle();
    await ui.say('一瞥。周围漂着的缎带，根根倒竖了起来。——今天，没有再凶下去。');
    kagari.setLook(0, 5);
    S.spikeT = 0;
    S.alertT = 0;
    await ui.say('她一扭头，回到了图纸上。不需要。态度是这么说的。');
    ps.leanTarget = 0;
    items.setPose('drink');
    await tl.wait(1.3);
    items.setFull(false);
    await ui.say('那就自己喝。……好喝。久违的味道。', { speaker: '瑚太朗' });
    kagari.setLook(1, 2.2);
    items.setPose('hold');
    await ui.say('我喝咖啡的样子，被她斜着眼看在了眼里。');
    kagari.setLook(0, 3);
    kagari.setTracing(1);
    await timeSkip(['不属于时间的时间，流了过去。', '她的手再一次停下，主观上已经是几个月之后。']);
    kagari.setTracing(0);
    S.stage = 3;
    unlock();
  }

  // ———————————————————— 第二杯 ————————————————————
  async function seqCup2() {
    lockForScene(true);
    faceKagari(1.0, -0.15);
    ps.leanTarget = 0.3;
    audio.pour();
    items.setFull(true);
    items.setPose('offer');
    kagari.setLook(1, 3);
    await ui.say('不经意间，和她对上了视线。真是稀奇。……请。', { speaker: '瑚太朗' });
    kagari.setExpression('stare');
    await ui.say('她眯起眼睛，凝视着那只杯子。');
    const lapse = tl.tween(3.6, (k, raw) => sky.setLapse(Math.sin(raw * Math.PI) ** 2 * 0.8), linear);
    await ui.say('主观时间里，就这样过了大约四天。', { hold: 2.4 });
    await lapse;
    sky.setLapse(0);
    kagari.setExpression('neutral');
    const side = kagari.nearerSide(camera.position);
    await handToKagari(side);
    await ui.say('然后——她接过了杯子。没抱期待的我，屏住了呼吸。');
    await ui.fade(1, 0.5);
    await ui.say('一副“没办法，这浑浊的泥水我就喝给你看吧”的样子，她把嘴凑上了杯沿。');
    items.setFull(false);
    await ui.fade(0, 0.7);
    await ui.say('空了的杯子，被递了回来。');
    await handToPlayer(side);
    await ui.say('是不要了，还是再来一杯？犹豫了一下，我直接去倒第二杯——');
    audio.flick();
    items.jolt();
    ps.shake = 0.6;
    S.spikeT = 0.5;
    await ui.say('啪。缎带把保温瓶从我手边弹开了。不要了，的意思。');
    S.spikeT = 0;
    await ui.say('“想用这种饮料讨我欢心，真像下等的人类会想的事。”——那横过来的眼神，像是在这么说。');
    await ui.say('一点也不觉得难受。她表达了自己的意思。这可是大事件。', { speaker: '瑚太朗' });
    kagari.setLook(0, 3);
    kagari.setTracing(1);
    ps.leanTarget = 0;
    await timeSkip(['然后，不属于时间的时间又流了过去。', '一百年也好，一千年也好，对现在的我没有分别。']);
    S.stage = 4;
    unlock();
  }

  // ———————————————————— 第三杯 ————————————————————
  async function seqCup3() {
    lockForScene(true);
    const side = S.reachSide || kagari.nearerSide(camera.position);
    faceKagari(1.0, -0.15);
    ps.leanTarget = 0.3;
    await ui.say('啊……马上就好。', { speaker: '瑚太朗', hold: 1.0 });
    audio.pour();
    items.setFull(true);
    items.setPose('offer');
    await ui.say('咖啡像刚煮开一样冒着热气。用发抖的手，把杯子递了过去。');
    await handToKagari(side);
    await ui.fade(1, 0.5);
    await ui.say('细细的喉咙动了一下。应该很烫，她却毫不在意，一口气喝干了。');
    items.setFull(false);
    await ui.fade(0, 0.7);
    await handToPlayer(side);
    await ui.say('只有杯子被递了回来。那一刻，手指碰到了。');
    // 她抓住主角的手，拉了过去
    v2.set(0.05, -0.22, -0.6);
    camera.localToWorld(v2);
    kagari.setReach(side, 1, v2);
    await tl.wait(0.5);
    await ui.say('突然，她抓住了我的手指。用幼儿般粗鲁的手劲，拉了过去。');
    const x0 = ps.x;
    const z0 = ps.z;
    const d = Math.hypot(x0, z0) || 1;
    const pull = clamp(d - 1.25, 0.25, 0.85);
    ps.shake = 0.7;
    await tl.tween(0.9, (k) => {
      ps.x = x0 - (x0 / d) * pull * k;
      ps.z = z0 - (z0 / d) * pull * k;
    });
    S.stage = 5; // 从这一刻起，纸不再是禁区
    await ui.say('脚尖，越过了她的领土。');
    await ui.say('——要被杀掉了吧。我做好了准备。', { hold: 1.5 });
    await tl.wait(1.2);
    paper.ripple();
    audio.open();
    await ui.say('攻击，没有来。', { hold: 2.0 });
    kagari.setReach(side, 0);
    await ui.say('篝……？　可、可以吗？', { speaker: '瑚太朗' });
    await ui.say('………', { speaker: '篝', hold: 1.2 });
    await ui.say('仅仅三杯咖啡，就拆掉了最后一堵墙。');
    await ui.say('编织着未知理论的、蓝色的、小小的四边之国。我终于，被请了进来。');
    await ui.say('没有谎言也没有虚荣的国度。一根比蛛丝还细的、透明的线，连在了我们之间。');
    await ui.say('不知什么时候，有热的水滴滑过了我的脸颊。');
    v2.set(0.02, -0.1, -0.42);
    camera.localToWorld(v2);
    kagari.setReach(side, 1, v2);
    await ui.say('她用指尖接住那滴水，举到月光下，透着光看。');
    kagari.setReach(side, 0);
    await tl.wait(0.9);
    kagari.setExpression('smile');
    audio.chime();
    await tl.wait(1.6);
    await ui.say('少女……在笑。', { hold: 2.8 });
    await ui.say('没有声音，只有表情的微笑。眼睛柔和地细起来，嘴角微微上扬。');
    await ui.say('篝。你并不是什么无法理解的存在。', { speaker: '瑚太朗', hold: 2.8 });
    unlock();
    S.glanceHold = 6;
    S.glanceTimer = 8;
    ui.setTag('月光散步 · 余韵');
    ui.card('月光散步', '—— 完 ——\n可以继续留在这座山丘上', 4.2);
    await tl.wait(7);
    ui.narrate(['她继续研究，我在一旁守着。这样的状态，一直持续了下去。', '偶尔目光会对上。朝她笑一笑，她就又回到图纸上。很冷淡。但这样就好。']);
  }

  // ———————————————————— 之后：一起喝咖啡 ————————————————————
  async function seqShare() {
    lockForScene(false);
    const side = kagari.nearerSide(camera.position);
    faceKagari(0.9, -0.1);
    audio.pour();
    items.setFull(true);
    items.setPose('offer');
    kagari.setLook(1, 3);
    await tl.wait(0.9);
    await handToKagari(side);
    await ui.fade(1, 0.5);
    await ui.say('有时，两个人一起啜着滚烫的咖啡。像被毯子裹住一样，温暖的体验。');
    items.setFull(false);
    await ui.fade(0, 0.7);
    await handToPlayer(side);
    kagari.setLook(0, 2);
    S.shareCooldown = 25;
    unlock();
  }

  // ———————————————————— 逐帧逻辑 ————————————————————
  function update(dt, time) {
    playerLocal.copy(camera.position);
    kagari.group.worldToLocal(playerLocal);

    if (S.cupFollow) kagari.palmWorld(S.cupFollow, items.worldCup.position);

    if (S.mode === 'play' && !S.busy) {
      const dK = Math.hypot(ps.x, ps.z);
      const onPaper = isOnPaper(ps.x, ps.z);
      const dPaper = distanceToPaper(ps.x, ps.z);
      const canSee = kagari.state.canSee;
      const atEdge = !onPaper && dK < 3.1 && canSee;
      let prompt = null;
      let handler = null;
      S.shareCooldown = Math.max(0, S.shareCooldown - dt);
      S.boundaryCooldown = Math.max(0, S.boundaryCooldown - dt);

      if (S.stage === 0) {
        if (dK < 29 && once('hill')) {
          ui.narrate(['白与黑的雏菊开满了山丘，柔柔地接住月光。']);
        }
        if (dK < 17.5 && once('see')) {
          ui.clearNarration();
          ui.narrate([
            '然后，她就在那里。山丘的顶上。',
            '没有桌子也没有椅子的地方，铺着一张纸。大得难以置信，比野餐垫还要大得多。',
            '在那正中的花芯处，一个少女像在寻找什么似的，伏在纸上。',
          ]);
        }
        // 缎带：靠近时浮起（带迟滞）
        if (!S.alertOn && dK < 11) {
          S.alertOn = true;
          audio.ribbonRise();
          if (once('ribbon')) {
            ui.narrate(['明明没有风——系在她两只手腕上的缎带，却轻飘飘地浮了起来。', '那缎带上，栖着一股不祥的气息。']);
          }
        } else if (S.alertOn && dK > 13.5) S.alertOn = false;
        const base = S.deaths === 0 ? 1 : 0.7;
        S.alertT = S.alertOn ? base : 0;
        audio.setTension(S.alertOn ? (S.deaths === 0 ? 0.6 : 0.25) : 0);
        kagari.setLook(dK < 8.5 ? 1 : 0, 3);

        if (S.deaths === 0) {
          if (dK < 6.4 && once('glyph')) seqGlyph();
          else if (dK < 4.3 || onPaper) die();
          if (S.once.has('glyph') && !S.busy) S.spikeT = dK < 8 ? 1 : 0;
        } else {
          S.spikeT = dPaper < 0.5 ? 0.8 : 0;
          if (onPaper) die();
          else if (atEdge && ps.speed < 0.4) {
            S.edgeTimer += dt;
            if (S.edgeTimer > 1.4) seqWatch();
          } else S.edgeTimer = 0;
        }
      } else if (S.stage < 5) {
        // 被容许待在纸边；但纸仍是她的领土
        const near = dK < 7;
        S.alertT = near ? [0, 0.22, 0.14, 0.07, 0][S.stage] : 0;
        S.spikeT = dPaper < 0.35 ? 0.7 : 0;
        audio.setTension(dPaper < 0.35 ? 0.3 : 0);
        if (onPaper) die();
        else {
          // 偶尔瞥一眼
          if (S.stage < 4) {
            S.glanceTimer -= dt;
            if (S.glanceTimer <= 0) {
              S.glanceHold = 1.6;
              S.glanceTimer = 9 + Math.random() * 7;
            }
            S.glanceHold = Math.max(0, S.glanceHold - dt);
            kagari.setLook(S.glanceHold > 0 && dK < 6 ? 1 : 0, 3);
          }
          if (atEdge) {
            if (S.stage === 1) {
              prompt = '下山，泡一壶咖啡';
              handler = seqCoffeeTrip;
            } else if (S.stage === 2) {
              prompt = '递出咖啡';
              handler = seqCup1;
            } else if (S.stage === 3) {
              prompt = '再倒一杯，递过去';
              handler = seqCup2;
            } else if (S.stage === 4) {
              prompt = '倒咖啡';
              handler = seqCup3;
            }
          }
          if (S.stage === 4) {
            // 她自己伸出了手
            if (atEdge) {
              const side = kagari.nearerSide(camera.position);
              v3.set(0.0, -0.42, -0.62);
              camera.localToWorld(v3);
              kagari.setReach(side, 1, v3);
              S.reachSide = side;
              kagari.setLook(1, 2.5);
              if (once('reach')) {
                ui.narrate(['回过神来，眼前有一只近乎透明的手，在发着光。', '手心朝上，笔直地伸向我。像是在索要什么。']);
              }
            } else if (S.reachSide) {
              kagari.setReach(S.reachSide, 0);
              S.reachSide = null;
              kagari.setLook(0, 2.5);
            }
          }
        }
      } else {
        // —— stage 5：自由 ——
        S.alertT = 0;
        S.spikeT = 0;
        audio.setTension(0);
        // 主角注视她一会儿，她会抬头回望
        kagari.headWorld(v1);
        v2.subVectors(v1, camera.position);
        const dist = v2.length();
        v2.normalize();
        camera.getWorldDirection(v3);
        const gazing = dist < 4.2 && v2.dot(v3) > 0.93 && canSee;
        S.gazeTimer = gazing ? S.gazeTimer + dt : Math.max(0, S.gazeTimer - dt * 2);
        if (S.gazeTimer > 1.6 && S.glanceHold <= 0 && S.glanceTimer <= 0) {
          S.glanceHold = 4.5;
          S.glanceTimer = 11;
          S.gazeTimer = 0;
        }
        S.glanceTimer = Math.max(0, S.glanceTimer - dt);
        if (S.glanceHold > 0) {
          S.glanceHold -= dt;
          kagari.setLook(1, 2.6);
          kagari.setExpression('smile');
        } else {
          kagari.setLook(0, 2.2);
          if (kagari.state.look < 0.08) kagari.setExpression('neutral');
        }
        kagari.setTracing(1);
        if (dK < 2.7 && canSee && S.shareCooldown <= 0) {
          prompt = '递一杯咖啡';
          handler = seqShare;
        }
        if (ps.sitting && dK < 3 && once('sitBeside')) {
          ui.narrate(['在她身旁坐下。理论太过高深，视线自然而然地，被她的侧脸吸了过去。']);
        }
      }
      ui.setPrompt(prompt, handler);
    }

    ribbons.update(dt, time, {
      alert: S.alertT,
      spike: S.spikeT,
      strike: S.strike,
      playerLocal,
    });
  }

  return {
    state: S,
    begin,
    update,
    onBoundary() {
      if (S.mode !== 'play' || S.busy || S.boundaryCooldown > 0) return;
      S.boundaryCooldown = 18;
      ui.narrate(['再往前，就不是“今夜”所在的地方了。']);
    },
  };
}
