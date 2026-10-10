#!/usr/bin/env node
// 字幕プレイヤーの再生まわり（1行ずつ・前/次/もう一度・続きから・前回位置）を、偽の <video> の上で
// ページのスクリプトをそのまま動かして確かめる。
//
// 実ブラウザの動画はシークや再生にかかる時間が揺れ、ヘッドレスでは再生が進まなくなることもあるので、ここでは時刻を自分で進める。
// 偽の <video> は、イベントの届き方を Chromium と WebKit（iPhone）の HTMLMediaElement に合わせてある:
//   - currentTime への代入で seeking が true になり、seeking の間の currentTime は最後に代入した時刻を返す
//   - Chromium は代入の時点で seeking を積む。WebKit はシークの処理を 1 つの作業として積み、それが走った時に seeking を積む
//     （まだ走っていない処理は次の代入で取り消すので、間を置かずに 2 回代入すると seeking は 1 回だけ届く）
//   - シークが重なると、最後のシークだけが完了して seeked が届く
//   - 見終わった動画の play() は 0 秒へシークする（seeking は play より先に届く）
//   - 動画の差し替え（load）は積まれたイベントを捨て、シークなしで 0 秒に戻る。戻した時の timeupdate は、
//     Chromium は位置が変わらなくても積み、WebKit は変わった時だけ積む
// 字幕は合成した行（"line 1" など）で、実データは使わない。
//
// 使い方: node test/playback-sim.mjs [--fuzz 手数] [--seed 数] [--trace] [index.html のパス ...]
//   パスを省くとこのリポジトリの index.html。直す前の版と比べる時は git show <commit>:index.html を書き出して渡す
//   --fuzz はランダムな操作列で不変条件を見る（--trace で最初の違反までの操作を出す）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const FRAME = 16;    // 画面の書き換えの間隔（ms）。requestAnimationFrame はこの間隔で呼ぶ
const SEEK_MS = 40;  // シークにかかる時間（ms）
const LOAD_MS = 30;  // 動画を選んでから loadedmetadata が届くまで（ms）
const TU_MS = 250;   // 再生中の timeupdate の間隔（ms）
const PAD = 0.25;    // ページと同じ値（止める位置の計算に使う）

// ---------------- 字幕（合成） ----------------
function makeData({ n = 30, first = 1, len = 2, gaps = [0] } = {}) {
  const cues = [];
  let s = first;
  for (let k = 0; k < n; k++) {
    cues.push({ s: +s.toFixed(3), e: +(s + len).toFixed(3), t: 'line ' + (k + 1), ja: '行 ' + (k + 1) });
    s += len + gaps[k % gaps.length];
  }
  const duration = +(cues[n - 1].e + 5).toFixed(3);
  return { format: 'study-player/1', id: 'sim', title: 'sim', video: 'sim.mp4', duration, lang: 'en', cues };
}
function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function endPoint(cues, k) { const c = cues[k], n = cues[k + 1]; return n ? Math.max(c.e, Math.min(c.e + PAD, n.s)) : c.e + PAD; }
// 時刻 t から決まる「次に止める行」（ページの seeking の処理と同じ式）
function stopFor(cues, t) { const c = cueAt(cues, t); return c < 0 ? 0 : (t < endPoint(cues, c) ? c : c + 1); }

// ---------------- 偽の DOM（ページが使う分だけ） ----------------
class Ev {
  constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.target = null; this.currentTarget = null; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}
class Nd {
  constructor(sim) { this.sim = sim; this.parentNode = null; this.childNodes = []; this.listeners = {}; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new Tx(this.sim, c) : c); }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { const a = this.listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    ev.currentTarget = this;
    for (const f of [...(this.listeners[ev.type] || [])]) f.call(this, ev);
    const h = this['on' + ev.type];
    if (typeof h === 'function') h.call(this, ev);
    if (ev.bubbles && this.parentNode) this.parentNode.dispatchEvent(ev);
    return !ev.defaultPrevented;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(s) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (s !== '' && s != null) this.appendChild(new Tx(this.sim, String(s)));
  }
}
class Tx extends Nd {
  constructor(sim, s) { super(sim); this.nodeName = '#text'; this.data = s; }
  get textContent() { return this.data; }
  set textContent(s) { this.data = String(s); }
}
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
function matchOne(el, sel) {
  const m = sel.match(/^([a-zA-Z0-9]*)((?:[.#][\w-]+)*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.' && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === '#' && el.id !== part.slice(1)) return false;
  }
  return true;
}
class El extends Nd {
  constructor(sim, tag) {
    super(sim);
    this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
    this.classList = new ClassList(); this.attrs = {}; this.style = {}; this.dataset = {};
    this.hidden = false; this.id = ''; this.disabled = false; this.value = '';
    if (this.tagName === 'TRACK') this.track = { mode: 'disabled' };
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(s) { this.classList = new ClassList(); for (const c of String(s).split(/\s+/)) if (c) this.classList.add(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  matches(sel) { return sel.split(',').some((s) => matchOne(this, s.trim())); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { top: 0, bottom: 40, left: 0, right: 375, width: 375, height: 40 }; }
  click() { if (!this.disabled) this.dispatchEvent(new Ev('click', { bubbles: true })); }
  focus() {} blur() {} select() {} scrollIntoView() {}
}

// ---------------- 偽の <video> ----------------
const EMPTY = 0, IDLE = 1, LOADING = 2, NO_SOURCE = 3;
class Video extends El {
  constructor(sim) {
    super(sim, 'video');
    this._paused = true; this._seeking = false; this._pos = 0; this._lastSeek = 0; this._duration = NaN; this._stalled = false;
    this.readyState = 0; this.networkState = EMPTY; this._src = ''; this._srcObject = null;
    this._seekGen = 0; this._seekTask = null; this._seekNow = 0; this._tuGen = 0; this._events = new Set(); this._loadTask = null;
    this.playbackRate = 1; this.defaultPlaybackRate = 1; this.textTracks = []; this.loop = false;
  }
  get paused() { return this._paused; }
  get seeking() { return this._seeking; }
  get duration() { return this._duration; }
  get ended() { return this.readyState >= 1 && !this.loop && this.currentTime >= this._duration; }
  get currentTime() { return this._seeking ? this._lastSeek : this._pos; }
  set currentTime(t) { this._seek(+t, true); }
  get currentSrc() { return this._srcObject ? 'blob:sim' : this._src; }
  get srcObject() { return this._srcObject; }
  set srcObject(o) { this._srcObject = o; this._load(); }
  get src() { return this._src; }
  set src(u) { this._src = String(u); this._load(); }
  removeAttribute(k) { if (k === 'src') this._src = ''; super.removeAttribute(k); }
  load() { this._load(); }
  play() {
    if (this.ended) this._seek(0, false);
    if (this._paused) {
      this._paused = false;
      this._fire('play');
      this._startTimeupdates();
      if (this.readyState >= 3) this._fire('playing');
    }
    return Promise.resolve();
  }
  pause() {
    if (this._paused) return;
    if (this._seeking && this.sim.inFrame) this.sim.pausedWhileSeeking.push(this.sim.now); // 画面の書き換え（tick）がシーク中に止めた
    this._paused = true; this._tuGen++;
    this._fire('timeupdate'); this._fire('pause');
  }
  // 試験用: 再生できなくなった（error が届き、位置はそこで止まる）
  failDecode() { this._stalled = true; this._fire('error'); }

  // メディアのイベントを積む（load で捨てられるように覚えておく）
  _fire(type) {
    const task = this.sim.post(() => { this._events.delete(task); this.dispatchEvent(new Ev(type)); });
    this._events.add(task);
  }
  _seek(t, fromDOM) {
    if (this.readyState === 0) return; // 読み込み前の代入はシークにならない（ページは読み込んでからしか飛ばさない）
    if (this.sim.engine === 'chromium') {
      t = Math.max(0, Math.min(t, this._duration));
      this._seeking = true; this._lastSeek = t;
      this._fire('seeking');
      this._startSeek(t);
      return;
    }
    // WebKit の seekWithTolerance: 走っていないシークの処理は取り消し、seeking はその処理が走った時に積む
    let now = this.currentTime;
    if (this._seekTask) { this._seekTask.dead = true; this._seekTask = null; now = this._seekNow; }
    this._seeking = true;
    this._lastSeek = Math.min(t, this._duration);
    this._seekNow = now;
    const seekTask = () => {
      this._seekTask = null;
      const time = Math.max(0, Math.min(t, this._duration));
      if (time === now) { // 今の位置へのシークは、イベントだけ積んで終わる
        this._fire('seeking'); this._fire('timeupdate'); this._fire('seeked');
        this._seeking = false;
        return;
      }
      this._lastSeek = time; this._seeking = true;
      this._fire('seeking');
      this._startSeek(time);
    };
    if (fromDOM) this._seekTask = this.sim.post(seekTask); else seekTask();
  }
  _startSeek(time) {
    const gen = ++this._seekGen; // 前のシークの完了は捨てる（最後のシークだけが完了する）
    this.sim.post(() => {
      if (gen !== this._seekGen) return;
      this._pos = time; this._seeking = false;
      this._fire('timeupdate'); this._fire('seeked');
    }, SEEK_MS);
  }
  _startTimeupdates() {
    const gen = ++this._tuGen;
    const loop = () => {
      if (gen !== this._tuGen || this._paused) return;
      if (!this._seeking) this._fire('timeupdate');
      this.sim.post(loop, TU_MS);
    };
    this.sim.post(loop, TU_MS);
  }
  _load() {
    const prev = this.currentTime;
    if (this._loadTask) { this._loadTask.dead = true; this._loadTask = null; }
    if (this._seekTask) { this._seekTask.dead = true; this._seekTask = null; }
    this._seekGen++; this._stalled = false;
    for (const t of this._events) t.dead = true; // 積まれたメディアのイベントを捨てる
    this._events.clear();
    if (this.networkState === LOADING || this.networkState === IDLE) this._fire('abort');
    if (this.networkState !== EMPTY) {
      this._fire('emptied');
      this.networkState = EMPTY; this.readyState = 0;
      if (!this._paused) { this._paused = true; this._tuGen++; }
      this._seeking = false; this._pos = 0; this._lastSeek = 0;
      if (this.sim.engine === 'chromium' || prev > 0) this._fire('timeupdate');
      this._duration = NaN;
    }
    this.playbackRate = this.defaultPlaybackRate;
    this.networkState = NO_SOURCE;
    const src = this._srcObject || this._src;
    this._loadTask = this.sim.post(() => {
      this._loadTask = null;
      if (!src) { this.networkState = EMPTY; return; }
      this.networkState = LOADING;
      this._loadTask = this.sim.post(() => {
        this._loadTask = null;
        this._duration = this.sim.mediaDuration; this.networkState = IDLE; this.readyState = 4;
        this._fire('durationchange'); this._fire('loadedmetadata'); this._fire('loadeddata'); this._fire('canplay');
      }, LOAD_MS);
    });
  }
  // 時刻が dt ミリ秒進んだ
  advance(dt) {
    if (this._paused || this._seeking || this._stalled || this.readyState < 3) return;
    this._pos = Math.min(this._duration, this._pos + (dt / 1000) * this.playbackRate);
    if (this._pos >= this._duration) {
      this._paused = true; this._tuGen++;
      this._fire('timeupdate'); this._fire('pause'); this._fire('ended');
    }
  }
}

// ---------------- 時刻を自分で進める環境 ----------------
function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('script が見つからない: ' + file);
  // 試験用に、中の状態を読む口を IIFE の最後に足す（ファイルは変えない）
  const i = m[1].lastIndexOf('})();');
  const script = m[1].slice(0, i) + 'globalThis.__sp = () => ({ cur, holdUntil, stopIdx, stoppedAt, step, hasVideo });\n' + m[1].slice(i);
  return { html, script };
}

class Sim {
  constructor(page, { engine, storage, duration }) {
    this.engine = engine; this.mediaDuration = duration;
    this.now = 0; this.seq = 0; this.tasks = []; this.rafs = new Map(); this.rafSeq = 0; this.nextFrame = FRAME;
    this.errors = []; this.afterFrame = null; this.inFrame = false; this.pausedWhileSeeking = [];
    this.store = new Map();
    for (const [k, v] of Object.entries(storage)) this.store.set('sp:' + k, JSON.stringify(v));
    this.byId = new Map();
    this.doc = this.makeDocument(page.html);
    this.video = this.byId.get('v');
    this.win = this.makeWindow();
    vm.createContext(this.win);
    vm.runInContext(page.script, this.win, { filename: 'index.html' });
  }
  makeDocument(html) {
    const doc = new El(this, '#document');
    doc.body = new El(this, 'body');
    doc.documentElement = new El(this, 'html');
    doc.visibilityState = 'visible'; doc.hidden = false; doc.fullscreenElement = null;
    const body = html.slice(html.indexOf('<body'));
    for (const m of body.matchAll(/<([a-zA-Z0-9]+)\b[^>]*?\bid="([^"]+)"[^>]*>/g)) {
      const el = m[1].toLowerCase() === 'video' ? new Video(this) : new El(this, m[1]);
      el.id = m[2];
      if (/\shidden[\s>]/.test(m[0])) el.hidden = true;
      this.byId.set(m[2], el);
      doc.body.appendChild(el);
    }
    doc.getElementById = (id) => this.byId.get(id) || null;
    doc.createElement = (tag) => (tag.toLowerCase() === 'video' ? new Video(this) : new El(this, tag));
    doc.createTextNode = (s) => new Tx(this, String(s));
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    return doc;
  }
  makeWindow() {
    const sim = this;
    const localStorage = {
      getItem: (k) => (sim.store.has(k) ? sim.store.get(k) : null),
      setItem: (k, v) => { sim.store.set(k, String(v)); },
      removeItem: (k) => { sim.store.delete(k); },
    };
    const win = {
      document: this.doc, localStorage, navigator: { standalone: true },
      matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
      innerHeight: 812, innerWidth: 375, scrollY: 0, scrollX: 0,
      scrollTo(a, b) { win.scrollY = typeof a === 'object' ? (a.top ?? win.scrollY) : b; },
      addEventListener() {}, removeEventListener() {},
      confirm: () => true, alert() {},
      requestAnimationFrame: (cb) => { const id = ++sim.rafSeq; sim.rafs.set(id, cb); return id; },
      cancelAnimationFrame: (id) => { sim.rafs.delete(id); },
      setTimeout: (fn, ms) => sim.post(fn, ms || 0).id,
      clearTimeout: (id) => { const t = sim.tasks.find((x) => x.id === id); if (t) t.dead = true; },
      URL: { createObjectURL: () => 'blob:sim/' + (++sim.seq), revokeObjectURL() {} },
      Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
      Node: Nd, console, isSecureContext: true,
    };
    win.window = win; win.self = win;
    return win;
  }
  post(fn, delay = 0) { const t = { at: this.now + delay, seq: ++this.seq, id: this.seq, fn, dead: false }; this.tasks.push(t); return t; }
  nextTask() {
    let best = null;
    for (const t of this.tasks) if (!t.dead && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) best = t;
    return best;
  }
  guard(fn) { try { fn(); } catch (e) { this.errors.push(e); } }
  runTask(t) { this.tasks.splice(this.tasks.indexOf(t), 1); this.guard(t.fn); }
  advanceTo(t) { if (t > this.now) { this.video.advance(t - this.now); this.now = t; } }
  // ms ミリ秒進める（積まれた作業と画面の書き換えを時刻順に行う）
  run(ms) {
    const end = this.now + ms;
    for (;;) {
      this.tasks = this.tasks.filter((x) => !x.dead);
      const t = this.nextTask();
      const at = Math.min(t ? t.at : Infinity, this.nextFrame);
      if (at > end) { this.advanceTo(end); return; }
      this.advanceTo(at);
      if (t && t.at <= this.nextFrame) { this.runTask(t); continue; }
      this.nextFrame += FRAME;
      this.frame();
    }
  }
  // 画面の書き換え（requestAnimationFrame の呼び出し）。同じ時刻の作業より先に割り込ませる時は直接呼ぶ
  frame() {
    const cbs = [...this.rafs.values()];
    this.rafs.clear();
    this.inFrame = true;
    for (const cb of cbs) this.guard(() => cb(this.now));
    this.inFrame = false;
    if (this.afterFrame) this.afterFrame();
  }
  // 今やることになっている作業を全部行う（時刻は進めない）
  settle() { this.steps(1000); }
  // 時刻を進めずに、今やることになっている作業を n 個だけ行う
  steps(n) {
    for (let i = 0; i < n; i++) {
      this.tasks = this.tasks.filter((x) => !x.dead);
      const t = this.nextTask();
      if (!t || t.at > this.now) return;
      this.runTask(t);
    }
  }
}

// 指で触る操作
class Page {
  constructor(sim) { this.sim = sim; this.v = sim.video; }
  el(id) { return this.sim.byId.get(id); }
  cues() { return this.el('list').children.filter((c) => c.classList.contains('cue')); }
  cur() { return this.cues().findIndex((c) => c.classList.contains('cur')); }
  open() { this.el('lib').querySelector('.open').click(); }
  pick() { const inp = this.el('pickVideo'); inp.files = [{ name: 'sim.mp4', size: 1 }]; inp.dispatchEvent(new Ev('change')); }
  line(k) { this.cues()[k].click(); }
  press(id) { this.el(id).click(); }
  resumeButton() { return this.el('info').hidden ? null : this.el('info').querySelector('button'); }
  saved() { const x = this.sim.store.get('sp:t:sim'); return x == null ? null : JSON.parse(x); }
  libSaved() { const lib = JSON.parse(this.sim.store.get('sp:lib') || '[]'); const it = lib.find((x) => x.id === 'sim'); return it ? it.t : undefined; }
  setVisible(on) { const d = this.sim.doc; d.visibilityState = on ? 'visible' : 'hidden'; d.hidden = !on; d.dispatchEvent(new Ev('visibilitychange')); }
  // 巻き戻し中（行の頭の少し手前）で止まった状態を作る: 次の seeked で止める
  pauseAtNextSeeked() { const v = this.v; const h = () => { v.removeEventListener('seeked', h); v.pause(); }; v.addEventListener('seeked', h); }
  state() { return this.sim.win.__sp(); }
  ready() { this.open(); this.pick(); this.sim.run(200); return this; }
}

function expectStop(p, d, k) {
  const t = p.v.currentTime, e = endPoint(d.cues, k);
  const ok = p.v.paused && p.cur() === k && t >= e - 1e-6 && t < e + 0.1;
  return { ok, detail: `止まった=${p.v.paused} 色=${p.cur()} 時刻=${t.toFixed(3)}（期待: 行 ${k} の終わり ${e.toFixed(3)} で止まり、色も ${k}）` };
}
const all = (...rs) => ({ ok: rs.every((r) => r.ok), detail: rs.map((r, i) => `${i + 1}) ${r.ok ? 'OK' : 'NG'} ${r.detail}`).join(' / ') });
const savedLine = (p, d, k, label) => {
  const s = p.saved();
  return { ok: s != null && cueAt(d.cues, s) === k, detail: `${label}: 保存 ${s == null ? 'なし' : s.toFixed(3)} は行 ${s == null ? '-' : cueAt(d.cues, s)}（期待 ${k}）` };
};

// ---------------- 場面 ----------------
const scenarios = [
  {
    name: '行の頭へ飛んだ直後に止めて「1行ずつ」をオン → その行の終わりで止まる',
    run(p, d) {
      p.ready();
      p.pauseAtNextSeeked(); p.line(5); p.sim.run(SEEK_MS + 50);
      p.press('step'); p.v.play(); p.sim.run(4000);
      return expectStop(p, d, 5);
    },
  },
  {
    name: '行の頭へ飛んだ直後（再生中）に「1行ずつ」をオン → その行の終わりで止まる',
    run(p, d) {
      p.ready();
      p.line(5); p.sim.run(SEEK_MS + 60);
      p.press('step'); p.sim.run(4000);
      return expectStop(p, d, 5);
    },
  },
  {
    name: '同上（行の間に 1 秒の隙間がある字幕）',
    data: { gaps: [1] },
    run(p, d) {
      p.ready();
      p.line(5); p.sim.run(SEEK_MS + 60);
      p.press('step'); p.sim.run(4000);
      return expectStop(p, d, 5);
    },
  },
  {
    name: '行の頭へ飛んだ直後に「一覧」→ 開き直して「続きから」でその行から',
    run(p, d) {
      p.ready();
      p.line(7); p.sim.run(SEEK_MS + 60);
      p.press('back'); p.sim.run(50);
      const r1 = savedLine(p, d, 7, '一覧へ戻った時');
      p.ready();
      const b = p.resumeButton();
      if (!b) return { ok: false, detail: r1.detail + ' / 「続きから」が出ない' };
      b.click(); p.sim.run(SEEK_MS + 400);
      return all(r1, { ok: p.cur() === 7, detail: `続きからの行 ${p.cur()}（期待 7）` });
    },
  },
  {
    name: '行の頭へ飛んだ直後に一時停止 → 前回位置はその行',
    run(p, d) {
      p.ready();
      p.pauseAtNextSeeked(); p.line(7); p.sim.run(SEEK_MS + 50);
      return savedLine(p, d, 7, '一時停止');
    },
  },
  {
    name: '行の頭へ飛んだ直後にアプリを離れる → 前回位置はその行',
    run(p, d) {
      p.ready();
      p.line(7); p.sim.run(SEEK_MS + 60);
      p.setVisible(false);
      return savedLine(p, d, 7, '画面が隠れた時');
    },
  },
  {
    name: '遠くの行へ飛んだ直後の timeupdate → 前回位置はその行',
    run(p, d) {
      p.ready();
      p.line(1); p.sim.run(1500);
      p.line(12); p.sim.run(SEEK_MS + 30);
      return savedLine(p, d, 12, '飛んだ直後');
    },
  },
  {
    name: '「次」を素早く 2 度（間にイベントが届かない）→ 2 つ先の行',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(3); p.sim.run(1000);
      p.press('next'); p.press('next');
      p.sim.run(SEEK_MS + 300);
      const r1 = { ok: p.cur() === 5, detail: `直後の色 ${p.cur()}（期待 5）` };
      p.sim.run(3000);
      return all(r1, expectStop(p, d, 5));
    },
  },
  {
    name: '「次」を素早く 2 度（1 回目の seeking が積まれた後に 2 回目）→ 2 つ先の行',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(3); p.sim.run(1000);
      p.press('next'); p.sim.steps(1); p.press('next');
      p.sim.run(SEEK_MS + 300);
      const r1 = { ok: p.cur() === 5, detail: `直後の色 ${p.cur()}（期待 5）` };
      p.sim.run(3000);
      return all(r1, expectStop(p, d, 5));
    },
  },
  {
    name: '「次」を 2 度（1 回目が飛び終えて seeked が届く前に 2 回目）→ 2 つ先の行',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(3); p.sim.run(1000);
      p.press('next'); p.sim.run(SEEK_MS + 1); p.press('next');
      p.sim.run(SEEK_MS + 300);
      const r1 = { ok: p.cur() === 5, detail: `直後の色 ${p.cur()}（期待 5）` };
      p.sim.run(3000);
      return all(r1, expectStop(p, d, 5));
    },
  },
  {
    name: '「1行ずつ」で止まった後に「もう一度」を 2 度（1 回目のシークの処理が走った後に 2 回目）→ その行だけで止まる',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(4); p.sim.run(3000);
      const r1 = expectStop(p, d, 4);
      p.press('again'); p.sim.steps(1); p.press('again');
      p.sim.run(3000);
      return all(r1, expectStop(p, d, 4));
    },
  },
  {
    name: '「1行ずつ」で再生中にシークバーで先へ（seeking が届く前に画面の書き換え）→ 止めずに、飛んだ先の行の終わりで止まる',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(4); p.sim.run(600);
      p.v.currentTime = d.cues[8].s + 0.5; p.sim.frame();
      const r1 = { ok: !p.v.paused, detail: `シーク直後に止まった=${p.v.paused}（期待 false）` };
      p.sim.run(3000);
      return all(r1, expectStop(p, d, 8));
    },
  },
  {
    name: '「1行ずつ」オンのまま開き、行に触らず ▶ → 最初の行の終わりで止まる',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.v.play(); p.sim.run(1000 * (endPoint(d.cues, 0) + 0.5));
      return expectStop(p, d, 0);
    },
  },
  {
    name: '「1行ずつ」で見て一覧へ戻り、開き直して ▶ → 最初の行の終わりで止まる',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(10); p.sim.run(3000);
      const r1 = expectStop(p, d, 10);
      p.press('back'); p.ready();
      p.v.play(); p.sim.run(1000 * (endPoint(d.cues, 0) + 0.5));
      return all(r1, expectStop(p, d, 0));
    },
  },
  {
    name: '再生できなくなって動画を選び直す → 最初の行で止まり、前回位置は残る',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(10); p.sim.run(3000);
      const before = p.saved();
      p.v.failDecode(); p.sim.run(50);
      p.pick(); p.sim.run(200);
      const after = p.saved(), b = p.resumeButton();
      p.v.play(); p.sim.run(1000 * (endPoint(d.cues, 0) + 0.5));
      return all({ ok: after === before && !!b, detail: `前回位置 ${before} → ${after}、「続きから」${b ? 'あり' : 'なし'}` }, expectStop(p, d, 0));
    },
  },
  {
    name: '動画を選んだだけで「一覧」→ 前回位置が消えない',
    storage: { 't:sim': 30 },
    run(p) {
      p.ready();
      const b = p.resumeButton();
      p.press('back'); p.sim.run(50);
      return { ok: !!b && p.saved() === 30 && p.libSaved() === 30, detail: `「続きから」${b ? 'あり' : 'なし'}、前回位置 ${p.saved()}、一覧の前回 ${p.libSaved()}（期待 30）` };
    },
  },
  {
    name: '動画を選んだだけでアプリを離れる → 前回位置が消えない',
    storage: { 't:sim': 30 },
    run(p) {
      p.ready();
      p.setVisible(false); p.sim.run(50); p.setVisible(true);
      return { ok: p.saved() === 30, detail: `前回位置 ${p.saved()}（期待 30）` };
    },
  },
  {
    name: '最初の行が 0 秒近く: その行から見終えて「1行ずつ」をオンにし ▶ → 最初の行で止まる',
    data: { first: 0.1, n: 8 },
    run(p, d) {
      p.ready();
      p.line(0); p.sim.run(1000 * (d.duration + 1));
      const r1 = { ok: p.v.paused && p.v.ended, detail: `見終えた=${p.v.ended}` };
      p.press('step'); p.v.play(); p.sim.run(1000 * (endPoint(d.cues, 0) + 0.5));
      return all(r1, expectStop(p, d, 0));
    },
  },
  {
    name: '「1行ずつ」: 止まった後の「次」「もう一度」「前」',
    storage: { step: true },
    run(p, d) {
      p.ready();
      p.line(3); p.sim.run(3000); const r1 = expectStop(p, d, 3);
      p.press('next'); p.sim.run(3000); const r2 = expectStop(p, d, 4);
      p.press('again'); p.sim.run(3000); const r3 = expectStop(p, d, 4);
      p.press('prev'); p.sim.run(3000); const r4 = expectStop(p, d, 3);
      return all(r1, r2, r3, r4);
    },
  },
];

function runScenario(page, engine, sc) {
  const d = makeData(sc.data);
  const storage = Object.assign({ lib: [{ id: 'sim', title: 'sim', duration: d.duration, cues: d.cues.length, t: (sc.storage || {})['t:sim'] }], 'data:sim': d }, sc.storage || {});
  const sim = new Sim(page, { engine, storage, duration: d.duration });
  const p = new Page(sim);
  let r;
  try { r = sc.run(p, d); } catch (e) { r = { ok: false, detail: '試験のエラー: ' + e.stack }; }
  if (sim.errors.length) r = { ok: false, detail: r.detail + ' / ページのエラー: ' + sim.errors.map((e) => e.message).join('; ') };
  return r;
}

// ---------------- ランダムな操作列で不変条件を見る ----------------
// 1. 巻き戻し中（holdUntil >= 0）は、止める行と色の行が一致する
// 2. 「1行ずつ」で再生中（巻き戻し中・シーク中を除く）は、止める行が時刻から決まる行と一致する（画面の書き換えの直後に見る）
// 3. 「1行ずつ」で止まっている間は、色の行と止めた行が一致する
// 4. シークの途中で「1行ずつ」の停止をしない（シーク中の currentTime は飛び先で、再生が進んだ位置ではない）
// 指の操作の間には、それまでに積まれたイベントが届く（同じ瞬間に別のボタンは押せない）。素早い 2 度押しと、
// シークバーの直後に画面の書き換えが割り込む場合だけは、イベントが届く前に次が起きるようにしてある
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function fuzz(page, engine, seed, moves) {
  const rnd = mulberry32(seed);
  const d = makeData({ n: 14, first: 0.1, len: 1.2, gaps: [0, 0, 0, 0.1, 0, 0.4, 0, 1.5] });
  const storage = { lib: [{ id: 'sim', title: 'sim', duration: d.duration, cues: d.cues.length }], 'data:sim': d };
  const sim = new Sim(page, { engine, storage, duration: d.duration });
  const p = new Page(sim);
  const bad = [], trail = [];
  let move = -1, label = '', firstTrail = null;
  const fmtState = () => {
    const s = p.state();
    return `t=${p.v.currentTime.toFixed(3)} 停止=${p.v.paused} シーク中=${p.v.seeking} 色=${s.cur} 止める行=${s.stopIdx} 止めた行=${s.stoppedAt} 待ち=${s.holdUntil} 1行ずつ=${s.step}`;
  };
  const check = (afterFrame) => {
    const s = p.state();
    if (!s.hasVideo) return;
    const before = bad.length;
    if (s.holdUntil >= 0 && s.stopIdx !== s.cur) bad.push(`#${move} 巻き戻し中: 止める行 ${s.stopIdx} / 色 ${s.cur}`);
    if (afterFrame && s.step && !p.v.paused && !p.v.seeking && s.holdUntil < 0) {
      const want = stopFor(d.cues, p.v.currentTime);
      if (s.stopIdx !== want) bad.push(`#${move} 再生中: 止める行 ${s.stopIdx} / 時刻 ${p.v.currentTime.toFixed(3)} からは ${want}`);
    }
    if (p.v.paused && s.stoppedAt >= 0 && s.cur !== s.stoppedAt) bad.push(`#${move} 停止中: 色 ${s.cur} / 止めた行 ${s.stoppedAt}`);
    if (sim.pausedWhileSeeking.length) bad.push(`#${move} シークの途中で止めた（${sim.pausedWhileSeeking.splice(0).join(', ')} ms）`);
    if (bad.length > before && !firstTrail) firstTrail = [...trail, `#${move} ${label} → ${fmtState()}`];
  };
  sim.afterFrame = () => check(true);
  p.ready();
  const n = d.cues.length;
  for (move = 0; move < moves && bad.length < 5; move++) {
    const a = rnd();
    let k = -1;
    if (a < 0.2) { k = Math.floor(rnd() * n); label = `行 ${k} をタップ`; p.line(k); }
    else if (a < 0.28) { label = '次'; p.press('next'); }
    else if (a < 0.33) { label = '前'; p.press('prev'); }
    else if (a < 0.37) { label = 'もう一度'; p.press('again'); }
    else if (a < 0.45) { label = '1行ずつ'; p.press('step'); }
    else if (a < 0.52) { label = '▶'; p.v.play(); }
    else if (a < 0.57) { label = '一時停止'; p.v.pause(); }
    else if (a < 0.6) { const x = rnd() * d.duration; label = `シークバーで ${x.toFixed(3)}`; p.v.currentTime = x; }
    else if (a < 0.63) { const x = rnd() * d.duration; label = `シークバーで ${x.toFixed(3)}（直後に画面の書き換え）`; p.v.currentTime = x; sim.frame(); }
    else if (a < 0.66) { label = '次を 2 度'; p.press('next'); p.press('next'); }
    else if (a < 0.69) { label = '次・作業 1 つ・次'; p.press('next'); sim.steps(1); p.press('next'); }
    else if (a < 0.73) { k = Math.floor(rnd() * n); label = `行 ${k} をタップ（次の seeked で止める）`; p.pauseAtNextSeeked(); p.line(k); }
    else { const ms = Math.floor(rnd() * 1200); label = `${ms}ms 待つ`; sim.run(ms); }
    check(false);
    sim.settle(); // 次の指の操作までに、積まれたイベントは届く
    check(false);
    trail.push(`#${move} ${label} → ${fmtState()}`);
    if (trail.length > 12) trail.shift();
  }
  return { bad, errors: sim.errors, trail: firstTrail };
}

// ---------------- 実行 ----------------
const args = process.argv.slice(2);
let fuzzMoves = 0, seed = 1;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fuzz') fuzzMoves = +args[++i];
  else if (args[i] === '--seed') seed = +args[++i];
  else if (args[i] !== '--trace') files.push(args[i]);
}
if (!files.length) files.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'));
let failed = 0;
for (const f of files) {
  const page = loadPage(f);
  console.log('== ' + f);
  for (const sc of scenarios) {
    for (const engine of ['chromium', 'webkit']) {
      const r = runScenario(page, engine, sc);
      if (!r.ok) failed++;
      console.log(`${r.ok ? 'OK' : 'NG'}  ${engine.padEnd(8)} ${sc.name}` + (r.ok ? '' : '\n      ' + r.detail));
    }
  }
  if (fuzzMoves) {
    for (const engine of ['chromium', 'webkit']) {
      const r = fuzz(page, engine, seed, fuzzMoves);
      const ok = !r.bad.length && !r.errors.length;
      if (!ok) failed++;
      console.log(`${ok ? 'OK' : 'NG'}  ${engine.padEnd(8)} ランダムな操作 ${fuzzMoves} 手（seed ${seed}）` +
        (ok ? '' : '\n      ' + [...r.bad, ...r.errors.map((e) => 'ページのエラー: ' + e.message)].join('\n      ')));
      if (r.trail && process.argv.includes('--trace')) console.log('      最初の違反までの操作:\n        ' + r.trail.join('\n        '));
    }
  }
}
process.exitCode = failed ? 1 : 0;
