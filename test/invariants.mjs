#!/usr/bin/env node
// 再生まわりの不変条件ハーネス。index.html の <script> を jsdom の上でそのまま動かし、<video> だけを
// Chromium の挙動（html_media_element.cc で seeking・seeked・play・load が届く順）を写した
// 偽物に差し替える。ページの内部状態（色の行・止める行など）を読む口を 1 つ差し込み、仕様側の期待（モデル）と
// 突き合わせる。playback-sim.mjs とは別の作りで同じ所を確かめるためのもので、字幕は合成した行だけ。
//
//   (cd test && npm install)                     初回だけ（jsdom を入れる）
//   node test/invariants.mjs                     作業ツリーの index.html: 症状シナリオ＋ランダム操作
//   node test/invariants.mjs --rev 138a326       git の版にかける（陰性対照。違反と症状が出るのが正しい）
//   node test/invariants.mjs --mutants           作業ツリーをわざと壊した版（MUTANTS）で、検出できるかを見る（これだけを回す）
//   主なオプション: --html <path>  --fuzz <1 seed の手数>  --seeds 1..24  --data clean,real
//                   --no-scenarios  --no-fuzz  --busy <確率>  --trace（違反までの経過を出す）  --shrink（違反を縮める）
//                   --codes INV1,INV2,INV3（この符号だけを違反に数える）  --keep-going（違反の後も回して符号ごとに数える）
//
// 見る条件（違反の符号）。INV1〜3 は、行の少し手前から再生する作りで、ページの状態どうしが常に満たすべき条件
// （どれかが崩れると、色の行が 1 つ前にずれる・「1行ずつ」が違う行で止まる・「もう一度」「次」が違う行へ行く）
//   INV1 巻き戻し中（行の少し手前から再生中）は、色の行と止める行が一致する
//   INV2 再生中の止める行は、時刻から引いた値と一致する（重なりの無い合成データだけ）
//   INV3 「1行ずつ」で止まっている間は、色の行と止めた行が一致する
//   M1   行・前・次・もう一度・続きから を押した直後、色の行が押した先になっている
//   M-ROW / M-HOLD / M-STOP  色の行・巻き戻し・止める行が、誰がシークしたかを知っているモデルの期待と一致する
//        （モデルの規則: 1行ずつの間は色を止める行より先へ進めない／止めた後は止める点を過ぎた行を飛ばす／
//          止める点を LATE 秒以上過ぎてから来た tick では止めずに時刻から引き直す（止まっている時の tick でも）／
//          止まっている間の seeked・pause でも tick する。止まっている時の tick は止めない）
//   M4   「1行ずつ」の停止は、期待の行の終わりで、シーク中ではない時にだけ起きる
//   M5   「1行ずつ」がオンで再生中に、止めるべき行の終わりを過ぎても止めない、が無い
//   M6   前回位置（続きから）の保存は、再生か移動をした後だけ、行の頭の手前の時刻ではなく行の頭で書かれる
//   M7   開き直して動画を選んだ時の「続きから」の有無と時刻が、最後に保存すべきだった値と合う
//   M8   「一覧」の確かめ（confirm）は動画を読み込んでいる時だけ 1 回出る。確かめの間は動画が止まっている。キャンセルしたら
//        一覧へ戻らず、動画も外れず、押す前に再生していれば再生に戻る（止まっていたら止まったまま）
//   M9   「続きから」の案内は、行・前・次・もう一度・続きから で見始めるまで残る（動画の ▶・一時停止・シークバー・1行ずつ・
//        アプリを離れる・確かめのキャンセル では消えない。押し違えて頭から見始めても、前回の行へ戻れるように）
//   DOM / PAGE-ERROR  色の付いた行が 2 つ以上・ページの例外
//
// ランダム操作には、確かめで迷ってからの「はい」「キャンセル」（迷っている間はページのスクリプトが止まり、動画だけが進む。
// ページは確かめの前に動画を止めるので、今の版では進まない）と、再生中に画面の書き換え（rAF）だけが止まる場合（全画面・
// ピクチャインピクチャ。その間に一時停止することもある）を入れてある。どちらも LATE の経路を踏む。止まっていた間はページが
// 止める判定をできないので、「1行ずつ」の停止の遅れ（M4・M5）は戻った時刻か再生を始めた時刻から数える。rAF が止まっている間の
// 一時停止では、色を止めた時刻の行へ合わせることを求める（M-ROW・M-HOLD。「1行ずつ」の時は、止める点を LATE 以上過ぎていれば
// 止める行も引き直した上で）
// シナリオの pending: true は判断待ち（作りを決めていない）。結果は出すが終了コードと変異の判定には数えない（違反は数える）。
// 今は該当するシナリオは無い

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let jsdom;
try { jsdom = require('jsdom'); } catch (_) {
  console.error('jsdom が入っていません。test/ で npm install を実行してください。');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = jsdom;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROLL = 0.25, PAD = 0.25;   // index.html の値（読み込み時に照合する）
const LATE = 0.5;                // index.html の値。止める点をこれ以上過ぎてから tick が来たら止めずに引き直す（無い版もある）
const FRAME = 1000 / 60;         // 画面の書き換えの間隔（ms）
const DSTOP = 0.1;               // 「1行ずつ」の停止の遅れの許容（動画の秒）
const EPS = 1e-6;
const fx = (t) => (t == null || Number.isNaN(t) ? String(t) : (Math.round(t * 1000) / 1000).toFixed(3));

// ---------------------------------------------------------------- 乱数・データ
function rng(seed) {
  let a = (seed >>> 0) || 1;
  const f = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    f,
    range: (lo, hi) => lo + (hi - lo) * f(),
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    chance: (p) => f() < p,
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    weighted(pairs) {
      let tot = 0;
      for (const [w] of pairs) tot += w;
      let x = f() * tot;
      for (const [w, v] of pairs) if (w > 0 && (x -= w) < 0) return v;
      return pairs.filter(([w]) => w > 0).pop()[1];
    },
  };
}
const subSeed = (seed, salt) => ((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0);
const r2 = (x) => Math.round(x * 100) / 100;

// clean: 重なり無し・短すぎる行無し（INV2 を字句どおりに見られる）
// real : 実データの分布に寄せる（重なり 6%・0.02 秒の行・最初の行が 0.02 秒・最後の行の終わりの直後に動画が終わる）
function genData(seed, kind) {
  const R = rng(subSeed(seed, kind === 'clean' ? 11 : 13));
  const n = R.int(18, 32), cues = [];
  let s = kind === 'real' ? 0.02 : R.pick([0, 0.02, 0.1, 0.24, 0.3, 1.5]);
  for (let i = 0; i < n; i++) {
    const tiny = kind === 'real' && R.chance(0.06);
    const dur = tiny ? R.pick([0.02, 0.05, 0.12, 0.2]) : r2(0.4 + R.f() * 3.2);
    const c = { s: r2(s), e: r2(s + dur) };
    cues.push(c);
    const u = R.f();
    let gap;
    if (kind === 'clean') {
      gap = u < 0.4 ? 0 : u < 0.55 ? r2(0.01 + R.f() * 0.22) : u < 0.62 ? PAD : u < 0.75 ? r2(0.26 + R.f() * 0.23)
        : u < 0.8 ? 2 * PAD : r2(0.6 + R.f() * 2.4);
    } else {
      gap = u < 0.07 ? -r2(0.02 + R.f() * 0.66) : u < 0.15 ? 0 : u < 0.34 ? r2(0.01 + R.f() * 0.23)
        : u < 0.67 ? r2(0.25 + R.f() * 0.25) : u < 0.9 ? r2(0.5 + R.f() * 1.5) : r2(2 + R.f() * 4);
    }
    s = Math.max(c.e + gap, c.s + 0.02);
  }
  const tail = kind === 'real' ? 0.05 : R.pick([0.05, 0.25, 0.6, 2]);
  return { kind, seed, id: 'synthetic-' + kind + '-' + seed, cues, duration: r2(cues[n - 1].e + tail) };
}
function studyJson(d) {
  return {
    format: 'study-player/1', id: d.id, title: 'Synthetic ' + d.kind + ' ' + d.seed, video: 'synthetic.mp4',
    duration: d.duration, lang: 'en',
    cues: d.cues.map((c, i) => Object.assign(
      { s: c.s, e: c.e, t: 'Synthetic line ' + (i + 1), ja: '合成の行 ' + (i + 1) },
      i % 5 === 2 ? { x: ['【合成】解説 ' + (i + 1)] } : {})),
  };
}
// 仕様側の計算（行を引く・止める時刻・時刻から引いた止める行）。ページと同じ式だが、ここではモデルの期待に使う
function spec(cues) {
  const n = cues.length;
  const cueAt = (t) => {
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };
  const endPoint = (k) => { const c = cues[k], nx = cues[k + 1]; return nx ? Math.max(c.e, Math.min(c.e + PAD, nx.s)) : c.e + PAD; };
  const stopRowAt = (t) => { const c = cueAt(t); return c < 0 ? 0 : (t < endPoint(c) ? c : c + 1); };
  // 止めた後に次に止める行: 止める点をもう過ぎた行（前の行の中に収まった短い行）は飛ばす
  const nextStop = (k, t) => { while (k < n && endPoint(k) <= t) k++; return k; };
  return { n, cues, cueAt, endPoint, stopRowAt, nextStop };
}

// ---------------------------------------------------------------- 仮想の時計とタスク
class Sched {
  constructor() { this.now = 0; this.h = []; this.seq = 0; }
  at(t, fn, label) { const task = { t: Math.max(t, this.now), seq: this.seq++, fn, label, dead: false }; this.push(task); return task; }
  cancel(task) { if (task) task.dead = true; }
  less(a, b) { return a.t < b.t || (a.t === b.t && a.seq < b.seq); }
  push(x) {
    const h = this.h; h.push(x);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; }
  }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
  peek() { while (this.h.length && this.h[0].dead) this.pop(); return this.h[0]; }
  next() { const task = this.peek(); if (!task) return null; this.pop(); this.now = task.t; task.fn(); return task; }
}

// ---------------------------------------------------------------- 偽の <video>（Chromium の写し）
// 写した挙動: Seek() のたびに seeking を積む／seeking 中の currentTime は最後のシーク先／完了は seeking=false の後に
// timeupdate・seeked を積む（次のシークは同期で seeking=true）／前のシークが終わる前の次のシークは完了が 1 回に
// まとまる／見終わった動画の play() は Seek(0) をしてから play を積む／読み込み前の currentTime への代入はシークに
// ならない／load は積まれたイベントを捨て、emptied と timeupdate を積み、paused=true・seeking=false・位置 0・
// 速度を既定に戻す／pause() は timeupdate と pause を積む／終わりに達すると timeupdate・pause・ended を積む
const EMPTY = 0, IDLE = 1, LOADING = 2, NO_SOURCE = 3;
class Media {
  constructor(ss, el) {
    this.ss = ss; this.el = el;
    this.networkState = EMPTY; this.readyState = 0;
    this.paused = true; this.seeking = false; this.halted = false;
    this.duration = NaN; this.rate = 1;
    this.pos = 0; this.base = 0;            // 公式の再生位置と、それを決めた時刻（ms）
    this.lastSeekTime = 0; this.dpsp = 0;   // dpsp: 読み込み前に代入された開始位置
    this.srcObj = null; this.file = null;
    this.seekTask = null; this.endTask = null; this.tuTask = null; this.loadTask = null;
    this.queued = new Set(); this.lastEvAt = 0; this.seekSeq = 0;
  }
  get S() { return this.ss.S; }
  advancing() { return !this.paused && !this.seeking && !this.halted && this.readyState >= 3; }
  position() {
    if (!this.advancing()) return this.pos;
    return Math.min(this.duration, this.pos + (this.S.now - this.base) / 1000 * this.rate);
  }
  rebase() { this.pos = this.position(); this.base = this.S.now; }
  get currentTime() { if (this.dpsp) return this.dpsp; return this.seeking ? this.lastSeekTime : this.position(); }
  setCurrentTime(x) { x = +x; if (this.readyState === 0) { this.dpsp = x; return; } this.seek(x, 'page'); }
  queueEvent(type, meta = {}) {
    const at = Math.max(this.S.now + this.ss.eventDelay(), this.lastEvAt + EPS);   // 同じ要素のイベントは積んだ順
    this.lastEvAt = at;
    const task = this.S.at(at, () => { this.queued.delete(task); this.ss.dispatchMedia(type, meta); }, 'ev:' + type);
    this.queued.add(task);
    return task;
  }
  reschedule() {
    this.S.cancel(this.endTask); this.S.cancel(this.tuTask); this.endTask = this.tuTask = null;
    if (!this.advancing()) return;
    const left = Math.max(0, (this.duration - this.pos) / this.rate * 1000);
    this.endTask = this.S.at(this.base + left, () => this.reachEnd(), 'media:end');
    this.tuTask = this.S.at(this.S.now + 250, () => this.periodic(), 'tu');
  }
  periodic() {
    this.tuTask = null;
    if (!this.advancing()) return;
    this.queueEvent('timeupdate');
    this.tuTask = this.S.at(this.S.now + 250, () => this.periodic(), 'tu');
  }
  reachEnd() {
    this.endTask = null;
    if (!this.advancing()) return;
    this.pos = this.duration; this.base = this.S.now;
    this.queueEvent('timeupdate');
    this.paused = true; this.queueEvent('pause', { origin: 'end' });
    this.queueEvent('ended');
    this.reschedule();
  }
  seek(t, origin) {
    if (this.readyState === 0) return;
    this.rebase();
    this.seeking = true;
    t = Math.min(Math.max(0, +t), this.duration);
    t = Math.round(t * 1e6) / 1e6;          // base::TimeDelta の精度
    this.lastSeekTime = t;
    const id = ++this.seekSeq;
    const ev = this.queueEvent('seeking', { origin, target: t, id });
    let at = this.S.now + this.ss.seekDelay();
    if (this.seekTask && !this.seekTask.dead) {   // 進行中のシークの後に回る。完了の通知は 1 回にまとまる
      at = Math.max(this.seekTask.t, this.S.now) + this.ss.seekDelay();
      this.S.cancel(this.seekTask);
    }
    this.seekTask = this.S.at(Math.max(at, ev.t + 0.05), () => this.finishSeek(), 'media:seek');
    this.reschedule();
    this.ss.onSeekIssued(origin, t, id);
  }
  finishSeek() {
    this.seekTask = null;
    if (!this.seeking) return;
    this.seeking = false;
    this.pos = this.lastSeekTime; this.base = this.S.now;
    this.queueEvent('timeupdate'); this.queueEvent('seeked');
    this.reschedule();
  }
  endedPlayback() { return this.readyState >= 1 && (this.seeking ? this.lastSeekTime : this.position()) >= this.duration; }
  play(origin) {
    if (this.endedPlayback()) this.seek(0, 'browser');
    if (this.paused) {
      this.rebase(); this.paused = false;
      this.queueEvent('play', { origin });
      if (this.readyState >= 3) this.queueEvent('playing');
      this.reschedule();
    }
    return this.ss.w.Promise.resolve();
  }
  pause(origin) {
    if (this.paused) return;
    this.rebase(); this.paused = true;
    this.queueEvent('timeupdate'); this.queueEvent('pause', { origin });
    this.reschedule();
    if (origin === 'page' && this.ss.inRaf) this.ss.onStepStop();
  }
  setRate(x) { this.rebase(); this.rate = +x; this.reschedule(); }
  setSrc(x) { this.el.setAttribute('src', String(x)); this.invokeLoad(); }
  setSrcObject(x) {
    if (x !== null && this.ss.srcMode === 'chromium') {
      throw new this.ss.w.TypeError("Failed to set the 'srcObject' property on 'HTMLMediaElement': The provided value is not of type 'MediaStream'.");
    }
    this.srcObj = x; this.invokeLoad();
  }
  // InvokeLoadAlgorithm: 積まれたイベントを捨てる。networkState が EMPTY でなければ emptied と timeupdate を積み、
  // paused=true（pause イベントは出ない）・seeking=false・位置 0。資源の選択は 1 段目（NO_SOURCE）だけ同期で、
  // 「資源が無いので EMPTY」は後のタスク。なので clearVideo の srcObject=null → load() → src= の 2 回目以降は
  // NO_SOURCE から入り、そのたびに timeupdate（位置 0）が積まれ直す
  invokeLoad() {
    for (const task of this.queued) this.S.cancel(task);
    this.queued.clear();
    this.S.cancel(this.seekTask); this.S.cancel(this.loadTask); this.seekTask = this.loadTask = null;
    if (this.networkState !== EMPTY) {
      this.queueEvent('emptied');
      this.readyState = 0;
      this.paused = true; this.seeking = false;
      this.pos = 0; this.base = this.S.now;
      this.queueEvent('timeupdate');
    }
    this.halted = false; this.rate = 1; this.lastSeekTime = 0; this.duration = NaN;
    this.reschedule();
    this.networkState = NO_SOURCE;
    this.loadTask = this.S.at(this.S.now + 0.01, () => this.selectResource(), 'media:select');
  }
  selectResource() {
    this.loadTask = null;
    const src = this.el.getAttribute('src');
    const file = this.srcObj || (src ? this.ss.blobs.get(src) || { broken: true } : null);
    this.file = file;
    if (!file) { this.networkState = EMPTY; return; }
    this.networkState = LOADING;
    this.loadTask = this.S.at(this.S.now + this.ss.loadDelay(), () => this.loaded(file), 'media:load');
  }
  loaded(file) {
    this.loadTask = null;
    if (file.broken) { this.networkState = NO_SOURCE; this.queueEvent('error', { kind: 'src' }); return; }
    this.duration = file.duration; this.networkState = IDLE; this.readyState = 1;
    this.queueEvent('durationchange'); this.queueEvent('loadedmetadata');
    if (this.dpsp > 0) { const t = this.dpsp; this.dpsp = 0; this.seek(t, 'browser'); }
    this.dpsp = 0;
    this.readyState = 4;
    this.queueEvent('loadeddata'); this.queueEvent('canplay'); this.queueEvent('canplaythrough');
    this.rebase(); this.reschedule();
  }
  fail() { this.rebase(); this.halted = true; this.reschedule(); this.queueEvent('error', { kind: 'decode' }); }
}

// ---------------------------------------------------------------- ページを開く・状態を読む口
function loadHtml(o) {
  if (o.rev) return { label: 'git ' + o.rev + ':index.html', html: execFileSync('git', ['show', o.rev + ':index.html'], { cwd: REPO, encoding: 'utf8' }) };
  const file = o.html ? path.resolve(o.html) : path.join(REPO, 'index.html');
  return { label: path.relative(process.cwd(), file) || file, html: readFileSync(file, 'utf8') };
}
function instrument(html) {
  const s0 = html.indexOf('<script>'), s1 = html.lastIndexOf('</script>');
  if (s0 < 0 || s1 < s0) throw new Error('<script> が見つからない');
  const body = html.slice(s0 + 8, s1);
  const roll = /const ROLL = ([\d.]+)/.exec(body), pad = /const PAD = ([\d.]+)/.exec(body);
  if (!roll || !pad || +roll[1] !== ROLL || +pad[1] !== PAD) throw new Error('ROLL / PAD がハーネスの前提（0.25）と違う');
  const late = /const LATE = ([\d.]+)/.exec(body);
  if (late && +late[1] !== LATE) throw new Error('LATE がハーネスの前提（' + LATE + '）と違う');
  const end = body.lastIndexOf('})();');
  if (end < 0) throw new Error('スクリプトの末尾の })(); が見つからない');
  const probe = '\n  window.__probe = () => ({ cur, holdUntil, stopIdx, stoppedAt, step, hasVideo, picked, id, n: cues.length });\n';
  return html.slice(0, s0 + 8) + body.slice(0, end) + probe + body.slice(end) + html.slice(s1);
}
function mutate(html, edits) {
  let out = html;
  for (const [from, to] of edits) {
    const k = out.split(from).length - 1;
    if (k !== 1) throw new Error('書き換え対象が ' + k + ' 箇所: ' + from);
    out = out.replace(from, () => to);
  }
  return out;
}

// ---------------------------------------------------------------- 1 回分のページ・偽の video・モデル
class Session {
  static async create(html, data, seed, o = {}) { const ss = new Session(html, data, seed, o); await ss.boot(); return ss; }
  constructor(html, data, seed, o) {
    this.html = html; this.data = data; this.sp = spec(data.cues); this.seed = seed; this.o = o;
    this.det = !!o.det; this.R = rng(subSeed(seed, 0x5eed));
    this.srcMode = o.srcMode || (this.R.chance(0.5) ? 'chromium' : 'safari');
    this.busy = o.busy == null ? 0.05 : o.busy;
    this.S = new Sched();
    this.visible = true; this.inRaf = false; this.raf = new Map(); this.rafSeq = 0;
    this.timers = new Map(); this.timerSeq = 0;
    this.blobs = new Map(); this.blobSeq = 0;
    this.viols = []; this.viol = null; this.stopOnViol = o.stopOnViol !== false;
    this.ops = []; this.ring = []; this.evc = Object.create(null);
    this.secs = []; this.stopInFrame = null; this.forceDelay = null; this.onCheck = null;
    this.rafStall = false;                    // 画面の書き換え（rAF）だけが止まっている間 true（動画とイベントは進む）
    this.stallPending = false;                // 再生中に rAF が止まり、まだ tick が回っていない間 true（その間の pause は色を合わせる）
    this.confirmCalls = 0; this.onConfirm = null;
    this.stat = { frames: 0, ticks: 0, stepStops: 0, jumps: 0, pageSeeks: 0, userSeeks: 0, browserSeeks: 0, fastDbl: 0, slowDbl: 0,
      pipe: 0, hides: 0, opens: 0, picks: 0, broken: 0, fails: 0, resumes: 0, saves: 0, stepToggles: 0, staleSeeked: 0, misses: 0,
      confirms: 0, cancels: 0, rafStalls: 0, jsStalls: 0, lateRecalcs: 0, stallPauses: 0 };
    this.ctx = '';   // 今動いているページの処理（前回位置の保存がどこから来たかを違反に書くため）
    this.codeCount = Object.create(null); this.ignored = Object.create(null);
    // モデル（仕様側の期待）。誰がシークしたかを知っている点がページと違う
    this.m = { step: false, open: false, picked: false, loaded: false, row: -1, hold: -1, stop: 0, armT: 0, stopped: -1,
      moved: false, P: 0, last: null, offerT: null, offerShown: false, mark: null };
    // presetT: 前にアプリを開いた時の前回位置が保存されている状態で開く（ページを開き直すので、ページの中の変数は持ち越さない）
    if (o.presetT != null) this.m.P = o.presetT;
  }
  async boot() {
    const ss = this;
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => ss.pageError((e && (e.stack || e.message)) || String(e)));
    vc.on('error', (...a) => ss.pageError(a.map(String).join(' ')));
    const dom = new JSDOM(instrument(this.html), {
      url: 'https://study-player.test/', runScripts: 'dangerously', virtualConsole: vc,
      beforeParse(w) {
        if (ss.o.presetT != null) w.localStorage.setItem('sp:t:' + ss.data.id, JSON.stringify(ss.o.presetT));
        ss.install(w);
      },
    });
    this.dom = dom; this.w = dom.window; this.doc = this.w.document;
    this.v = this.doc.getElementById('v');
    this.media = this.mediaOf(this.v);
    if (typeof this.w.__probe !== 'function') throw new Error('状態を読む口が入っていない（スクリプトが途中で止まった）');
    this.S.at(this.det ? FRAME : this.R.range(0, FRAME), () => this.frame(), 'frame');
    // 字幕データはページの「字幕データを追加」から入れる
    const add = this.doc.getElementById('addData'), json = JSON.stringify(studyJson(this.data));
    Object.defineProperty(add, 'files', { configurable: true, value: [{ name: this.data.id + '.study.json', text: async () => json }] });
    add.dispatchEvent(new this.w.Event('change', { bubbles: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    if (!this.doc.querySelector('#lib .open')) throw new Error('字幕データを追加できなかった: ' + this.doc.getElementById('libNote').textContent);
  }
  install(w) {
    const ss = this;
    w.requestAnimationFrame = (cb) => { const id = ++ss.rafSeq; ss.raf.set(id, cb); return id; };
    w.cancelAnimationFrame = (id) => { ss.raf.delete(id); };
    w.setTimeout = (fn, ms) => { const id = ++ss.timerSeq; ss.timers.set(id, ss.S.at(ss.S.now + (+ms || 0), () => { ss.timers.delete(id); fn(); }, 'timer')); return id; };
    w.clearTimeout = (id) => { ss.S.cancel(ss.timers.get(id)); ss.timers.delete(id); };
    w.matchMedia = (q) => ({ matches: /standalone/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    w.scrollTo = () => {};
    // 「一覧」は動画を読み込んでいる時に確かめる。既定は「はい」。backOp が回数を数え（M8）、キャンセルと迷う時間を差し込む
    w.confirm = (msg) => { ss.confirmCalls++; ss.stat.confirms++; return ss.onConfirm ? !!ss.onConfirm(String(msg)) : true; };
    w.URL.createObjectURL = (obj) => { const u = 'blob:https://study-player.test/' + (++ss.blobSeq); ss.blobs.set(u, obj); return u; };
    w.URL.revokeObjectURL = (u) => { ss.blobs.delete(u); };
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => (ss.visible ? 'visible' : 'hidden') });
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => !ss.visible });
    const setItem = w.Storage.prototype.setItem;
    w.Storage.prototype.setItem = function (k, val) { const r = setItem.call(this, k, val); ss.onStore(String(k), String(val)); return r; };
    const P = w.HTMLMediaElement.prototype, M = (el) => ss.mediaOf(el);
    const acc = (k, get, set) => Object.defineProperty(P, k, { configurable: true, enumerable: true, get, set });
    acc('paused', function () { return M(this).paused; });
    acc('seeking', function () { return M(this).seeking; });
    acc('currentTime', function () { return M(this).currentTime; }, function (x) { M(this).setCurrentTime(x); });
    acc('duration', function () { return M(this).duration; });
    acc('readyState', function () { return M(this).readyState; });
    acc('networkState', function () { return M(this).networkState; });
    acc('ended', function () { const m = M(this); return m.endedPlayback() && m.paused; });
    acc('playbackRate', function () { return M(this).rate; }, function (x) { M(this).setRate(x); });
    acc('src', function () { return this.getAttribute('src') || ''; }, function (x) { M(this).setSrc(x); });
    acc('srcObject', function () { return M(this).srcObj; }, function (x) { M(this).setSrcObject(x); });
    acc('currentSrc', function () { const m = M(this); return m.readyState ? (this.getAttribute('src') || 'file') : ''; });
    acc('textTracks', function () { return Array.from(this.querySelectorAll('track')).map((t) => t.track); });
    P.play = function () { return M(this).play('page'); };
    P.pause = function () { M(this).pause('page'); };
    P.load = function () { M(this).invokeLoad(); };
    const tracks = new WeakMap();
    Object.defineProperty(w.HTMLTrackElement.prototype, 'track', {
      configurable: true, get() { let t = tracks.get(this); if (!t) tracks.set(this, (t = { mode: 'disabled' })); return t; },
    });
  }
  mediaOf(el) {
    if (!this._media) this._media = new Media(this, el);
    if (this._media.el !== el) throw new Error('video が 2 つある');
    return this._media;
  }
  // 環境の揺れ（det は決まった値）
  eventDelay() {
    if (this.forceDelay != null) return this.forceDelay;
    if (this.det) return 0.1;
    return this.R.chance(this.busy) ? this.R.range(5, 40) : this.R.range(0.02, 1);
  }
  seekDelay() { return this.det ? 60 : (this.R.chance(0.1) ? this.R.range(220, 600) : this.R.range(8, 220)); }
  loadDelay() { return this.det ? 100 : this.R.range(30, 400); }

  $(id) { return this.doc.getElementById(id); }
  probe() { return this.w.__probe(); }
  safeProbe() { try { return this.probe(); } catch (_) { return {}; } }
  colored() {
    let idx = -1, count = 0;
    for (let i = 0; i < this.secs.length; i++) if (this.secs[i].classList.contains('cur')) { idx = i; count++; }
    return { idx, count };
  }
  visibleEl(el) { return !!el && !el.disabled && !el.closest('[hidden]'); }
  offerButton() {
    const info = this.$('info');
    if (!info || info.hidden || !this.m.open) return null;
    return Array.from(info.querySelectorAll('button')).find((b) => b.textContent === '続きから') || null;
  }
  pendingSeek() { const L = this.m.last; return !!(L && !L.applied && L.origin !== 'page'); }
  note(s) { this.ring.push(fx(this.S.now / 1000) + 's ' + s); if (this.ring.length > 80) this.ring.shift(); }
  pageError(msg) { this.fail('PAGE-ERROR', String(msg).split('\n').slice(0, 3).join(' | ')); }
  fail(code, msg) {
    if (this.o.codes && !this.o.codes.has(code)) { this.ignored[code] = (this.ignored[code] || 0) + 1; return; }
    this.codeCount[code] = (this.codeCount[code] || 0) + 1;
    if (this.viols.length >= 50) { if (!this.viol) this.viol = this.viols[0]; return; }
    const p = this.safeProbe(), v = this.media;
    const rec = {
      code, msg, at: this.S.now, op: this.ops.length,
      page: v ? { t: fx(v.currentTime), paused: v.paused, seeking: v.seeking, cur: p.cur, holdUntil: p.holdUntil, stopIdx: p.stopIdx, stoppedAt: p.stoppedAt, step: p.step } : {},
      model: { row: this.m.row, hold: this.m.hold, stop: this.m.stop, stopped: this.m.stopped, step: this.m.step, P: this.m.P },
      ring: this.ring.slice(-40),
    };
    this.viols.push(rec);
    if (!this.viol) this.viol = rec;
  }
  halted() { return this.stopOnViol && !!this.viol; }

  // ---- 時間を進める
  advance(ms) {
    const T = this.S.now + Math.max(0, ms);
    while (!this.halted()) {
      const nx = this.S.peek();
      if (!nx || nx.t > T) break;
      const task = this.S.next();
      if (task.label === 'media:seek' || task.label === 'media:load' || task.label === 'media:end') { this.note(task.label); this.check(task.label); }
    }
    if (this.S.now < T) this.S.now = T;
  }
  // 次のメディアの内部処理（シーク完了・読み込み・終わり）の直後で止める。積まれたイベントが届く前に指が入る順
  advanceToPipe(maxMs) {
    const T = this.S.now + maxMs;
    while (!this.halted()) {
      const nx = this.S.peek();
      if (!nx || nx.t > T) { this.S.now = Math.max(this.S.now, T); return false; }
      const task = this.S.next();
      if (task.label === 'media:seek' || task.label === 'media:load' || task.label === 'media:end') {
        this.note(task.label + '（直後に操作）'); this.check(task.label); this.stat.pipe++; return true;
      }
    }
    return false;
  }
  runUntil(pred, maxMs) {
    const T = this.S.now + maxMs;
    while (!this.halted()) {
      if (pred()) return true;
      const nx = this.S.peek();
      if (!nx || nx.t > T) break;
      const task = this.S.next();
      if (task.label === 'media:seek' || task.label === 'media:load' || task.label === 'media:end') this.check(task.label);
    }
    return pred();
  }

  // ---- 画面の書き換え（rAF）とモデルの追従
  frame() {
    this.S.at(this.S.now + FRAME, () => this.frame(), 'frame');
    this.stat.frames++;
    const ran = this.visible && !this.rafStall && this.raf.size > 0;
    if (ran) {
      this.stallPending = false;
      const cbs = [...this.raf.values()];
      this.raf.clear();
      this.stopInFrame = null; this.inRaf = true; this.stat.ticks++;
      this.ctx = 'rAF';
      for (const cb of cbs) { try { cb(this.S.now); } catch (e) { this.pageError(e && e.stack || String(e)); } }
      this.ctx = '';
      this.inRaf = false;
      this.afterTick();
    }
    this.frameCheck(ran);
  }
  onStepStop() { this.stopInFrame = { t: this.media.currentTime }; this.note('ページが止めた（1行ずつ）'); }
  afterTick() {
    const m = this.m, sp = this.sp, v = this.media, t = v.currentTime, st = this.stopInFrame;
    if (!m.open || this.halted()) return;
    if (st) {
      this.stat.stepStops++;
      const r = this.probe().stoppedAt;
      if (!m.step) this.fail('M4', '「1行ずつ」がオフなのに ' + r + ' 行目で止めた');
      else if (v.seeking) this.fail('M4', 'シークの途中（飛び先 ' + fx(t) + '）で ' + r + ' 行目の終わりを越えたと見て止めた（モデルの止める行 ' + m.stop + '）');
      else if (r !== m.stop) this.fail('M4', r + ' 行目で止めた。期待は ' + m.stop + ' 行目（終わり ' + fx(m.stop < sp.n ? sp.endPoint(m.stop) : NaN) + '、時刻 ' + fx(t) + '）');
      else if (t < sp.endPoint(r) - EPS) this.fail('M4', r + ' 行目の終わり ' + fx(sp.endPoint(r)) + ' より前（' + fx(t) + '）で止めた');
      else if (t - Math.max(sp.endPoint(r), m.armT) > DSTOP) this.fail('M4', r + ' 行目の終わり ' + fx(sp.endPoint(r)) + ' から ' + fx(t - sp.endPoint(r)) + ' 秒遅れて止めた');
      // 止めた時は巻き戻しも終わっている（止める点は行の頭より後）。画面の書き換えやスクリプトが止まった後の 1 回の tick で
      // 巻き戻しの終わりと止める点を両方越えると、ページは止める処理で return して holdUntil を残す（INV1 で見える）
      m.stopped = r; m.row = r; m.hold = -1; m.stop = sp.nextStop(r + 1, t); m.armT = t;
      return;
    }
    this.lateRecalc(t);
    this.modelRowTick(t);
    if (m.loaded && m.step && !v.paused && !v.seeking && !this.pendingSeek() && m.stop < sp.n && t >= sp.endPoint(m.stop)) {
      this.stat.misses++;
      this.fail('M5', '「1行ずつ」がオンで再生中、' + m.stop + ' 行目の終わり ' + fx(sp.endPoint(m.stop)) + ' を過ぎても止めない（時刻 ' + fx(t) + '、ページの止める行 ' + this.probe().stopIdx + '）');
    }
  }
  // 止める点を LATE 秒以上過ぎてから tick が来た（動画は進んだまま rAF だけが止まっていた）時は、止めずに時刻から止める行を
  // 引き直す。止まっている時の tick（その間に一時停止した時の pause、止まっている間の seeked）でも同じ。止まっている時は
  // LATE 未満なら何もしない（止めもしない。色は止める行で頭打ちのまま）。rAF の後・seeked・pause で modelRowTick の前に呼ぶ
  lateRecalc(t) {
    const m = this.m, sp = this.sp;
    if (m.loaded && m.step && !this.media.seeking && m.stop < sp.n && t >= sp.endPoint(m.stop) + LATE) { m.stop = sp.stopRowAt(t); m.armT = t; this.stat.lateRecalcs++; }
  }
  // ページの tick のうち止める判定より後と同じ規則で、色の行の期待を進める（巻き戻し中は動かさない。1行ずつの間は
  // 止める行より先へ進めない）。rAF の後と、止まっている間の seeked・pause の後（ページはそこでも tick する）に呼ぶ
  modelRowTick(t) {
    const m = this.m, sp = this.sp;
    const rowAt = (x) => (m.step ? Math.min(sp.cueAt(x), m.stop) : sp.cueAt(x));
    if (m.hold >= 0) { if (t >= m.hold) { m.hold = -1; m.row = rowAt(t); } }
    else m.row = rowAt(t);
  }
  frameCheck(ran) {
    const m = this.m, v = this.media, sp = this.sp;
    if (this.halted() || !m.open) return;
    if (m.loaded && this.visible && !this.rafStall && m.step && v.advancing() && !this.pendingSeek() && m.stop < sp.n) {
      if (v.currentTime > Math.max(sp.endPoint(m.stop), m.armT) + DSTOP) {
        this.fail('M5', '再生中なのに画面の書き換えで止める判定が走らず、' + m.stop + ' 行目の終わりを ' + fx(v.currentTime - sp.endPoint(m.stop)) + ' 秒過ぎた');
      }
    }
    if (!ran) return;
    // INV2（字句どおり）: 再生中の止める行は時刻から引いた値と一致する。重なりの無いデータだけで見る
    const p = this.probe();
    if (this.data.kind === 'clean' && p.step && !v.paused && !v.seeking && p.holdUntil < 0 && p.hasVideo && !this.stopInFrame) {
      const want = sp.stopRowAt(v.currentTime);
      if (p.stopIdx !== want) this.fail('INV2', '再生中の止める行 ' + p.stopIdx + '、時刻 ' + fx(v.currentTime) + ' から引くと ' + want);
    }
    this.check('frame');
  }

  // ---- メディアのイベントを届け、モデルを合わせる
  dispatchMedia(type, meta) {
    this.evc[type] = (this.evc[type] || 0) + 1;
    if (type !== 'timeupdate' && type !== 'playing' && type !== 'canplay' && type !== 'canplaythrough' && type !== 'loadeddata' && type !== 'durationchange') {
      this.note('ev ' + type + (meta.origin ? '(' + meta.origin + ')' : '') + (meta.target != null ? ' →' + fx(meta.target) : '') +
        (type === 'seeked' && this.media.seeking ? '（次のシーク中）' : ''));
    }
    if (type === 'seeked' && this.media.seeking) this.stat.staleSeeked++;
    this.ctx = type; this.v.dispatchEvent(new this.w.Event(type)); this.ctx = '';
    const m = this.m;
    if (type === 'seeking') {
      const L = m.last;
      if (L && !L.applied && L.origin !== 'page') {
        L.applied = true;
        // 飛んでいる最中の「行へ飛ぶ」の行き先と 0.01 秒未満しか違わないシークは、行へ飛んだのと区別しない（設計上の許容）
        if (m.mark != null && Math.abs(L.target - m.mark) < 0.01) this.note('（行へ飛ぶ先とほぼ同じ位置へのシーク。飛んだのと同じに扱う）');
        else { m.mark = null; this.modelSeekTo(L.target); }
      }
    } else if (type === 'seeked') {
      if (!this.media.seeking) m.mark = null;
      // ページは止まっている間の seeked でも tick する（「1行ずつ」で止めた後は除く）。次のシーク中に届いた古い seeked では
      // 時刻が次の飛び先なので、巻き戻しがそこで終わることがある（行 0 が 0 秒ちょうどの時は飛んだ直後にも終わる）
      if (m.open && this.media.paused && m.stopped < 0) { this.lateRecalc(this.media.currentTime); this.modelRowTick(this.media.currentTime); }
    } else if (type === 'play') {
      // ページが止める判定をできるのは、再生が始まってから（止める点を過ぎた所で一時停止していた時の停止の遅れは、ここから数える）
      m.stopped = -1; m.armT = Math.max(m.armT, this.media.currentTime);
    } else if (type === 'pause') {
      // 止まった時刻の行に色を合わせるか（ページが pause で tick と同じ処理をするか）は、画面の書き換えが続いていれば最後の tick と
      // 1 フレームしか違わないので、どちらでもよい（ページが合わせていれば合わせた方に、いなければ最後の tick のままにする）。
      // 再生中に画面の書き換えが止まり、まだ tick が回っていない間（全画面・ピクチャインピクチャで止めた、見終わった）は合わせる。
      // 「1行ずつ」の止める点を LATE 以上過ぎていれば、止める行も引き直して合わせる（引き直さないと色が古い止める行で頭打ちになる）
      if (m.open && m.loaded && this.media.paused && m.stopped < 0 && !this.pendingSeek()) {
        const p = this.probe(), keep = { row: m.row, hold: m.hold, stop: m.stop, armT: m.armT };
        this.lateRecalc(this.media.currentTime);
        this.modelRowTick(this.media.currentTime);
        const synced = p.cur === m.row && (p.holdUntil >= 0) === (m.hold >= 0);
        if (!this.stallPending && !synced) Object.assign(m, keep);
      }
    } else if (type === 'loadedmetadata') {
      if (m.picked && m.open) { m.loaded = true; this.checkOffer(); }
    } else if (type === 'error') {
      if (m.picked) m.loaded = false;
    }
    this.check('ev:' + type);
  }
  modelSeekTo(T) {
    const m = this.m, sp = this.sp;
    m.hold = -1; m.stopped = -1; m.row = sp.cueAt(T); m.stop = sp.stopRowAt(T); m.armT = T;
  }
  onSeekIssued(origin, t, id) {
    if (origin === 'page') { this.stat.pageSeeks++; this.m.last = { origin, target: t, id, applied: true }; this.m.mark = t; return; }
    if (origin === 'user') this.stat.userSeeks++; else this.stat.browserSeeks++;
    this.m.last = { origin, target: t, id, applied: false };
    this.m.moved = true;
  }
  onStore(k, val) {
    if (!k.startsWith('sp:t:')) return;
    const m = this.m, x = JSON.parse(val);
    this.stat.saves++;
    if (k !== 'sp:t:' + this.data.id) { this.fail('M6', '別の id の前回位置を書いた: ' + k); return; }
    if (!m.moved) {
      this.fail('M6', '動画を読み込んでから再生も移動もしていないのに、前回位置を ' + fx(x) + ' で上書きした（それまでは ' + fx(m.P) + '、' + (this.ctx || '?') + ' の中）');
    } else {
      const E = Math.max(this.media.currentTime, m.hold >= 0 ? m.hold : -Infinity);
      if (Math.abs(x - E) > EPS) {
        this.fail('M6', '前回位置に ' + fx(x) + '（' + this.sp.cueAt(x) + ' 行目）を書いた。期待は ' + fx(E) + '（' + this.sp.cueAt(E) + ' 行目、' + (this.ctx || '?') + ' の中）');
      }
    }
    m.P = x;
  }
  checkOffer() {
    const m = this.m, raw = this.w.localStorage.getItem('sp:t:' + this.data.id);
    const stored = raw === null ? 0 : JSON.parse(raw);
    if (Math.abs(stored - m.P) > EPS) { this.fail('HARNESS', '保存値の追跡がずれた（保存 ' + stored + '、追跡 ' + m.P + '）'); return; }
    const want = m.P > 5 && m.P < this.data.duration - 5, b = this.offerButton();
    if (!!b !== want) this.fail('M7', '開き直した時の「続きから」が' + (b ? 'ある' : '無い') + '。前回位置 ' + fx(m.P) + ' なら' + (want ? 'あるはず' : '無いはず'));
    m.offerT = b ? m.P : null; m.offerShown = !!b;
  }
  // 毎タスクの後に見る
  check(where) {
    if (this.halted()) return;
    const m = this.m;
    if (!m.open) { if (this.onCheck) this.onCheck(this); return; }
    const p = this.probe(), v = this.media, col = this.colored();
    if (col.count > 1) this.fail('DOM', '色の付いた行が ' + col.count + ' 個（' + where + '）');
    else if (col.idx !== p.cur && !(p.cur < 0 && col.idx < 0)) this.fail('DOM', '色の付いた行 ' + col.idx + ' と cur ' + p.cur + ' が違う（' + where + '）');
    else if (p.holdUntil >= 0 && p.cur !== p.stopIdx) {
      this.fail('INV1', '巻き戻し中（' + fx(p.holdUntil) + ' まで）に色の行 ' + p.cur + ' と止める行 ' + p.stopIdx + ' が違う（' + where + '、時刻 ' + fx(v.currentTime) + '）');
    } else if (v.paused && p.stoppedAt >= 0 && p.cur !== p.stoppedAt) {
      this.fail('INV3', '止まっている間の色の行 ' + p.cur + ' と止めた行 ' + p.stoppedAt + ' が違う（' + where + '、時刻 ' + fx(v.currentTime) + '）');
    } else if (!this.pendingSeek()) {
      if (p.cur !== m.row) {
        this.fail('M-ROW', '色の行 ' + p.cur + '、モデルの期待 ' + m.row + '（' + where + '、時刻 ' + fx(v.currentTime) + '）');
      } else if ((p.holdUntil >= 0) !== (m.hold >= 0) || (m.hold >= 0 && Math.abs(p.holdUntil - m.hold) > EPS)) {
        this.fail('M-HOLD', '巻き戻しの終わり: ページ ' + p.holdUntil + '、モデル ' + m.hold + '（' + where + '）');
      } else if (m.step && m.loaded && !v.paused && p.stopIdx !== m.stop) {
        this.fail('M-STOP', '「1行ずつ」の止める行: ページ ' + p.stopIdx + '、モデル ' + m.stop + '（' + where + '、時刻 ' + fx(v.currentTime) + '）');
      }
    }
    if (m.loaded && !this.halted() && !!this.offerButton() !== m.offerShown) {
      this.fail('M9', '「続きから」の案内が' + (m.offerShown ? '、行から見始めていないのに消えた' : '、行から見始めたのに残っている') + '（' + where + '）');
    }
    if (this.onCheck) this.onCheck(this);
  }

  // ---- 操作（指・ブラウザ）
  click(id) {
    const el = this.$(id);
    if (!this.visibleEl(el)) return false;
    this.ctx = 'click #' + id; el.click(); this.ctx = '';
    this.check('click ' + id);
    return true;
  }
  jumpClick(el, target) {
    const m = this.m;
    if (!this.visibleEl(el)) return false;
    const before = this.probe().cur;
    this.note('押す → ' + target + ' 行目' + (m.loaded ? '' : '（動画なし）'));
    this.ctx = 'click → ' + target; el.click(); this.ctx = '';
    if (this.halted()) return true;
    const p = this.probe(), col = this.colored();
    if (!m.loaded) {
      if (p.cur !== before) this.fail('M1', '動画が無いのに色の行が ' + before + ' から ' + p.cur + ' に変わった');
      return true;
    }
    this.stat.jumps++;
    const s = this.sp.cues[target].s;
    if (col.idx !== target || p.cur !== target) this.fail('M1', '押した直後の色の行 ' + col.idx + '、押した先 ' + target);
    else if (Math.abs(p.holdUntil - s) > EPS || p.stopIdx !== target || p.stoppedAt !== -1) {
      this.fail('M1', '押した直後の状態: holdUntil ' + p.holdUntil + '（期待 ' + s + '）、止める行 ' + p.stopIdx + '（期待 ' + target + '）、止めた行 ' + p.stoppedAt);
    }
    // 行き先（行の頭の ROLL 秒手前）を覚える。同じ所へのシークが飛んでいる最中なら、ページはシークし直さずそれを自分のシークとして扱う
    Object.assign(m, { row: target, hold: s, stop: target, armT: Math.max(0, s - ROLL), stopped: -1, moved: true, mark: Math.max(0, s - ROLL), offerShown: false });
    if (!m.last || m.last.origin !== 'page' || !m.last.applied) m.last = { origin: 'page', applied: true };
    this.check('jump');
    return true;
  }
  tapOp(k) { return this.jumpClick(this.secs[k], k); }
  navOp(id) {
    const m = this.m, n = this.sp.n;
    const base = this.media.paused && m.stopped >= 0 ? m.stopped : m.row;
    const target = id === 'next' ? Math.min(n - 1, base + 1) : id === 'prev' ? Math.max(0, base - 1) : Math.max(0, base);
    return this.jumpClick(this.$(id), target);
  }
  stepOp() {
    const m = this.m;
    if (!this.visibleEl(this.$('step'))) return false;
    this.stat.stepToggles++;
    const t = this.media.currentTime;
    m.step = !m.step;
    if (m.step) { m.stop = m.hold >= 0 ? m.row : this.sp.stopRowAt(t); m.armT = t; }
    this.note('1行ずつ ' + (m.step ? 'オン' : 'オフ'));
    return this.click('step');
  }
  playOp() {
    const v = this.media;
    if (!this.m.open || !this.m.loaded || !v.paused) return false;
    this.note('▶（動画の操作）');
    this.m.moved = true;
    // ページが止める判定をできるのは play が届いて rAF が回ってから。止める点を過ぎた所で止まっていた時（rAF が止まっている間に
    // 一時停止した後）の遅れは、ここから数える
    this.m.armT = Math.max(this.m.armT, v.currentTime);
    v.play('user');
    this.check('play');
    return true;
  }
  pauseOp() {
    const v = this.media;
    if (!this.m.open || !this.m.loaded || v.paused) return false;
    this.note('❚❚（動画の操作）');
    v.pause('user');
    this.check('pause');
    return true;
  }
  scrubOp(ts, gaps, hold) {
    const v = this.media;
    if (!this.m.open || !this.m.loaded) return false;
    const wasPlaying = !v.paused;
    if (hold && wasPlaying) v.pause('user');          // iOS のつまみは触っている間止める
    for (let i = 0; i < ts.length && !this.halted(); i++) {
      if (i) this.advance(gaps[i - 1] || 0);
      this.note('シークバー → ' + fx(ts[i]));
      v.seek(ts[i], 'user');
      this.check('scrub');
    }
    if (hold && wasPlaying && !this.halted()) {
      this.advance(gaps[ts.length - 1] || 20);
      this.m.armT = Math.max(this.m.armT, v.currentTime);
      v.play('user'); this.check('scrub-release');
    }
    return true;
  }
  hideOp(ms) {
    if (!this.m.open) return false;
    this.stat.hides++;
    this.note('アプリを離れる');
    if (!this.media.paused) this.media.pause('system');
    this.visible = false; this.ctx = 'visibilitychange'; this.doc.dispatchEvent(new this.w.Event('visibilitychange')); this.ctx = '';
    this.check('hidden');
    this.advance(ms);
    if (this.halted()) return true;
    this.visible = true; this.ctx = 'visibilitychange'; this.doc.dispatchEvent(new this.w.Event('visibilitychange')); this.ctx = '';
    this.note('戻る');
    this.check('visible');
    return true;
  }
  // ページのスクリプトが ms ミリ秒止まる（「一覧」の確かめのダイアログを読んで迷う間）。動画は進むが、イベントも画面の書き換えも
  // 届かない。仮想の時計は進めずに動画の位置だけを進め、止まっていた間に積まれるはずの timeupdate は省く。見終わりはまたがない
  // （WebKit の WPE では進んだ。iPhone でダイアログの間も動画が進むかは確かめていない。進まないなら、この操作は迷う時間 0 と
  // 同じになる）。ページが確かめの前に動画を止めていれば何もしない
  jsBlock(ms) {
    const v = this.media;
    if (!(ms > 0) || !v.advancing()) return 0;
    v.rebase();
    const adv = Math.max(0, Math.min(ms / 1000 * v.rate, v.duration - v.pos - 0.3));
    if (adv <= 0) return 0;
    v.pos += adv; v.base = this.S.now; v.reschedule();
    this.m.armT = Math.max(this.m.armT, v.pos);   // ページが止める判定をできるのは、ここから
    this.stat.jsStalls++;
    this.note('確かめで ' + Math.round(ms) + 'ms 迷う間に動画が ' + fx(adv) + ' 秒進む（スクリプトは止まっている）');
    return adv;
  }
  backOp(cancel = false, stallMs = 0) {
    const el = this.$('back');
    if (!this.m.open || !this.visibleEl(el)) return false;
    const wantAsk = this.m.loaded ? 1 : 0, n0 = this.confirmCalls, playing = !this.media.paused;
    this.note('一覧へ' + (cancel || stallMs ? '（確かめで' + (stallMs ? Math.round(stallMs) + 'ms 迷って' : '') + (cancel ? 'キャンセル' : '「はい」') + '）' : ''));
    let adv = 0, ranDuring = false;
    const saves0 = this.stat.saves;
    // 確かめが出た時に動画が止まっているか（止まっていなければ、迷う間に動画が進む）
    this.onConfirm = () => { ranDuring = !this.media.paused; adv = this.jsBlock(stallMs); return !cancel; };
    this.ctx = 'click #back'; el.click(); this.ctx = '';   // 前回位置の保存（M6）は閉じる前のモデルで見る
    this.onConfirm = null;
    // 押した処理の中での保存の回数・戻った時刻・確かめの間に動画が再生されたままだったか・押した処理の直後に再生中か
    this.backClick = { saves: this.stat.saves - saves0, t: this.media.currentTime, ranDuring, playingAfter: !this.media.paused };
    const asked = this.confirmCalls - n0, closed = this.$('playerView').hidden;
    if (asked !== wantAsk) {
      this.fail('M8', '「一覧」の確かめが ' + asked + ' 回出た（動画を' + (wantAsk ? '読み込んでいる' : '読み込んでいない') + 'ので ' + wantAsk + ' 回のはず）');
    }
    if (asked && ranDuring) this.fail('M8', '再生したまま「一覧」の確かめを出した（迷っている間も動画が進み、「1行ずつ」の止める点を過ぎる）');
    if (cancel && asked) {
      this.stat.cancels++;
      if (closed || !this.probe().hasVideo) this.fail('M8', '確かめでキャンセルしたのに' + (closed ? '一覧へ戻った' : '動画が外れた'));
      else if (playing === this.media.paused) this.fail('M8', playing ? '確かめでキャンセルしたのに再生に戻らない' : '止まっていたのに、確かめでキャンセルしたら再生を始めた');
    } else if (!closed) {
      this.fail('M8', '「一覧」を押して' + (asked ? '「はい」と答えた' : '確かめが出なかった') + 'のに一覧へ戻らない');
    }
    // ダイアログを閉じてから次に指が触れるまでには、画面の書き換えが少なくとも 1 回入る（同じ瞬間の操作は起きない）
    if (!closed) { this.check('back-cancel'); if (adv > 0) this.advance(FRAME + 1); return true; }
    Object.assign(this.m, { open: false, loaded: false, picked: false, last: null, offerT: null, offerShown: false, hold: -1, stopped: -1, mark: null });
    this.check('back');
    return true;
  }
  // 再生中に画面の書き換え（rAF）だけが ms ミリ秒止まる（全画面・ピクチャインピクチャ・コントロールセンター）。動画は進み、イベントも届く。
  // pauseAt（0〜1）を渡すと、止まっている間のその割合の所で一時停止する（全画面・ピクチャインピクチャの操作）
  rafStallOp(ms, pauseAt = 0) {
    const v = this.media;
    if (!this.m.open || !this.m.loaded || v.paused) return false;
    this.stat.rafStalls++;
    this.note('画面の書き換えが ' + Math.round(ms) + 'ms 止まる');
    this.rafStall = true; this.stallPending = true;
    if (pauseAt > 0) {
      this.advance(ms * pauseAt);
      if (!this.halted() && !v.paused) {
        this.stat.stallPauses++;
        this.note('止まっている間に一時停止（全画面・ピクチャインピクチャの操作）');
        v.pause('user'); this.check('pause-in-stall');
      }
      this.advance(ms * (1 - pauseAt));
    } else this.advance(ms);
    this.rafStall = false;
    if (v.advancing()) this.m.armT = Math.max(this.m.armT, v.position());   // 止める判定をできるのは、書き換えが戻ってから
    this.note('画面の書き換えが戻る');
    this.advance(FRAME + 1);   // 戻ってから次に指が触れるまでには、画面の書き換えが少なくとも 1 回入る
    return true;
  }
  openOp() {
    if (this.m.open) return false;
    const b = this.doc.querySelector('#lib .open');
    if (!b) return false;
    this.stat.opens++;
    this.note('一覧から開く');
    this.ctx = 'open'; b.click(); this.ctx = '';
    this.secs = Array.from(this.doc.querySelectorAll('#list section.cue'));
    Object.assign(this.m, { open: true, picked: false, loaded: false, row: -1, hold: -1, stop: 0, armT: 0, stopped: -1, moved: false, last: null, offerT: null, offerShown: false, mark: null });
    this.check('open');
    return true;
  }
  pickOp(broken) {
    const input = this.$('pickVideo');
    if (!this.m.open || this.$('picker').hidden) return false;
    this.stat.picks++; if (broken) this.stat.broken++;
    this.note('動画を選ぶ' + (broken ? '（再生できないファイル）' : ''));
    const file = { name: broken ? 'broken.mp4' : 'synthetic.mp4', type: 'video/mp4', size: 1e6, duration: this.data.duration, broken: !!broken };
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    this.ctx = 'pick'; input.dispatchEvent(new this.w.Event('change', { bubbles: true })); this.ctx = '';
    Object.assign(this.m, { picked: true, loaded: false, hold: -1, stop: 0, armT: 0, stopped: -1, moved: false, last: null, offerT: null, offerShown: false, mark: null });
    this.check('pick');
    return true;
  }
  resumeOp() {
    const b = this.offerButton();
    if (!b || this.m.offerT == null) return false;
    this.stat.resumes++;
    this.note('続きから');
    return this.jumpClick(b, Math.max(0, this.sp.cueAt(this.m.offerT)));
  }
  failOp() {
    if (!this.m.open || !this.m.loaded) return false;
    this.stat.fails++;
    this.note('再生中に読めなくなる（error）');
    this.media.fail();
    return true;
  }
}

// ---------------------------------------------------------------- ランダムな操作
function pickTime(ss, R) {
  const sp = ss.sp, d = ss.data, u = R.f();
  if (u < 0.08) return 0;                       // シークバーの左端
  if (u < 0.12) return d.duration;              // 右端
  if (u < 0.5) { const k = R.int(0, sp.n - 1); return Math.max(0, sp.cues[k].s + R.pick([-0.3, -ROLL, -0.2, -0.1, -0.01, 0, 0.01, 0.1])); }
  if (u < 0.7) { const k = R.int(0, sp.n - 1); return Math.max(0, sp.endPoint(k) + R.pick([-0.2, -0.05, -0.01, 0, 0.01])); }
  return R.f() * d.duration;
}
function genOp(ss, R) {
  const m = ss.m, v = ss.media, sp = ss.sp, d = ss.data;
  const g = R.chance(0.1) ? 'pipe' : (R.chance(0.9) ? R.range(80, 600) : R.range(600, 2500));
  if (!m.open) return R.chance(0.85) ? { k: 'open', g } : { k: 'wait', ms: R.range(100, 3000) };
  if (!m.loaded) {
    const kind = R.weighted([[10, 'pick'], [0.6, 'broken'], [3, 'wait'], [0.4, 'back'], [0.2, 'backCancel'], [0.6, 'step'], [0.6, 'tap'], [0.6, 'nav']]);
    if (kind === 'pick') return { k: 'pick', broken: false, g };
    if (kind === 'broken') return { k: 'pick', broken: true, g };
    if (kind === 'backCancel') return { k: 'back', cancel: true, g };   // 動画が無いので確かめは出ず、そのまま一覧へ戻るはず
    if (kind === 'wait') return { k: 'wait', ms: R.range(50, 800) };
    if (kind === 'tap') return { k: 'tap', row: R.int(0, sp.n - 1), g };
    if (kind === 'nav') return { k: 'nav', id: R.pick(['next', 'prev', 'again']), g };
    return { k: kind, g };
  }
  const playing = !v.paused;
  const kind = R.weighted([
    [22, 'wait'], [9, 'tap'], [7, 'next'], [4, 'prev'], [5, 'again'], [2.5, 'dblFast'], [1.5, 'dblSlow'],
    [6, 'step'], [playing ? 0 : 9, 'play'], [playing ? 4 : 0, 'pause'], [5, 'scrub'], [1, 'toEnd'],
    [1.5, 'speed'], [1, 'toggle'], [1.5, 'hide'], [1, 'back'], [ss.offerButton() ? 4 : 0, 'resume'], [0.15, 'fail'],
    [1, 'backCancel'], [playing ? 1.5 : 0, 'stall'],
  ]);
  switch (kind) {
    case 'wait': return { k: 'wait', ms: R.chance(0.7) ? R.range(30, 1500) : R.range(1500, 8000) };
    case 'tap': {
      const row = R.chance(0.5) ? Math.max(0, Math.min(sp.n - 1, Math.max(0, m.row) + R.int(-3, 3))) : R.int(0, sp.n - 1);
      return { k: 'tap', row, g };
    }
    case 'next': case 'prev': case 'again': return { k: 'nav', id: kind, g };
    case 'dblFast': return { k: 'dbl', id: R.pick(['next', 'next', 'prev', 'again']), d: 0, g };
    case 'dblSlow': return { k: 'dbl', id: R.pick(['next', 'prev', 'again']), d: R.range(40, 220), g };
    case 'scrub': {
      const n = R.int(1, 4), ts = [], gaps = [];
      for (let i = 0; i < n; i++) { ts.push(pickTime(ss, R)); gaps.push(R.range(0, 80)); }
      return { k: 'scrub', ts, gaps, hold: R.chance(0.5), g };
    }
    case 'toEnd': return { k: 'scrub', ts: [R.pick([d.duration, d.duration - 0.05, d.duration - 0.6])], gaps: [R.range(10, 80)], hold: false, g };
    case 'toggle': return { k: 'toggle', id: R.pick(['tja', 'tgl', 'tex']), g };
    case 'hide': return { k: 'hide', ms: R.range(200, 5000), g };
    // 「一覧」の確かめで迷う時間（その間ページのスクリプトは止まり、動画だけが進む）
    case 'back': return { k: 'back', stall: R.chance(0.3) ? R.range(200, 3000) : 0, g };
    case 'backCancel': return { k: 'back', cancel: true, stall: R.chance(0.6) ? R.range(200, 4000) : 0, g };
    case 'stall': return { k: 'stall', ms: R.chance(0.5) ? R.range(100, 900) : R.range(900, 5000), pause: R.chance(0.4) ? r2(R.range(0.2, 0.9)) : 0, g };
    default: return { k: kind, g };
  }
}
function execOp(ss, op) {
  // 環境の揺れ（イベントの遅れ・シークの時間）は手ごとに種を決め直す。縮める時に他の手を抜いても、残った手の揺れが変わらない
  if (op.i != null) ss.R = rng(subSeed(ss.seed ^ 0x2545F491, op.i));
  if (op.g === 'pipe') ss.advanceToPipe(3000); else if (op.g) ss.advance(op.g);
  if (ss.halted()) return;
  switch (op.k) {
    case 'wait': ss.advance(op.ms); break;
    case 'open': ss.openOp(); break;
    case 'pick': ss.pickOp(op.broken); break;
    case 'back': ss.backOp(!!op.cancel, op.stall || 0); break;
    case 'stall': ss.rafStallOp(op.ms, op.pause || 0); break;
    case 'tap': ss.tapOp(op.row); break;
    case 'nav': ss.navOp(op.id); break;
    case 'dbl':
      if (op.d) ss.stat.slowDbl++; else ss.stat.fastDbl++;
      ss.navOp(op.id); if (op.d) ss.advance(op.d); if (!ss.halted()) ss.navOp(op.id);
      break;
    case 'step': ss.stepOp(); break;
    case 'play': ss.playOp(); break;
    case 'pause': ss.pauseOp(); break;
    case 'scrub': ss.scrubOp(op.ts, op.gaps, op.hold); break;
    case 'speed': ss.click('speed'); break;
    case 'toggle': ss.click(op.id); break;
    case 'hide': ss.hideOp(op.ms); break;
    case 'resume': ss.resumeOp(); break;
    case 'fail': ss.failOp(); break;
    default: throw new Error('知らない操作 ' + op.k);
  }
}
const opText = (op) => {
  const g = op.g === 'pipe' ? '[内部処理の直後] ' : op.g ? '[' + Math.round(op.g) + 'ms] ' : '';
  const rest = Object.entries(op).filter(([k]) => k !== 'k' && k !== 'g' && k !== 'i')
    .map(([k, v]) => k + '=' + (Array.isArray(v) ? '[' + v.map((x) => (typeof x === 'number' ? fx(x / (k === 'gaps' ? 1000 : 1)) : x)).join(',') + ']' : typeof v === 'number' ? (k === 'ms' || k === 'd' || k === 'stall' ? Math.round(v) + 'ms' : v) : v));
  return g + op.k + (rest.length ? ' ' + rest.join(' ') : '');
};

async function fuzzRun(html, kind, seed, nOps, o = {}) {
  const data = genData(seed, kind);
  const ss = await Session.create(html, data, seed, o);
  const R = rng(subSeed(seed, kind === 'clean' ? 0x0b5 : 0x0b7));
  if (o.keepGoing) ss.stopOnViol = false;
  let n = 0;
  while (n < nOps && !ss.halted()) {
    const op = genOp(ss, R);
    op.i = n;
    execOp(ss, op);
    ss.ops.push(op);
    n++;
  }
  ss.dom.window.close();
  return { ss, n };
}
async function replay(html, kind, seed, ops, o = {}) {
  const ss = await Session.create(html, genData(seed, kind), seed, o);
  for (const op of ops) { if (ss.halted()) break; execOp(ss, op); ss.ops.push(op); }
  ss.dom.window.close();
  return ss;
}
async function shrink(html, kind, seed, ops, code, o = {}, budget = 400) {
  let cur = ops.slice(), tries = 0;
  const still = async (cand) => { tries++; const ss = await replay(html, kind, seed, cand, o); return ss.viol && ss.viol.code === code ? ss : null; };
  let chunk = Math.max(1, Math.floor(cur.length / 2));
  while (chunk >= 1 && tries < budget) {
    let changed = false;
    for (let i = 0; i + chunk <= cur.length && tries < budget;) {
      const cand = cur.slice(0, i).concat(cur.slice(i + chunk));
      const ss = await still(cand);
      if (ss) { cur = cand.slice(0, ss.ops.length); changed = true; } else i += chunk;
    }
    if (!changed) chunk = Math.floor(chunk / 2);
  }
  // 待ち時間を詰める
  for (let i = 0; i < cur.length && tries < budget; i++) {
    for (const key of ['g', 'ms']) {
      if (typeof cur[i][key] !== 'number' || cur[i][key] <= 100) continue;
      const cand = cur.slice(); cand[i] = Object.assign({}, cand[i], { [key]: 100 });
      if (await still(cand)) cur = cand;
    }
  }
  const ss = await replay(html, kind, seed, cur, o);
  return { ops: cur, viol: ss.viol, tries };
}

// ---------------------------------------------------------------- 症状のシナリオ（S1〜S4 は元の 4 つの症状、X は追加）
// 行 0: 0.02-1.62（最初の行が 0 秒の近く）、行 2→3・4→5・5→6・6→7 は隙間 0、動画は 24 秒
const SCN_CUES = (() => {
  const durs = [1.6, 1.4, 2.0, 1.2, 1.8, 1.5, 1.7, 1.3, 2.2, 1.6, 1.4, 1.9];
  const gaps = [0.4, 0.1, 0, 0.3, 0, 0, 0, 0.6, 0, 0.2, 0];
  const c = []; let s = 0.02;
  for (let i = 0; i < durs.length; i++) { const e = r2(s + durs[i]); c.push({ s: r2(s), e }); s = r2(e + (gaps[i] || 0)); }
  return c;
})();
const SCN_DATA = { kind: 'clean', seed: 0, id: 'scenario', cues: SCN_CUES, duration: 24 };
// 重なる行と入れ子の行（実データでは 189 行中 12 か所と 1 か所）。行 3 は行 2 の終わりより前に始まり、行 6 は行 5 の中に収まる
// （行 6 の止める点 14.54 が行 5 の止める点 14.76 より前）。重なりがあるので kind は real（INV2 は字句どおりには成り立たない）
const OVL_DATA = { kind: 'real', seed: 0, id: 'scenario-overlap', duration: 22, cues: [
  { s: 0.5, e: 2.0 }, { s: 2.5, e: 4.0 }, { s: 5.0, e: 7.5 }, { s: 7.3, e: 9.0 }, { s: 10.0, e: 11.0 },
  { s: 12.0, e: 14.76 }, { s: 14.11, e: 14.29 }, { s: 16.0, e: 17.5 }, { s: 18.0, e: 19.0 },
] };

async function scnSession(html, o = {}) {
  const { data = SCN_DATA, ...rest } = o;
  const ss = await Session.create(html, data, 1, Object.assign({ det: true, srcMode: 'chromium', stopOnViol: false }, rest));
  ss.openOp(); ss.advance(100); ss.pickOp(false);
  ss.runUntil(() => ss.m.loaded, 3000); ss.advance(100);
  return ss;
}
const evWait = (ss, type, maxMs = 3000) => { const n0 = ss.evc[type] || 0; return ss.runUntil(() => (ss.evc[type] || 0) > n0, maxMs); };
const colorsDuring = (ss) => { const seen = []; ss.onCheck = () => { if (ss.m.open) { const c = ss.probe().cur; if (seen[seen.length - 1] !== c) seen.push(c); } }; return seen; };
const stoppedRow = (ss) => (ss.media.paused ? ss.probe().stoppedAt : null);
function reopenAndPick(ss) {
  ss.backOp(); ss.advance(300); ss.openOp(); ss.advance(200); ss.pickOp(false);
  ss.runUntil(() => ss.m.loaded, 3000); ss.advance(100);
}

const SCENARIOS = [
  { id: 'S1', name: '行の頭へ飛んだ直後に「1行ずつ」をオン → その行の終わりで止まる（頭で止まって色が 1 つ前に戻らない）', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(5); evWait(ss, 'seeked'); ss.advance(40);
    const pre = ss.media.currentTime < SCN_CUES[5].s;
    const seen = colorsDuring(ss);
    ss.stepOp();
    ss.runUntil(() => ss.media.paused, 6000);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    const ok = pre && r === 5 && ss.probe().cur === 5 && !seen.includes(4);
    return { ss, ok, detail: (pre ? '' : '巻き戻し中に押せなかった。') + '止めた行 ' + r + '（時刻 ' + fx(t) + '、行 5 の終わり ' + fx(ss.sp.endPoint(5)) + '）、色の行の推移 ' + seen.join('→') };
  } },
  { id: 'S2', name: '行をタップしてすぐ離れる（一覧へ／アプリを離れる／保存の間引き中に落ちる）→「続きから」がその行から', async run(html) {
    // 離れた直後の保存値が指す行（症状の仕組みそのもの）と、開き直して「続きから」を押した時の行（通しの結果）の両方を見る
    const out = [];
    let first = null;
    const stored = (ss) => { const raw = ss.w.localStorage.getItem('sp:t:' + SCN_DATA.id); return raw === null ? 0 : JSON.parse(raw); };
    for (const how of ['一覧へ', 'アプリを離れる', '落ちる']) {
      const ss = await scnSession(html);
      first = first || ss;
      ss.tapOp(5); evWait(ss, 'seeked');
      if (how === '落ちる') {
        ss.advance(1500);               // 巻き戻しは終わったが、次の間引き保存（3 秒）の前に、離れる処理なしで落ちる
        const t0 = stored(ss);
        out.push({ how, t0, saved: ss.sp.cueAt(t0), resumed: ss.sp.cueAt(t0), viols: ss.viols });
        continue;
      }
      ss.advance(50);
      if (how === 'アプリを離れる') { ss.hideOp(800); } else { ss.backOp(); }
      const t0 = stored(ss), saved = ss.sp.cueAt(t0);
      if (how === 'アプリを離れる') ss.backOp();
      ss.advance(300); ss.openOp(); ss.advance(200); ss.pickOp(false); ss.runUntil(() => ss.m.loaded, 3000); ss.advance(100);
      const offered = !!ss.offerButton();
      if (offered) ss.resumeOp();
      out.push({ how, t0, saved, resumed: offered ? ss.probe().cur : null, viols: ss.viols });
    }
    const ok = out.every((x) => x.saved === 5 && x.resumed === 5);
    const viols = out.flatMap((x) => x.viols);
    return { ss: first, viols, ok, detail: out.map((x) => x.how + ': 保存 ' + fx(x.t0) + '（' + x.saved + ' 行目）→ 続きから ' + (x.resumed == null ? '出ない' : x.resumed + ' 行目')).join(' / ') };
  } },
  { id: 'S3', name: '「次」を素早く 2 度押す → 2 つ先の行（1 つ前に戻らない。1行ずつならその行の終わりで止まる）', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(4); ss.advance(1000);
    const seen = colorsDuring(ss);
    ss.navOp('next'); ss.navOp('next');
    ss.advance(1200);
    const okFree = ss.probe().cur >= 6 && !seen.slice(1).some((c) => c < 6);
    const ss2 = await scnSession(html);
    ss2.stepOp(); ss2.tapOp(4); ss2.runUntil(() => ss2.media.paused, 6000);
    const first = stoppedRow(ss2);
    ss2.navOp('next'); ss2.navOp('next');
    ss2.advance(200); ss2.runUntil(() => ss2.media.paused, 8000);
    const r = stoppedRow(ss2);
    return { ss, viols: ss.viols.concat(ss2.viols), ok: okFree && first === 4 && r === 6,
      detail: '1行ずつオフ: 色の行の推移 ' + seen.join('→') + ' / 1行ずつオン: 4 行目で止めた後に 2 度押し → ' + r + ' 行目で止まった（期待 6）' };
  } },
  { id: 'S4', name: '「1行ずつ」オンのまま開き直し、行に触らず ▶ → 最初の行の終わりで止まる', async run(html) {
    const ss = await scnSession(html);
    ss.stepOp(); ss.advance(200);
    reopenAndPick(ss);
    ss.playOp();
    ss.runUntil(() => ss.media.paused, 6000);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    return { ss, ok: r === 0 && t < 2.2, detail: ss.media.paused ? r + ' 行目で止まった（時刻 ' + fx(t) + '、行 0 の終わり ' + fx(ss.sp.endPoint(0)) + '）' : '6 秒たっても止まらない（時刻 ' + fx(t) + '）' };
  } },
  // ---- 追加（前回位置・読み込み直し・見終わり・素早い 2 度押し・シーク中の画面の書き換えの経路）
  { id: 'X1', name: '動画を選んだだけで一覧へ戻っても、前回位置（続きから）が消えない', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(7); ss.advance(1000); reopenAndPick(ss);
    const before = ss.m.offerT;
    reopenAndPick(ss);
    const after = ss.offerButton() ? ss.m.offerT : null;
    return { ss, ok: before != null && after != null && Math.abs(after - before) < EPS, detail: '1 回目の「続きから」' + fx(before) + '、選んだだけで戻った後 ' + (after == null ? '無し' : fx(after)) };
  } },
  { id: 'X2', name: '動画を選んだだけでアプリを離れても、前回位置が消えない', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(7); ss.advance(1000); reopenAndPick(ss);
    const before = ss.m.offerT;
    ss.hideOp(800);
    const raw = ss.w.localStorage.getItem('sp:t:' + SCN_DATA.id), t0 = raw === null ? 0 : JSON.parse(raw);
    return { ss, ok: before != null && Math.abs(t0 - before) < EPS, detail: '離れる前の前回位置 ' + fx(before) + '、離れた後の保存値 ' + fx(t0) };
  } },
  { id: 'X3', name: '再生できなくなって選び直しても、前回位置が消えない', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(7); ss.advance(1000); reopenAndPick(ss);
    const before = ss.m.offerT;
    ss.resumeOp(); ss.advance(1000); ss.failOp(); evWait(ss, 'error'); ss.advance(100);
    ss.pickOp(false); ss.runUntil(() => ss.m.loaded, 3000); ss.advance(50);
    const after = ss.offerButton() ? ss.m.offerT : null;
    return { ss, ok: before != null && after != null && Math.abs(after - before) < 3.5, detail: '選び直す前の前回位置 ' + fx(before) + '、選び直した後の「続きから」' + (after == null ? '無し' : fx(after)) };
  } },
  { id: 'X4', name: '最初の行（0.02 秒）へ飛んだ後、シークバーの左端（0 秒）へ戻して ▶ → 1行ずつが最初の行で止まる（印を消し忘れる罠）', async run(html) {
    const ss = await scnSession(html);
    ss.stepOp(); ss.tapOp(0); ss.runUntil(() => ss.media.paused, 5000);
    const a = stoppedRow(ss);
    ss.playOp(); ss.advance(100); ss.runUntil(() => ss.media.paused, 5000);
    const b = stoppedRow(ss);
    ss.scrubOp([0], [30], false); evWait(ss, 'seeked'); ss.advance(50);
    ss.playOp(); ss.advance(100); ss.runUntil(() => ss.media.paused, 6000);
    const c = stoppedRow(ss);
    // 見終わった後の ▶（Seek(0)）でも同じ
    const ss2 = await scnSession(html);
    ss2.tapOp(0); ss2.advance(200); ss2.scrubOp([23.5], [20], false); ss2.runUntil(() => ss2.media.paused && ss2.media.position() >= 24 - EPS, 3000);
    ss2.advance(100); ss2.stepOp(); ss2.playOp(); ss2.advance(100); ss2.runUntil(() => ss2.media.paused, 6000);
    const d = stoppedRow(ss2);
    return { ss, viols: ss.viols.concat(ss2.viols), ok: a === 0 && b === 1 && c === 0 && d === 0,
      detail: '0 行目で止まる ' + a + '、続けて 1 行目 ' + b + '、左端へ戻して ▶ → ' + c + ' 行目で止まった / 見終わって ▶ → ' + d + ' 行目' };
  } },
  { id: 'X5', name: '「もう一度」を素早く 2 度押す → 同じ行のまま（1 つ前に戻らない）', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(5); ss.advance(1000);
    const seen = colorsDuring(ss);
    ss.navOp('again'); ss.navOp('again');
    ss.advance(600);
    return { ss, ok: !seen.slice(1).some((c) => c < 5) && ss.probe().cur >= 5, detail: '色の行の推移 ' + seen.join('→') };
  } },
  { id: 'X6', name: '「1行ずつ」で再生中にシークバーで先へ飛び、seeking が届く前に画面の書き換えが来ても止めない（遠くへ／止める点のすぐ先へ）', async run(html) {
    // 止める点のすぐ先（LATE 秒未満）への飛びは、tick の !v.seeking だけが止めを防ぐ（遠くへの飛びは LATE の引き直しでも防がれる）
    const go = async (target, want) => {
      const ss = await scnSession(html);
      ss.stepOp(); ss.tapOp(2); evWait(ss, 'seeked'); ss.advance(500);
      ss.forceDelay = 25;                // seeking が届く前に rAF が回る
      ss.scrubOp([target], [0], false);
      ss.forceDelay = null;
      ss.runUntil(() => ss.media.paused, 6000);
      const r = stoppedRow(ss), t = ss.media.currentTime;
      return { ss, ok: r === want && t >= ss.sp.endPoint(want) - EPS,
        text: fx(target) + ' へ → ' + (ss.media.paused ? r + ' 行目で止まった（時刻 ' + fx(t) + '、期待は ' + want + ' 行目の終わり ' + fx(ss.sp.endPoint(want)) + '）' : '止まらない') };
    };
    const a = await go(16.5, 9), b = await go(r2(spec(SCN_CUES).endPoint(2) + 0.2), 3);
    return { ss: a.ss, viols: a.ss.viols.concat(b.ss.viols), ok: a.ok && b.ok, detail: a.text + ' / ' + b.text };
  } },
  // このハーネスで見つかったもの（index.html は seeked で「1行ずつ」の停止後は tick しない形で直した）:
  // シークの完了から seeked が届くまでの間に画面の書き換えが入り、そこで「1行ずつ」が止めると、遅れて届いた seeked の tick() が
  // 色を次の行へ動かす（INV3 の違反）
  { id: 'X8', name: '「1行ずつ」で再生中、止める点の 10ms 手前へシークし、seeked が遅れて届く → 止めた行に色が残る', async run(html) {
    const ss = await scnSession(html);
    ss.stepOp(); ss.tapOp(3); evWait(ss, 'seeked'); ss.advance(300);   // 3 行目を再生中（止める行 3）
    ss.forceDelay = 30;                                                   // 混んでいて、積んだイベントが 30ms 遅れる
    ss.scrubOp([r2(ss.sp.endPoint(4) - 0.01)], [0], false);              // 4 行目の止める点（8.82）の 10ms 手前
    evWait(ss, 'seeked');
    ss.forceDelay = null;
    ss.advance(100);
    const p = ss.probe();
    return { ss, ok: ss.media.paused && p.stoppedAt === 4 && p.cur === 4,
      detail: (ss.media.paused ? p.stoppedAt + ' 行目で止まり、色の行は ' + p.cur : '止まらない') + '（時刻 ' + fx(ss.media.currentTime) + '、4 行目の止める点 ' + fx(ss.sp.endPoint(4)) + '）' };
  } },
  { id: 'X7', name: '「1行ずつ」で止めた後に読めなくなり選び直して ▶ → 新しい動画の最初の行で止まる（前の動画の止める行が残らない）', async run(html) {
    const ss = await scnSession(html);
    ss.stepOp(); ss.tapOp(7); ss.runUntil(() => ss.media.paused, 6000);
    ss.failOp(); evWait(ss, 'error'); ss.advance(100);
    ss.pickOp(false); ss.runUntil(() => ss.m.loaded, 3000); ss.advance(100);
    ss.playOp(); ss.advance(100); ss.runUntil(() => ss.media.paused, 8000);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    return { ss, ok: r === 0, detail: ss.media.paused ? r + ' 行目で止まった（時刻 ' + fx(t) + '）' : '止まらない（時刻 ' + fx(t) + '）' };
  } },
  // ---- 重なる行・入れ子の行・rAF だけが止まる場合
  { id: 'X9', name: '「1行ずつ」で、次の行が今の行の終わりより前に始まる（重なる）→ 色は次の行へ移らず、今の行の終わりで止まる', async run(html) {
    const ss = await scnSession(html, { data: OVL_DATA });
    ss.stepOp(); ss.tapOp(2);
    const seen = colorsDuring(ss);
    ss.runUntil(() => ss.media.paused, 8000); ss.advance(100);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    return { ss, ok: r === 2 && ss.probe().cur === 2 && !seen.includes(3),
      detail: (ss.media.paused ? r + ' 行目で止まった' : '止まらない') + '（時刻 ' + fx(t) + '、2 行目の止める点 ' + fx(ss.sp.endPoint(2)) +
        '、3 行目の頭 ' + fx(OVL_DATA.cues[3].s) + '）、色の行の推移 ' + seen.join('→') };
  } },
  { id: 'X10', name: '「1行ずつ」で、前の行の中に収まった短い行 → 前の行で止めた後の ▶ 1 回で、その次の行の終わりまで進む（「次」ならその短い行へ）', async run(html) {
    const ss = await scnSession(html, { data: OVL_DATA });
    ss.stepOp(); ss.tapOp(5); ss.runUntil(() => ss.media.paused, 8000); ss.advance(100);
    const a = stoppedRow(ss);
    ss.playOp(); ss.advance(100); ss.runUntil(() => ss.media.paused, 8000); ss.advance(100);
    const b = stoppedRow(ss), tb = ss.media.currentTime;
    const ss2 = await scnSession(html, { data: OVL_DATA });
    ss2.stepOp(); ss2.tapOp(5); ss2.runUntil(() => ss2.media.paused, 8000); ss2.advance(100);
    ss2.navOp('next'); ss2.advance(100); ss2.runUntil(() => ss2.media.paused, 8000); ss2.advance(100);
    const c = stoppedRow(ss2);
    return { ss, viols: ss.viols.concat(ss2.viols), ok: a === 5 && b === 7 && c === 6,
      detail: '5 行目で止まる ' + a + '、▶ 1 回で ' + b + ' 行目で止まった（時刻 ' + fx(tb) + '、7 行目の止める点 ' + fx(ss.sp.endPoint(7)) +
        '）/ 5 行目で止めて「次」→ ' + c + ' 行目で止まった（期待 6）' };
  } },
  { id: 'X11', name: '「1行ずつ」で再生中に画面の書き換え（rAF）だけが 4 秒止まる（全画面・ピクチャインピクチャ）→ 古い行で止めず、今の行の終わりで止まる', async run(html) {
    const ss = await scnSession(html);
    ss.stepOp(); ss.tapOp(3); ss.advance(400);                 // 3 行目（止める点 7.02）を再生中
    const seen = colorsDuring(ss);
    ss.visible = false; ss.advance(4000); ss.visible = true;   // rAF だけが止まる。動画は止めず、visibilitychange も出さない
    const t1 = ss.media.currentTime, want = ss.sp.stopRowAt(t1);
    ss.advance(50);
    const keep = !ss.media.paused;
    ss.runUntil(() => ss.media.paused, 6000); ss.advance(50);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    return { ss, ok: keep && r === want && !seen.slice(1).some((c) => c < want),
      detail: '戻った時刻 ' + fx(t1) + '（' + ss.sp.cueAt(t1) + ' 行目）で' + (keep ? '止めずに続け、' : 'すぐ止まり、') + r + ' 行目で止まった（期待 ' + want +
        '、時刻 ' + fx(t) + '）、色の行の推移 ' + seen.join('→') };
  } },
  // ---- 「一覧」の確かめ（confirm）と、見始めると「続きから」の案内を消す作り
  // 確かめのダイアログを読んで迷う間は、ページのスクリプトが止まり、動画だけが進む（WebKit の WPE で 3 秒迷うと 3.0〜3.7 秒進んだ。
  // iPhone では確かめていない）。ページは確かめの前に再生中の動画を止め、キャンセルなら再生に戻す。止めないと、迷う間に止める点を
  // 過ぎ、0.5 秒以上過ぎた時はその行では止まらず次の行の終わりで止まる（LATE の引き直し）
  { id: 'X12', name: '「1行ずつ」で再生中に「一覧」→ 確かめで迷ってキャンセル → 一覧へ戻らず、迷う間は動画が止まっていて、キャンセルで再生に戻り、迷った時間によらず今の行の終わりで止まる', async run(html) {
    const end3 = spec(SCN_CUES).endPoint(3);
    const go = async (stallMs) => {
      const ss = await scnSession(html);
      ss.stepOp(); ss.tapOp(3); evWait(ss, 'seeked'); ss.advance(300);   // 3 行目を再生中（止める行 3、止める点 6.97）
      const seen = colorsDuring(ss), asked0 = ss.confirmCalls, t0 = ss.media.currentTime;
      ss.backOp(true, stallMs);
      const asked = ss.confirmCalls - asked0, { saves, t: t1, ranDuring, playingAfter } = ss.backClick;
      const open = !ss.$('playerView').hidden && !!ss.probe().hasVideo, resumed = open && playingAfter;
      if (resumed) { ss.runUntil(() => ss.media.paused, 8000); ss.advance(50); }
      const r = resumed ? stoppedRow(ss) : null;
      const ok = asked === 1 && open && !ranDuring && Math.abs(t1 - t0) < EPS && resumed && saves === 0 && r === 3 && !seen.slice(1).some((c) => c < seen[0]);
      const parts = [(stallMs / 1000) + ' 秒迷う → 確かめ ' + asked + ' 回'];
      if (asked) parts.push('迷う間の動画は' + (ranDuring ? '進む（' + fx(t0) + ' → ' + fx(t1) + '、止める点 ' + fx(end3) + '）' : '止まっている'));
      if (!open) parts.push('一覧へ戻った');
      else {
        parts.push(resumed ? 'キャンセルの後も再生中で、' + (r == null || r < 0 ? '止まらない' : r + ' 行目で止まった（期待 3）') : 'キャンセルしても再生に戻らない');
        parts.push('色の行の推移 ' + seen.join('→'));
        if (saves) parts.push('キャンセルの間に前回位置を ' + saves + ' 回書いた');
      }
      return { ss, ok, text: parts.join('、') };
    };
    const runs = [await go(0), await go(1500), await go(2500), await go(4000)];
    return { ss: runs[0].ss, viols: runs.flatMap((x) => x.ss.viols), ok: runs.every((x) => x.ok), detail: runs.map((x) => x.text).join(' / ') };
  } },
  // X11 は戻った時刻が行の途中。行の終わりの後の隙間（次の行の頭の前）で戻った時は、その行の止める点をもう過ぎているので、
  // 引き直した止める行は次の行（隙間の行で遅れて止まり、色が戻るのは誤り）
  { id: 'X14', name: '「1行ずつ」で再生中に画面の書き換え（rAF）だけが止まり、行の終わりの後の隙間で戻る → その行では止めず、次の行の終わりで止まる', async run(html) {
    const ss = await scnSession(html);
    const sp = ss.sp, back = r2((sp.endPoint(7) + sp.cues[8].s) / 2);   // 7 行目の止める点 13.57 と 8 行目の頭 13.92 の間
    ss.stepOp(); ss.tapOp(6); evWait(ss, 'seeked'); ss.advance(200);     // 6 行目（止める点 12.02）を再生中
    const seen = colorsDuring(ss);
    const ms = (back - ss.media.currentTime) * 1000;
    ss.visible = false; ss.advance(ms); ss.visible = true;              // rAF だけが止まる。動画は止めず、visibilitychange も出さない
    const t1 = ss.media.currentTime;
    ss.runUntil(() => ss.media.paused, 6000); ss.advance(50);
    const r = stoppedRow(ss), t = ss.media.currentTime;
    return { ss, ok: t1 >= sp.endPoint(7) && t1 < sp.cues[8].s && r === 8 && seen.every((c, i) => i === 0 || c >= seen[i - 1]),
      detail: '戻った時刻 ' + fx(t1) + '（7 行目の止める点 ' + fx(sp.endPoint(7)) + ' と 8 行目の頭 ' + fx(sp.cues[8].s) + ' の間）→ ' +
        (ss.media.paused ? r + ' 行目で止まった（期待 8、時刻 ' + fx(t) + '）' : '止まらない') + '、色の行の推移 ' + seen.join('→') };
  } },
  // 行をタップした直後（巻き戻し中）に画面の書き換えが止まり、その行の止める点を少し（LATE 未満）過ぎて戻ると、1 回の tick で
  // 巻き戻しの終わりと止める点を両方越える。止める処理が return する前に巻き戻しの印（holdUntil）を消さないと、印が残る（INV1）。
  // 変更前の版（138a326）は消さない
  { id: 'X15', name: '「1行ずつ」で行をタップした直後に画面の書き換え（rAF）が止まり、その行の止める点を 0.5 秒未満過ぎて戻る → その行で止まり、巻き戻しも終わっている', async run(html) {
    const ss = await scnSession(html);
    const sp = ss.sp, back = r2(sp.endPoint(4) + 0.13);                 // 4 行目の止める点 8.82 の 0.13 秒後
    ss.stepOp(); ss.tapOp(4); evWait(ss, 'seeked');                       // 4 行目の頭 7.02 の手前（6.77）から再生中
    const pre = ss.probe().holdUntil >= 0;
    ss.rafStallOp((back - ss.media.currentTime) * 1000);                  // 戻った後の 1 回目の tick で止まる
    ss.advance(50);
    const p = ss.probe(), r = stoppedRow(ss);
    return { ss, ok: pre && ss.media.paused && r === 4 && p.cur === 4 && p.holdUntil < 0,
      detail: (pre ? '' : '巻き戻し中に止められなかった。') + (ss.media.paused ? r + ' 行目で止まった' : '止まらない') + '（時刻 ' + fx(ss.media.currentTime) +
        '、4 行目の止める点 ' + fx(sp.endPoint(4)) + '）、色の行 ' + p.cur + '、止める行 ' + p.stopIdx + '、巻き戻しの終わり ' + fx(p.holdUntil) };
  } },
  // X11 は戻った時も再生中。止まっている間に一時停止すると（全画面・ピクチャインピクチャの操作、見終わる）、pause が rAF を
  // 取り消すだけだと tick が回らず、色が止まる前の行のまま残り、「もう一度」「前」「次」がその古い行を基準に動く。ページは pause でも
  // seeked と同じく tick する（変更前の版はしない）
  { id: 'X16', name: '再生中に画面の書き換え（rAF）が止まり、その間に一時停止する（全画面・ピクチャインピクチャの操作）→ 戻った時、色は止めた時刻の行で、「もう一度」はその行から', async run(html) {
    const ss = await scnSession(html);
    ss.tapOp(3); evWait(ss, 'seeked'); ss.advance(300);                 // 3 行目（5.52〜6.72）を再生中。1行ずつはオフ
    ss.rafStallOp(3000, 0.5);                                            // 1.5 秒後（4 行目 7.02〜の中）で一時停止し、さらに 1.5 秒で戻る
    ss.advance(100);
    const t = ss.media.currentTime, want = ss.sp.cueAt(t), c1 = ss.probe().cur;
    ss.navOp('again'); ss.advance(100);
    const c2 = ss.probe().cur;
    return { ss, ok: ss.sp.cueAt(t) === 4 && c1 === want && c2 === want,
      detail: '止めた時刻 ' + fx(t) + '（' + want + ' 行目）、戻った時の色の行 ' + c1 + '、「もう一度」で ' + c2 + ' 行目から（期待 ' + want + '）' };
  } },
  // X16 の「1行ずつ」オン版。オンの間は色が止める行で頭打ちになるので、pause の tick で色を合わせるだけでは足りない。止める点を
  // LATE 以上過ぎてから一時停止した時は、止める行も時刻から引き直す（引き直さないと、色が古い止める行のまま残り、次に ▶ を押した
  // 時の tick で初めて直る）。LATE 未満なら、止めるはずだった行のまま（止める処理はしないので、次の ▶ ですぐその行で止まる）。変更前の版も、
  // X16 を直した後の版（pause で tick するが、止まっている tick では引き直さない）も、LATE 以上の 2 つで落ちる
  { id: 'X17', name: '「1行ずつ」で再生中に画面の書き換え（rAF）が止まり、止める点を過ぎてから一時停止する → 戻った時、色は止めた時刻の行（LATE 未満なら止めるはずだった行）で、「もう一度」はその行から', async run(html) {
    const out = [];
    // 3 行目の頭の手前（5.27）から再生し、0.3 秒後に rAF が止まる。止める点 6.97 の 0.6 秒後（4 行目）・2.2 秒後（5 行目）・0.2 秒後で一時停止
    for (const [ms, at] of [[4000, 0.5], [6000, 0.6], [3200, 0.5]]) {
      const ss = await scnSession(html);
      ss.stepOp(); ss.tapOp(3); evWait(ss, 'seeked'); ss.advance(300);
      ss.rafStallOp(ms, at);
      ss.advance(100);
      const sp = ss.sp, t = ss.media.currentTime, late = t >= sp.endPoint(3) + LATE, paused = ss.media.paused;
      const want = late ? sp.cueAt(t) : 3, p = ss.probe();
      ss.navOp('again'); ss.advance(100);
      const c2 = ss.probe().cur;
      out.push({ ss, ok: paused && t > sp.endPoint(3) && p.cur === want && p.stopIdx === (late ? sp.stopRowAt(t) : 3) && c2 === want,
        text: '止めた時刻 ' + fx(t) + '（' + sp.cueAt(t) + ' 行目、3 行目の止める点 ' + fx(sp.endPoint(3)) + ' の ' + fx(t - sp.endPoint(3)) + ' 秒後）、戻った時の色の行 ' +
          p.cur + '・止める行 ' + p.stopIdx + '、「もう一度」で ' + c2 + ' 行目から（期待 ' + want + '）' });
    }
    return { ss: out[0].ss, viols: out.flatMap((x) => x.ss.viols), ok: out.every((x) => x.ok), detail: out.map((x) => x.text).join(' / ') };
  } },
  // 「続きから」の案内は、行・前・次・もう一度・続きから で見始めた時だけ消す。動画の ▶ でも消すと、その後の一時停止か 3 秒の
  // 再生で前回位置が上書きされ、前回の行へ戻る手段が無くなる（案内に出ていた時刻も消える）。変更前の版は、どの始め方でも
  // 案内が残る（行をタップして見始めた後も、動画の下で高さを取り続ける）
  { id: 'X13', name: '「続きから」の案内が出ている時に、動画の ▶ で頭から見始めてしまう → 案内は残り、「続きから」で前回の行へ戻れる（押すと消える）。行のタップ・「次」で見始めると消える', async run(html) {
    const out = [];
    for (const ms of [500, 3500]) {
      const ss = await scnSession(html, { presetT: 12.71 });   // 前の日に 7 行目まで見たアプリを開き、動画を選んだところ
      const before = ss.m.offerT;
      ss.playOp(); ss.advance(ms); ss.pauseOp(); ss.advance(100);
      const b = ss.offerButton();
      const raw = ss.w.localStorage.getItem('sp:t:' + SCN_DATA.id), t0 = raw === null ? 0 : JSON.parse(raw);
      let resumed = null, gone = false;
      if (b) { ss.resumeOp(); ss.advance(300); resumed = ss.probe().cur; gone = !ss.offerButton(); }
      const want = before == null ? null : ss.sp.cueAt(before);
      out.push({ ss, text: '▶ で ' + (ms / 1000) + ' 秒見て一時停止 → 「続きから」' + (b ? 'あり（押すと ' + resumed + ' 行目、案内は' + (gone ? '消える' : '残る') + '）' : '無し') +
        '、保存値 ' + fx(t0) + '（' + ss.sp.cueAt(t0) + ' 行目）', ok: want != null && !!b && resumed === want && gone });
    }
    // 行のタップ・「次」で見始めると、案内は消える（動画の下で高さを取り、背の高い行が下端の帯に隠れる）
    for (const how of ['tap', 'next']) {
      const ss = await scnSession(html, { presetT: 12.71 });
      const had = !!ss.offerButton();
      if (how === 'tap') ss.tapOp(2); else ss.navOp('next');
      ss.advance(300);
      const gone = !ss.offerButton();
      out.push({ ss, text: (how === 'tap' ? '行のタップ' : '「次」') + 'で見始める → 案内は' + (had ? (gone ? '消える' : '残る') : '初めから無い'), ok: had && gone });
    }
    return { ss: out[0].ss, viols: out.flatMap((x) => x.ss.viols), ok: out.every((x) => x.ok),
      detail: '前回位置 ' + fx(12.71) + '（' + spec(SCN_CUES).cueAt(12.71) + ' 行目）。' + out.map((x) => x.text).join(' / ') };
  } },
];

async function runScenarios(html, quiet) {
  const rows = [];
  for (const sc of SCENARIOS) {
    let res;
    try { res = await sc.run(html); } catch (e) { res = { ok: false, detail: '例外: ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' | '), viols: [] }; }
    const viols = res.viols || (res.ss ? res.ss.viols : []);
    const codes = [...new Set(viols.map((v) => v.code))];
    rows.push({ id: sc.id, name: sc.name, ok: res.ok, pending: !!sc.pending, detail: res.detail, codes, firstViol: viols[0] });
    if (!quiet) {
      const verdict = res.ok ? '期待どおり' : sc.pending ? '判断待ち（今の作りでは期待と違う。終了コードに数えない）' : '症状あり';
      console.log('  ' + sc.id + ' ' + verdict + (codes.length ? '・違反 ' + codes.join(',') : '・違反なし') + '  ' + sc.name);
      console.log('       ' + res.detail);
      if (viols[0]) console.log('       最初の違反 ' + viols[0].code + ': ' + viols[0].msg);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- 変異（作業ツリーをわざと壊す）
const MUTANTS = [
  { name: 'first-fix', note: '印を seeked で消さない（最初に考えた直し方の版）', edits: [['if (!v.seeking) seekTo = -1;', '']] },
  { name: 'step-cueAt', note: '「1行ずつ」の入切で、巻き戻し中も時刻から行を引く', edits: [['c = holdUntil >= 0 ? cur : cueAt(t);', 'c = cueAt(t);']] },
  { name: 'stopIdx-minus1', note: '止める行の初期値・開き直し・選び直しを -1 に戻す', edits: [['let stopIdx = 0;', 'let stopIdx = -1;'],
    ['cur = -1; holdUntil = -1; stopIdx = 0; stoppedAt = -1; seekTo = -1; setFollow(true);', 'cur = -1; holdUntil = -1; stopIdx = -1; stoppedAt = -1; seekTo = -1; setFollow(true);'],
    ['stopIdx = 0; stoppedAt = -1; holdUntil = -1; seekTo = -1; moved = false;', 'stopIdx = -1; stoppedAt = -1; holdUntil = -1; seekTo = -1; moved = false;']] },
  { name: 'clearVideo-keeps-stopIdx', note: '動画の選び直しで止める行を戻さない（開き直しでは戻る）', edits: [['stopIdx = 0; stoppedAt = -1; holdUntil = -1; seekTo = -1; moved = false;', 'stoppedAt = -1; holdUntil = -1; seekTo = -1; moved = false;']] },
  { name: 'tick-no-seeking', note: 'tick の停止判定から !v.seeking を外す', edits: [['if (step && !v.seeking && stopIdx >= 0', 'if (step && stopIdx >= 0']] },
  { name: 'save-currentTime', note: '前回位置を currentTime で保存する', edits: [['function resumePoint() { return Math.max(v.currentTime, holdUntil); }', 'function resumePoint() { return v.currentTime; }']] },
  { name: 'no-moved', note: '動かしていない動画でも前回位置を書く', edits: [['if (!id || !hasVideo || !moved) return;', 'if (!id || !hasVideo) return;']] },
  { name: 'reseek-same-target', note: '同じ時刻へのシークのし直し止めを外す（WebKit 向けの対策。Chromium の写しでは無害のはず＝誤検出の対照）', edits: [['if (!(v.seeking && Math.abs(v.currentTime - seekTo) < 0.01)) v.currentTime = seekTo;', 'v.currentTime = seekTo;']], benign: true },
  // 書き換える所は seeked の処理の最後の行（pause の処理にも同じ式があるので、閉じかっこまで含めて 1 箇所に絞る）
  { name: 'seeked-tick-after-stop', note: '「1行ずつ」で止めた後も seeked で tick する（X8 の直す前）', edits: [['if (v.paused && stoppedAt < 0) tick();\n  });', 'if (v.paused) tick();\n  });']] },
  { name: 'no-row-clamp', note: '1行ずつの間も色を止める行より先へ進める（重なる行で色が行き来する）', edits: [['setCur(rowAt(t));', 'setCur(cueAt(t));']] },
  { name: 'no-nested-skip', note: '止めた後の止める行を 1 つ進めるだけにする（入れ子の行で ▶ を 2 回押す）', edits: [['stopIdx = nextStop(stopIdx + 1, t);', 'stopIdx += 1;']] },
  { name: 'no-late-guard', note: '止める点を大きく過ぎてからの tick でも古い行で止める（rAF だけが止まった後）', edits: [['if (t < endPoint(stopIdx) + LATE) {', 'if (true) {']] },
  // 「一覧」の確かめ（X12・M8 と、ランダム操作の「確かめで迷う」「画面の書き換えだけ止まる」で見つかるか）
  { name: 'late-recalc-no-next', note: 'LATE の引き直しで、止める点をもう過ぎた行を止める行にする（行の終わりの後の隙間で戻った時に、その行で遅れて止まる）',
    edits: [['const c = cueAt(t);\n      stopIdx = c < 0 ? 0 : (t < endPoint(c) ? c : c + 1);', 'const c = cueAt(t);\n      stopIdx = c < 0 ? 0 : c;']] },
  { name: 'back-no-confirm', note: '「一覧」で確かめない（変更前の作り）', edits: [['if (hasVideo && !window.confirm(', 'if (false && !window.confirm(']] },
  { name: 'back-confirm-always', note: '動画を読み込んでいない時も「一覧」で確かめる', edits: [['if (hasVideo && !window.confirm(', 'if (!window.confirm(']] },
  { name: 'back-ignores-cancel', note: '確かめでキャンセルしても一覧へ戻る', edits: [['if (hasVideo && !window.confirm(', 'if (hasVideo && void window.confirm(']] },
  // X12・X13・X15・X16・X17 の直しを 1 つずつ外した版（それらのシナリオと M8・M9 で見つかるか）
  { name: 'back-no-pause', note: '「一覧」の確かめの間も動画を止めない（迷う間に止める点を過ぎる）', edits: [['if (playing) v.pause();', '']] },
  { name: 'back-cancel-no-resume', note: '確かめでキャンセルしても再生に戻さない', edits: [['if (playing) v.play().catch(() => {});', '']] },
  { name: 'play-hides-info', note: '動画の ▶ でも「続きから」の案内を消す（前回の行へ戻る手段が無くなる）',
    edits: [['raf = requestAnimationFrame(tick); keepAwake(); });', 'raf = requestAnimationFrame(tick); keepAwake(); if (!info.hidden) showInfo([]); });']] },
  { name: 'playFrom-keeps-info', note: '行から見始めても「続きから」の案内を消さない', edits: [['    if (!info.hidden) showInfo([]);\n    stoppedAt = -1;', '    stoppedAt = -1;']] },
  { name: 'stop-keeps-hold', note: '「1行ずつ」で止めた時に巻き戻しの印を消さない', edits: [['v.pause(); holdUntil = -1; stoppedAt = stopIdx;', 'v.pause(); stoppedAt = stopIdx;']] },
  { name: 'pause-no-tick', note: '一時停止で止まった時刻の行に色を合わせない（rAF が止まっている間の一時停止で古い行が残る）',
    edits: [['if (v.paused && stoppedAt < 0) tick(); savePos(); });', 'savePos(); });']] },
  { name: 'paused-no-late-recalc', note: '止まっている時の tick では止める行を引き直さない（1行ずつで rAF が止まっている間の一時停止で、色が古い止める行のまま）',
    edits: [['if (step && !v.seeking && stopIdx >= 0 && stopIdx < cues.length && t >= endPoint(stopIdx) &&\n        (!v.paused || t >= endPoint(stopIdx) + LATE)) {',
      'if (step && !v.paused && !v.seeking && stopIdx >= 0 && stopIdx < cues.length && t >= endPoint(stopIdx)) {']] },
];

// ---------------------------------------------------------------- 実行
function parseArgs(argv) {
  const o = { fuzz: 1600, seeds: [1, 24], data: ['clean', 'real'], scenarios: true, fuzzOn: true, mutants: false, trace: false, shrink: false, busy: 0.05 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => argv[++i];
    if (a === '--rev') o.rev = val();
    else if (a === '--html') o.html = val();
    else if (a === '--fuzz') o.fuzz = +val();
    else if (a === '--seeds') { const [x, y] = val().split('..').map(Number); o.seeds = [x, y == null || Number.isNaN(y) ? x : y]; }
    else if (a === '--data') o.data = val().split(',');
    else if (a === '--busy') o.busy = +val();
    else if (a === '--codes') o.codes = new Set(val().split(','));
    else if (a === '--keep-going') o.keepGoing = true;
    else if (a === '--no-scenarios') o.scenarios = false;
    else if (a === '--no-fuzz') o.fuzzOn = false;
    else if (a === '--mutants') o.mutants = true;
    else if (a === '--trace') o.trace = true;
    else if (a === '--shrink') o.shrink = true;
    else if (a === '-h' || a === '--help') { const L = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); console.log(L.slice(0, L.findIndex((l) => !l.startsWith('//'))).join('\n')); process.exit(0); }
    else throw new Error('知らない引数 ' + a);
  }
  return o;
}
async function runFuzz(html, o, quiet) {
  const total = { ops: 0, runs: 0, viol: 0, byCode: {}, first: [], stat: {}, occ: {}, runsWith: {} };
  const t0 = Date.now();
  for (const kind of o.data) {
    for (let seed = o.seeds[0]; seed <= o.seeds[1]; seed++) {
      const { ss, n } = await fuzzRun(html, kind, seed, o.fuzz, { busy: o.busy, codes: o.codes, keepGoing: o.keepGoing });
      total.ops += n; total.runs++;
      for (const [k, v] of Object.entries(ss.codeCount)) { total.occ[k] = (total.occ[k] || 0) + v; total.runsWith[k] = (total.runsWith[k] || 0) + 1; }
      for (const [k, v] of Object.entries(ss.stat)) total.stat[k] = (total.stat[k] || 0) + v;
      if (ss.viol) {
        total.viol++;
        total.byCode[ss.viol.code] = (total.byCode[ss.viol.code] || 0) + 1;
        total.first.push({ kind, seed, n, viol: ss.viol, ops: ss.ops });
        if (!quiet) {
          console.log('  違反 ' + kind + ' seed ' + seed + ' の ' + n + ' 手目 ' + ss.viol.code + ': ' + ss.viol.msg);
          if (o.trace) {
            console.log('    直前の操作: ' + ss.ops.slice(-8).map(opText).join(' / '));
            console.log('    経過:\n      ' + ss.viol.ring.join('\n      '));
          }
        }
      }
    }
  }
  total.ms = Date.now() - t0;
  return total;
}
function printStat(st) {
  const keys = [['jumps', '行へ飛ぶ'], ['fastDbl', '素早い 2 度押し'], ['slowDbl', 'ゆっくり 2 度押し'], ['stepToggles', '1行ずつの入切'],
    ['stepStops', '1行ずつの停止'], ['userSeeks', 'シークバー'], ['browserSeeks', '見終わり後の ▶ の 0 秒シーク'], ['staleSeeked', '次のシーク中に届いた seeked'],
    ['pipe', '内部処理の直後の操作'], ['hides', 'アプリを離れる'], ['opens', '開き直し'], ['picks', '動画の選択'], ['broken', '読めない動画'],
    ['fails', '再生中の読み込み失敗'], ['resumes', '続きから'], ['saves', '前回位置の保存'], ['ticks', '画面の書き換え（tick）'],
    ['confirms', '一覧の確かめ'], ['cancels', '確かめでキャンセル'], ['jsStalls', '確かめで迷う間に動画が進む'],
    ['rafStalls', '再生中に画面の書き換えだけ止まる'], ['stallPauses', 'その間に一時停止'], ['lateRecalcs', '止める点を LATE 以上過ぎて引き直す']];
  return keys.map(([k, label]) => label + ' ' + (st[k] || 0)).join('、');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { label, html } = loadHtml(o);
  instrument(html);   // 前提の照合（ROLL・PAD・末尾）
  let bad = false;
  console.log('対象: ' + label);
  if (o.mutants) {
    // 変異は、変える前の版（同じ seed・同じシナリオ）で既に出ていたものを差し引いて、新しく出たものだけで判定する
    // ランダム操作はイベントの遅れ無し（busy 0）で回す。遅れが要る既知の残り（X8 の経路）が判定に混ざらないように
    const mo = Object.assign({}, o, { seeds: [1, 4], fuzz: 600, busy: 0 });
    console.log('変異（わざと壊した版）: シナリオ＋ランダム操作 ' + o.data.join('・') + ' × seed 1..4 × 600 手（イベントの遅れ無し）。元の版で既に出ていたものは差し引く');
    const baseRows = await runScenarios(html, true), baseTot = await runFuzz(html, mo, true);
    const failing = (r) => (!r.ok && !r.pending) || r.codes.length > 0;   // 判断待ちのシナリオは、違反だけを数える
    const baseFail = new Set(baseRows.filter(failing).map((r) => r.id));
    console.log('  元の版: シナリオ ' + (baseFail.size ? [...baseFail].join(' ') + ' が症状あり' : 'すべて期待どおり') + ' / ランダム ' + baseTot.ops + ' 手で違反 ' + baseTot.viol + ' 回');
    for (const mu of MUTANTS) {
      const mh = mutate(html, mu.edits);
      const rows = await runScenarios(mh, true);
      const tot = await runFuzz(mh, mo, true);
      const hit = rows.filter((r) => failing(r) && !baseFail.has(r.id)).map((r) => r.id + (r.ok ? '' : '(症状)') + (r.codes.length ? '[' + r.codes.join(',') + ']' : ''));
      const newViol = tot.first.filter((f) => !baseTot.first.some((b) => b.kind === f.kind && b.seed === f.seed && b.viol.code === f.viol.code));
      const detected = hit.length > 0 || newViol.length > 0;
      const verdict = mu.benign ? (detected ? '誤検出' : '検出なし（期待どおり）') : (detected ? '検出' : '見逃し');
      if (mu.benign ? detected : !detected) bad = true;
      console.log('  ' + mu.name + ': ' + verdict + ' ― ' + mu.note);
      console.log('       新しく症状・違反の出たシナリオ ' + (hit.join(' ') || 'なし') + ' / ランダム ' + tot.ops + ' 手で新しい違反 ' + newViol.length + ' 回' +
        (newViol.length ? '（' + newViol.map((f) => f.viol.code).join('、') + '）' : ''));
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (o.scenarios) {
    console.log('症状のシナリオ（偽 video は決まった遅れ: イベント 0.1ms・シーク 60ms・読み込み 100ms）');
    const rows = await runScenarios(html);
    if (rows.some((r) => (!r.ok && !r.pending) || r.codes.length)) bad = true;
  }
  if (o.fuzzOn) {
    console.log('ランダム操作: ' + o.data.join('・') + ' × seed ' + o.seeds[0] + '..' + o.seeds[1] + ' × ' + o.fuzz + ' 手（混んだ時のイベントの遅れの確率 ' + o.busy + '）');
    const tot = await runFuzz(html, o);
    console.log('  計 ' + tot.ops + ' 手・' + tot.runs + ' 回、違反のあった回 ' + tot.viol + (tot.viol ? '（' + Object.entries(tot.byCode).map(([k, v]) => k + ' ' + v).join('、') + '）' : '') + '、' + (tot.ms / 1000).toFixed(1) + ' 秒');
    if (o.keepGoing) console.log('  違反の出た回（全 ' + tot.runs + ' 回中）: ' + (Object.entries(tot.runsWith).map(([k, v]) => k + ' ' + v + ' 回（' + tot.occ[k] + ' 件）').join('、') || 'なし'));
    console.log('  通った経路: ' + printStat(tot.stat));
    if (tot.viol) {
      bad = true;
      if (o.shrink) {
        const f = tot.first[0];
        const r = await shrink(html, f.kind, f.seed, f.ops, f.viol.code, { busy: o.busy });
        console.log('  最小化（' + f.kind + ' seed ' + f.seed + '、' + r.tries + ' 回試行）: ' + r.ops.length + ' 手 → ' + (r.viol ? r.viol.code + ': ' + r.viol.msg : '再現せず'));
        r.ops.forEach((op, i) => console.log('    ' + (i + 1) + '. ' + opText(op)));
        if (r.viol && o.trace) console.log('    経過:\n      ' + r.viol.ring.join('\n      '));
      }
    }
  }
  process.exitCode = bad ? 1 : 0;
}

export { Session, Media, genData, spec, SCN_DATA, SCENARIOS, MUTANTS, instrument, mutate, fuzzRun, replay, shrink, runScenarios };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
