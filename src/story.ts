import * as THREE from 'three'
import { isOnPaper, distanceToPaper } from './world/paper.ts'
import { clamp, lerp } from './util/noise.ts'
import { SCENE_LAYOUT } from './world/scene-layout.ts'
import type { ClipKind, createPlayer } from './player.ts'
import type { createUI, NarrationLine } from './ui.ts'
import type { createKagari } from './kagari/kagari.ts'
import type { createRibbons } from './kagari/ribbons.ts'
import type { createPaper } from './world/paper.ts'
import type { createSky } from './world/sky.ts'
import type { createItems } from './items.ts'
import type { createAudio } from './audio.ts'
import type { createTimeline } from './util/timeline.ts'
import type { StoryMessageKey } from './i18n.ts'

type HandSide = ReturnType<Awaited<ReturnType<typeof createKagari>>['nearerSide']>

interface StoryOptions {
  ui: ReturnType<typeof createUI>
  tl: ReturnType<typeof createTimeline>
  player: ReturnType<typeof createPlayer>
  kagari: Awaited<ReturnType<typeof createKagari>>
  ribbons: ReturnType<typeof createRibbons>
  paper: ReturnType<typeof createPaper>
  sky: ReturnType<typeof createSky>
  items: ReturnType<typeof createItems>
  audio: ReturnType<typeof createAudio>
  post: { warp: number; desat: number; aberr: number }
  camera: THREE.PerspectiveCamera
}

// 剧情：Moon 线开头到「三杯咖啡」的一段，改写成可以亲自走一遍的小小流程。
//
// stage 0   陌生人：靠近或踩上纸面就会被缎带斩杀
// stage 1   被容许待在纸边，准备下山泡咖啡
// stage 2-4 第一、二、三杯咖啡
// stage 5   被请进纸上，此后自由活动

const SPAWN = SCENE_LAYOUT.spawn
const STAGE_ALERT = [0, 0.22, 0.14, 0.07, 0, 0] as const
const linear = (k: number) => k

const reportStoryError = (error: unknown) => {
  console.error('剧情演出失败', error)
}

/** 创建剧情状态机与逐帧推进逻辑。 */
export const createStory = ({
  ui,
  tl,
  player,
  kagari,
  ribbons,
  paper,
  sky,
  items,
  audio,
  post,
  camera,
}: StoryOptions) => {
  const S = {
    mode: 'title' as 'title' | 'play',
    stage: 0 as 0 | 1 | 2 | 3 | 4 | 5,
    deaths: 0,
    isBusy: false,
    alertT: 0,
    spikeT: 0,
    strike: 0,
    isAlertOn: false,
    edgeTimer: 0,
    glanceTimer: 6,
    glanceHold: 0,
    gazeTimer: 0,
    shareCooldown: 0,
    cupFollow: null as HandSide | null,
    reachSide: null as HandSide | null,
    boundaryCooldown: 0,
    once: new Set<string>(),
  }
  const ps = player.state
  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  const v3 = new THREE.Vector3()
  const playerLocal = new THREE.Vector3()
  const once = (key: string) => {
    if (S.once.has(key)) {
      return false
    }
    S.once.add(key)
    return true
  }

  // ———————————————————— 小工具 ————————————————————
  const lockForScene = (shouldSit = true) => {
    S.isBusy = true
    ui.clearNarration()
    ui.setPrompt(null)
    ps.isMoveLocked = true
    if (shouldSit) {
      player.setSitting(true)
    }
  }
  const unlock = () => {
    ps.isMoveLocked = false
    ps.leanTarget = 0
    S.isBusy = false
  }
  /** 把视线柔和地带向她，只转向指定秒数而不接管后续鼠标控制。 */
  const faceKagari = (seconds = 0.9, heightOffset = 0) => {
    kagari.headWorld(v1)
    v1.y += heightOffset
    const aim = player.aimAt(v1)
    const y0 = ps.yaw
    const p0 = ps.pitch
    let dy = aim.yaw - y0
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    return tl.tween(seconds, (k) => {
      ps.yaw = y0 + dy * k
      ps.pitch = lerp(p0, aim.pitch, k)
    })
  }

  const timeSkip = async (lines: readonly StoryMessageKey[]) => {
    await ui.fade(0.5, 1.0)
    const dur = 5.2
    const lapse = tl.tween(dur, (_k, raw) => sky.setLapse(Math.sin(raw * Math.PI) ** 2), linear)
    for (const l of lines) {
      await ui.say(l, { hold: 1.9 })
    }
    await lapse
    sky.setLapse(0)
    await ui.fade(0, 1.2)
  }

  const handToKagari = async (side: HandSide) => {
    const from = items.cupWorldPosition(v1).clone()
    items.worldCup.position.copy(from)
    items.worldCup.visible = true
    items.setPose('hidden')
    items.cup.visible = false
    items.cup.position.y = -0.7
    kagari.setReach(side, 1, from)
    S.reachSide = side
    await tl.wait(0.75)
    const to = new THREE.Vector3()
    await tl.tween(0.55, (k) => {
      kagari.palmWorld(side, to)
      items.worldCup.position.lerpVectors(from, to, k)
    })
    S.cupFollow = side
  }

  const handToPlayer = async (side: HandSide) => {
    S.cupFollow = null
    const from = items.worldCup.position.clone()
    const to = new THREE.Vector3()
    await tl.tween(0.55, (k) => {
      to.set(0.03, -0.17, -0.74)
      camera.localToWorld(to)
      items.worldCup.position.lerpVectors(from, to, k)
    })
    items.worldCup.visible = false
    items.cup.position.set(0.03, -0.17, -0.74)
    items.cup.visible = true
    items.setPose('hold')
    kagari.setReach(side, 0)
    S.reachSide = null
  }

  // ———————————————————— 开场 ————————————————————
  const begin = async (isFree = false) => {
    if (S.mode !== 'title') {
      return
    }
    S.mode = 'play'
    ui.hideTitle()
    ui.showHud(true)
    audio.init()
    audio.resume()
    ps.isActive = true
    if (isFree) {
      S.stage = 5
      S.glanceTimer = 0
      S.once.add('free')
      player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
      items.setThermos(true)
      items.setFull(true)
      items.setPose('hold')
      ui.setTag('freeRoam')
      player.requestLock()
      await tl.wait(1.2)
      ui.narrate(['freeRoamNight', 'freeRoamPermission'])
      return
    }
    player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
    ui.setTag('moonwalk')
    player.requestLock()
    ui.card('moonwalk', null, 2.4).catch(reportStoryError)
    await tl.wait(2.2)
    ui.narrate([{ text: 'sleeplessNight', speaker: 'kotarou' }, 'headedForHill', 'brightMidnight'])
  }

  // ———————————————————— 死亡与再收束 ————————————————————
  const DEATH_LINES = [
    ['ribbonsTurnToBlades', 'paperAsHostility'],
    ['barefootAttempt', 'moonReflectedAgain'],
    ['visionShatters', 'scatterAndConverge'],
  ] as const

  const die = async () => {
    if (S.isBusy) {
      return
    }
    lockForScene(false)
    const isFirst = S.deaths === 0
    S.alertT = 1
    S.spikeT = 1
    kagari.setLook(1, 9)
    audio.bristle()
    audio.setTension(1)
    await tl.wait(0.4)
    audio.slash()
    await tl.tween(0.15, (k) => (S.strike = k), linear)
    ui.flash()
    ui.slash()
    ps.shake = 1.6
    const p0 = ps.pitch
    const tumble = tl.tween(1.5, (k) => {
      ps.roll = k * 2.1
      ps.pitch = lerp(p0, 0.95, k)
      post.desat = k
      post.warp = k * 0.6
    })
    await tl.wait(0.5)
    await ui.fade(1, 0.8)
    await tumble
    S.deaths++
    S.strike = 0
    S.alertT = 0
    S.spikeT = 0
    S.isAlertOn = false
    ribbons.state.alert = 0
    ribbons.state.spike = 0
    audio.setTension(0)
    kagari.setLook(0, 9)
    if (isFirst) {
      await ui.say('somethingUnfurls')
      await ui.say('headlessBody')
      await ui.say('moonReforms', { speaker: 'kotarou' })
      await ui.say('whileMoonRemains')
    } else {
      const lines = DEATH_LINES[(S.deaths - 2) % DEATH_LINES.length]!
      for (const l of lines) {
        await ui.say(l)
      }
    }
    player.setSitting(false)
    player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
    post.desat = 0
    post.warp = 0
    ui.setConverge(S.deaths)
    await ui.fade(0, 1.6)
    unlock()
    if (isFirst) {
      ui.setTag('girlKagari')
      ui.card('girlKagari', null, 2.2).catch(reportStoryError)
      await tl.wait(2.4)
      ui.narrate(['nightReturns', 'seeHerAgain', 'stayOffPaper'])
    }
  }

  // ———————————————————— 彩蛋：摔死与撞树 ————————————————————
  // 与缎带斩杀分开计数，剧情阶段保持不变，第一次死亡的那段独白只留给缎带斩杀。
  // 每种死法第一次播放完整独白，之后轮流播放短独白。
  const MISHAPS = {
    fall: {
      first: [
        'footingGivesWay',
        'rememberCliff',
        'windAndTumblingMoon',
        'shatteringOnImpact',
        'beneathCliff',
        'simpleMisstep',
        'undignifiedFall',
      ],
      repeat: [
        ['offTheEdgeAgain', 'gravityForEveryone'],
        ['timeToReflect', 'watchYourStep'],
        ['deathByMisstep', 'daisiesRecognizeMe'],
      ],
    },
    tree: {
      first: [
        'barkAhead',
        'rememberTree',
        'foreheadHitsTree',
        'betweenTheRoots',
        'treeStandsFirm',
        'undignifiedCrash',
      ],
      repeat: [
        ['hitTheTrunkAgain', 'treeWontMove'],
        ['whyRun', 'barkFromMemory'],
        ['deathByTree', 'treeSeemsToLaugh'],
      ],
    },
  } as const
  const mishapCounts = { fall: 0, tree: 0 }

  /**
   * 播放摔死或撞树后的倒地演出和独白，结束后送回出生点。
   */
  const mishapDeath = async (kind: ClipKind) => {
    if (S.mode !== 'play') {
      return
    }
    // 其他场景正在进行时跳过独白直接送回出生点，免得一直躺着动不了。
    if (S.isBusy) {
      player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
      return
    }
    lockForScene(false)
    const { first, repeat } = MISHAPS[kind]
    const isFirst = mishapCounts[kind] === 0
    mishapCounts[kind]++
    // 仰面躺倒：视线慢慢转向夜空，画面褪色，然后才出现独白。
    const p0 = ps.pitch
    const r0 = ps.roll
    await tl.tween(1.8, (k) => {
      ps.pitch = lerp(p0, 1.35, k)
      ps.roll = lerp(r0, 0.12, k)
      post.desat = k * 0.7
    })
    await tl.wait(0.6)
    const lines = isFirst ? first : repeat[(mishapCounts[kind] - 2) % repeat.length]!
    for (const l of lines) {
      await ui.say(l)
    }
    await ui.fade(1, 1.2)
    if (isFirst) {
      await ui.say('waterSettles')
    }
    player.setSitting(false)
    player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
    post.desat = 0
    post.warp = 0
    await ui.fade(0, 1.6)
    unlock()
  }

  // ———————————————————— 彩蛋：穿模，掉出世界 ————————————————————
  // 撞树撞死过或穿过树干之后，再撞树时有 CLIP_CHANCE 的概率穿过树干、掉出世界；
  // 摔死过或穿过崖下地面之后，再摔到会摔死的高度时，同样有 CLIP_CHANCE 的概率穿过地面。
  // 主角在这里意识到自己身在一个同人游戏里。第一次穿模（不论哪一种）播放完整独白，之后按穿模的种类轮流播放短独白。
  const CLIP_CHANCE = 0.25
  const CLIP_LINES = {
    tree: {
      // 穿进树干、开始往下沉的时候
      enter: ['surprised', 'barkFromInside', 'nothingInside', 'nothingUnderfoot'],
      // 意识到这是同人游戏之后，想到自己是怎么掉出来的
      cause: ['treeCollisionCircle', 'whoKeepsRunning'],
      repeat: [
        ['throughTrunkAgain', 'fanGamePhysics'],
        ['worldStillEmpty', 'tryAnotherTree'],
        ['countingCrashes', 'stoppedCounting'],
      ],
    },
    fall: {
      enter: ['surprised', 'noImpact', 'groundSwallowsMe', 'beneathTheBottom'],
      cause: ['groundCollisionSkin', 'whoKeepsFalling'],
      repeat: [
        ['throughGroundAgain', 'whichFallIsWorse'],
        ['belowIsWorldsBack', 'shortcutNotInGuide'],
        ['landAndKeepFalling', 'landingOutsideWorld'],
      ],
    },
    // 两种穿模共用，视线转向头顶的世界之后播放，cause 插在 realize 和 after 之间。
    realize: [
      'everythingAbove',
      'thinWorld',
      { text: 'coordinatesThought', speaker: 'kotarou' },
      'coordinatesTooFar',
      'rememberGame',
      'thisIsAFanGame',
    ],
    after: ['moonLightsTheBack', 'noUseThinking', 'authorLeavesBug'],
  } as const
  const clipCounts = { tree: 0, fall: 0 }
  // 各种穿模已经播放过的短独白段数，用来轮换。
  const clipRepeatCounts = { tree: 0, fall: 0 }

  /** 依次显示独白；带 speaker 的行是说出口的话。 */
  const sayLines = async (lines: readonly NarrationLine[]) => {
    for (const l of lines) {
      if (typeof l === 'string') {
        await ui.say(l)
      } else {
        await ui.say(l.text, l)
      }
    }
  }

  /**
   * 穿模后的演出：边往下掉边抬头看头顶的世界，播放独白，之后送回出生点。
   * 调用前玩家必须已经进入掉出世界的状态。
   */
  const clipOutOfWorld = async (kind: ClipKind) => {
    lockForScene(false)
    const isFirst = clipCounts.tree + clipCounts.fall === 0
    clipCounts[kind]++
    // 穿过去的一瞬间画面错位一下，色差由逐帧逻辑自己衰减。
    post.aberr = 2.4
    ps.shake = 0.5
    await tl.wait(0.9)
    const p0 = ps.pitch
    const r0 = ps.roll
    // 慢慢仰起头，身体跟着轻轻侧翻。
    const lookUp = () =>
      tl.tween(5, (k) => {
        ps.pitch = lerp(p0, 1.25, k)
        ps.roll = lerp(r0, 0.35, k)
      })
    const lines = CLIP_LINES[kind]
    if (isFirst) {
      await sayLines(lines.enter)
      const turning = lookUp()
      await tl.wait(2.5)
      await sayLines([...CLIP_LINES.realize, ...lines.cause, ...CLIP_LINES.after])
      await turning
    } else {
      const turning = lookUp()
      await sayLines(lines.repeat[clipRepeatCounts[kind]++ % lines.repeat.length]!)
      await turning
    }
    await ui.fade(1, 1.6)
    if (isFirst) {
      await ui.say('dontTellKagari', { speaker: 'kotarou' })
    }
    player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, SPAWN.pitch)
    post.desat = 0
    post.warp = 0
    await ui.fade(0, 1.6)
    unlock()
  }

  // ———————————————————— 第一次接近：有力量的语言 ————————————————————
  const seqGlyph = async () => {
    lockForScene(false)
    kagari.setLook(1, 6)
    faceKagari(0.8).catch(reportStoryError)
    await tl.wait(0.9)
    await ui.say('girlLooksMeOver', { hold: 1.6 })
    await ui.say('stillAsPicture')
    audio.glyph()
    ps.shake = 1.3
    post.aberr = 1.6
    await ui.say('unreadableGlyph', { speaker: 'girl', hasGlyphEffect: true, hold: 1.0 })
    await ui.say('firstVoice')
    audio.glyph()
    ps.shake = 1.6
    post.aberr = 2.2
    await ui.say('unreadableGlyph', { speaker: 'girl', hasGlyphEffect: true, hold: 1.0 })
    S.spikeT = 1
    audio.bristle()
    unlock()
    ui.narrate(['voiceLikePoison', { text: 'anyCloser', speaker: 'kotarou' }])
  }

  // ———————————————————— 纸边：看着她 ————————————————————
  const seqWatch = async () => {
    lockForScene(true)
    S.alertT = 0.15
    S.spikeT = 0
    await ui.say('safeAtPaperEdge')
    await ui.say('shapesUnfold')
    await ui.say('numbersAndSymbols')
    // 盯着看下去，纸面上浮出一棵树形的流程图
    const dizzy = tl.tween(
      5.5,
      (k, raw) => {
        const s = Math.sin(raw * Math.PI)
        post.warp = s * 0.9
        post.aberr = s * 1.5
        paper.setTheory(Math.min(1, s * 1.6))
      },
      linear,
    )
    await ui.say('theoryLikeTree')
    await ui.say('mustStopLooking', { speaker: 'kotarou' })
    await dizzy
    post.warp = 0
    post.aberr = 0
    paper.setTheory(0)
    await ui.say('theoryOfLife')
    await ui.say('sheNeverRests')
    kagari.setTracing(0)
    await tl.wait(1.6)
    await ui.say('researchStalls')
    await ui.say('canIHelp', { speaker: 'kotarou' })
    S.stage = 1
    unlock()
  }

  const seqCoffeeTrip = async () => {
    lockForScene(false)
    await ui.fade(1, 1.4)
    await ui.say('downToTown')
    await ui.say('makingCoffee')
    await ui.say('coffeeBackToHill')
    items.setThermos(true)
    items.setFull(false)
    items.setPose('hold')
    S.stage = 2
    player.setSitting(true)
    ui.setTag('threeCups')
    await ui.fade(0, 1.6)
    unlock()
    ui.card('threeCups', null, 2.2).catch(reportStoryError)
  }

  // ———————————————————— 第一杯 ————————————————————
  const seqCup1 = async () => {
    lockForScene(true)
    faceKagari(1.0, -0.15).catch(reportStoryError)
    ps.leanTarget = 0.3
    audio.pour()
    items.setFull(true)
    items.setPose('offer')
    await ui.say('stretchWithCup')
    kagari.setLook(1, 4)
    await tl.wait(1.1)
    await ui.say('silence', { speaker: 'kagari', hold: 1.2 })
    S.spikeT = 0.7
    S.alertT = 0.45
    audio.bristle()
    await ui.say('ribbonsBristle')
    kagari.setLook(0, 5)
    S.spikeT = 0
    S.alertT = 0
    await ui.say('turnsAway')
    ps.leanTarget = 0
    items.setPose('drink')
    await tl.wait(1.3)
    items.setFull(false)
    await ui.say('drinkItMyself', { speaker: 'kotarou' })
    kagari.setLook(1, 2.2)
    items.setPose('hold')
    await ui.say('sidewaysGlance')
    kagari.setLook(0, 3)
    kagari.setTracing(1)
    await timeSkip(['timelessTime', 'monthsLater'])
    kagari.setTracing(0)
    S.stage = 3
    unlock()
  }

  // ———————————————————— 第二杯 ————————————————————
  const seqCup2 = async () => {
    lockForScene(true)
    faceKagari(1.0, -0.15).catch(reportStoryError)
    ps.leanTarget = 0.3
    audio.pour()
    items.setFull(true)
    items.setPose('offer')
    kagari.setLook(1, 3)
    await ui.say('eyesMeet', { speaker: 'kotarou' })
    kagari.setExpression('stare')
    await ui.say('studiesCup')
    const lapse = tl.tween(
      3.6,
      (_k, raw) => sky.setLapse(Math.sin(raw * Math.PI) ** 2 * 0.8),
      linear,
    )
    await ui.say('fourDaysPass', { hold: 2.4 })
    await lapse
    sky.setLapse(0)
    kagari.setExpression('neutral')
    const side = kagari.nearerSide(camera.position)
    await handToKagari(side)
    await ui.say('takesCup')
    await ui.fade(1, 0.5)
    await ui.say('triesMuddyCoffee')
    items.setFull(false)
    await ui.fade(0, 0.7)
    await ui.say('emptyCupBack')
    await handToPlayer(side)
    await ui.say('pourAnother')
    audio.flick()
    items.jolt()
    ps.shake = 0.6
    S.spikeT = 0.5
    await ui.say('ribbonFlicksThermos')
    S.spikeT = 0
    await ui.say('disdainfulGlance')
    await ui.say('sheCommunicated', { speaker: 'kotarou' })
    kagari.setLook(0, 3)
    kagari.setTracing(1)
    ps.leanTarget = 0
    await timeSkip(['moreTimelessTime', 'centuriesDontMatter'])
    S.stage = 4
    unlock()
  }

  // ———————————————————— 第三杯 ————————————————————
  const seqCup3 = async () => {
    lockForScene(true)
    const side = S.reachSide || kagari.nearerSide(camera.position)
    faceKagari(1.0, -0.15).catch(reportStoryError)
    ps.leanTarget = 0.3
    await ui.say('readyInAMoment', { speaker: 'kotarou', hold: 1.0 })
    audio.pour()
    items.setFull(true)
    items.setPose('offer')
    await ui.say('handsTremble')
    await handToKagari(side)
    await ui.fade(1, 0.5)
    await ui.say('drinksInOneGo')
    items.setFull(false)
    await ui.fade(0, 0.7)
    await handToPlayer(side)
    await ui.say('fingersBrush')
    // 她抓住主角的手，拉了过去
    v2.set(0.05, -0.22, -0.6)
    camera.localToWorld(v2)
    kagari.setReach(side, 1, v2)
    await tl.wait(0.5)
    await ui.say('shePullsMyHand')
    const x0 = ps.x
    const z0 = ps.z
    const d = Math.hypot(x0, z0) || 1
    const pull = clamp(d - 1.25, 0.25, 0.85)
    ps.shake = 0.7
    await tl.tween(0.9, (k) => {
      ps.x = x0 - (x0 / d) * pull * k
      ps.z = z0 - (z0 / d) * pull * k
    })
    S.stage = 5 // 进入阶段 5，允许玩家踏上纸面
    await ui.say('crossesHerBorder')
    await ui.say('bracesForDeath', { hold: 1.5 })
    await tl.wait(1.2)
    paper.ripple()
    audio.open()
    await ui.say('noAttack', { hold: 2.0 })
    kagari.setReach(side, 0)
    await ui.say('mayIComeIn', { speaker: 'kotarou' })
    await ui.say('silence', { speaker: 'kagari', hold: 1.2 })
    await ui.say('lastWallFalls')
    await ui.say('invitedIntoBlueKingdom')
    await ui.say('transparentThread')
    await ui.say('warmTear')
    v2.set(0.02, -0.1, -0.42)
    camera.localToWorld(v2)
    kagari.setReach(side, 1, v2)
    await ui.say('tearInMoonlight')
    kagari.setReach(side, 0)
    await tl.wait(0.9)
    kagari.setExpression('smile')
    audio.chime()
    await tl.wait(1.6)
    await ui.say('girlSmiles', { hold: 2.8 })
    await ui.say('quietSmile')
    await ui.say('iCanUnderstandYou', { speaker: 'kotarou', hold: 2.8 })
    unlock()
    S.glanceHold = 6
    S.glanceTimer = 8
    ui.setTag('moonwalkEpilogue')
    ui.card('moonwalk', 'endingCard', 4.2).catch(reportStoryError)
    await tl.wait(7)
    ui.narrate(['stayByHerSide', 'occasionalGlances'])
  }

  // ———————————————————— 之后：一起喝咖啡 ————————————————————
  const seqShare = async () => {
    lockForScene(false)
    const side = kagari.nearerSide(camera.position)
    faceKagari(0.9, -0.1).catch(reportStoryError)
    audio.pour()
    items.setFull(true)
    items.setPose('offer')
    kagari.setLook(1, 3)
    await tl.wait(0.9)
    await handToKagari(side)
    await ui.fade(1, 0.5)
    await ui.say('shareWarmCoffee')
    items.setFull(false)
    await ui.fade(0, 0.7)
    await handToPlayer(side)
    kagari.setLook(0, 2)
    S.shareCooldown = 25
    unlock()
  }

  // ———————————————————— 逐帧逻辑 ————————————————————
  const update = (dt: number, time: number) => {
    playerLocal.copy(camera.position)
    kagari.group.worldToLocal(playerLocal)

    if (S.cupFollow) {
      kagari.palmWorld(S.cupFollow, items.worldCup.position)
    }

    if (S.mode === 'play' && !S.isBusy) {
      const dK = Math.hypot(ps.x, ps.z)
      const isOnPaperHere = isOnPaper(ps.x, ps.z)
      const dPaper = distanceToPaper(ps.x, ps.z)
      const canSee = kagari.state.canSee
      // 纸边按到纸张外缘的距离算，四条边一视同仁。纸是 7×6 米的斜放矩形，篝偏离中心，她到四边的距离在 2.2 至 4 米之间。
      const isAtEdge = !isOnPaperHere && dPaper < 0.9 && canSee
      let prompt: StoryMessageKey | null = null
      let handler: (() => Promise<void>) | null = null
      S.shareCooldown = Math.max(0, S.shareCooldown - dt)
      S.boundaryCooldown = Math.max(0, S.boundaryCooldown - dt)

      if (S.stage === 0) {
        if (dK < 29 && once('hill')) {
          ui.narrate(['hillOfDaisies'])
        }
        if (dK < 17.5 && once('see')) {
          ui.clearNarration()
          ui.narrate(['girlOnTheHill', 'enormousSheet', 'girlOverPaper'])
        }
        // 缎带：靠近时浮起（带迟滞）
        if (!S.isAlertOn && dK < 11) {
          S.isAlertOn = true
          audio.ribbonRise()
          if (once('ribbon')) {
            ui.narrate(['ribbonsRise', 'ominousRibbons'])
          }
        } else if (S.isAlertOn && dK > 13.5) {
          S.isAlertOn = false
        }
        const base = S.deaths === 0 ? 1 : 0.7
        S.alertT = S.isAlertOn ? base : 0
        audio.setTension(S.isAlertOn ? (S.deaths === 0 ? 0.6 : 0.25) : 0)
        // 先起缎带（11 米），再走近到 7 米她才抬头看过来；两段隔开几米，缎带完全浮起后才对上视线。
        kagari.setLook(dK < 7 ? 1 : 0, 3)

        if (S.deaths === 0) {
          // 主角踩上纸面时斩击。靠近篝的一侧纸边离她只有 2.2 米，主角可以站在纸边近距离看她。
          if (dK < 6.4 && once('glyph')) {
            seqGlyph().catch(reportStoryError)
          } else if (isOnPaperHere) {
            die().catch(reportStoryError)
          }
          if (S.once.has('glyph') && !S.isBusy) {
            S.spikeT = dK < 8 ? 1 : 0
          }
        } else {
          S.spikeT = dPaper < 0.5 ? 0.8 : 0
          if (isOnPaperHere) {
            die().catch(reportStoryError)
          } else if (isAtEdge && ps.speed < 0.4) {
            S.edgeTimer += dt
            if (S.edgeTimer > 1.4) {
              seqWatch().catch(reportStoryError)
            }
          } else {
            S.edgeTimer = 0
          }
        }
      } else if (S.stage < 5) {
        // 阶段 1–4 允许停留在纸边，踩上纸面仍会触发死亡
        const isNear = dK < 7
        S.alertT = isNear ? STAGE_ALERT[S.stage] : 0
        S.spikeT = dPaper < 0.35 ? 0.7 : 0
        audio.setTension(dPaper < 0.35 ? 0.3 : 0)
        if (isOnPaperHere) {
          die().catch(reportStoryError)
        } else {
          // 偶尔瞥一眼
          if (S.stage < 4) {
            S.glanceTimer -= dt
            if (S.glanceTimer <= 0) {
              S.glanceHold = 1.6
              S.glanceTimer = 9 + Math.random() * 7
            }
            S.glanceHold = Math.max(0, S.glanceHold - dt)
            kagari.setLook(S.glanceHold > 0 && dK < 6 ? 1 : 0, 3)
          }
          if (isAtEdge) {
            if (S.stage === 1) {
              prompt = 'brewCoffee'
              handler = seqCoffeeTrip
            } else if (S.stage === 2) {
              prompt = 'offerCoffee'
              handler = seqCup1
            } else if (S.stage === 3) {
              prompt = 'offerAnotherCup'
              handler = seqCup2
            } else if (S.stage === 4) {
              prompt = 'pourCoffee'
              handler = seqCup3
            }
          }
          if (S.stage === 4) {
            // 她自己伸出了手
            if (isAtEdge) {
              const side = kagari.nearerSide(camera.position)
              v3.set(0.0, -0.42, -0.62)
              camera.localToWorld(v3)
              kagari.setReach(side, 1, v3)
              S.reachSide = side
              kagari.setLook(1, 2.5)
              if (once('reach')) {
                ui.narrate(['glowingHand', 'outstretchedPalm'])
              }
            } else if (S.reachSide) {
              kagari.setReach(S.reachSide, 0)
              S.reachSide = null
              kagari.setLook(0, 2.5)
            }
          }
        }
      } else {
        // —— 阶段 5：自由活动 ——
        S.alertT = 0
        S.spikeT = 0
        audio.setTension(0)
        // 主角注视她一会儿，她会抬头回望
        kagari.headWorld(v1)
        v2.subVectors(v1, camera.position)
        const dist = v2.length()
        v2.normalize()
        camera.getWorldDirection(v3)
        const isGazing = dist < 4.2 && v2.dot(v3) > 0.93 && canSee
        S.gazeTimer = isGazing ? S.gazeTimer + dt : Math.max(0, S.gazeTimer - dt * 2)
        if (S.gazeTimer > 1.6 && S.glanceHold <= 0 && S.glanceTimer <= 0) {
          S.glanceHold = 4.5
          S.glanceTimer = 11
          S.gazeTimer = 0
        }
        S.glanceTimer = Math.max(0, S.glanceTimer - dt)
        if (S.glanceHold > 0) {
          S.glanceHold -= dt
          kagari.setLook(1, 2.6)
          kagari.setExpression('stare')
        } else {
          kagari.setLook(0, 2.2)
          if (kagari.state.look < 0.08) {
            kagari.setExpression('neutral')
          }
        }
        kagari.setTracing(1)
        if (dK < 2.7 && canSee && S.shareCooldown <= 0) {
          prompt = 'shareCoffee'
          handler = seqShare
        }
        if (ps.isSitting && dK < 3 && once('sitBeside')) {
          ui.narrate(['sitBesideHer'])
        }
      }
      ui.setPrompt(prompt, handler)
    }

    ribbons.update(dt, time, {
      alert: S.alertT,
      spike: S.spikeT,
      strike: S.strike,
      playerLocal,
    })
  }

  return {
    state: S,
    begin,
    update,
    onBoundary() {
      if (S.mode !== 'play' || S.isBusy || S.boundaryCooldown > 0) {
        return
      }
      S.boundaryCooldown = 18
      ui.narrate(['beyondTonight'])
    },
    /**
     * 处理玩家摔死：播放倒地演出和独白，之后送回出生点。

     */
    onFall() {
      mishapDeath('fall').catch(reportStoryError)
    },
    /**
     * 处理玩家撞树而死：播放倒地演出和独白，之后送回出生点。

     */
    onTreeCrash() {
      mishapDeath('tree').catch(reportStoryError)
    },
    /**
     * 掷骰决定这次撞树或会摔死的落地是否穿模。同一种死法死过或穿模过之后，没有其他场景进行时，按 CLIP_CHANCE 的概率返回 true。
     */
    shouldClipThrough(kind: ClipKind) {
      if (S.mode !== 'play' || S.isBusy) {
        return false
      }
      if (mishapCounts[kind] + clipCounts[kind] === 0) {
        return false
      }
      return Math.random() < CLIP_CHANCE
    },
    /**
     * 处理玩家穿模掉出世界：边往下掉边播放独白，之后送回出生点。

     */
    onClip(kind: ClipKind) {
      clipOutOfWorld(kind).catch(reportStoryError)
    },
  }
}
