#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.61.0", "rangehttpserver"]
# ///
"""字幕プレイヤーの画面まわり（下端のボタン帯・コピー・解説・字幕データの置き換え）を、ヘッドレス Chromium で確かめる。

  uv run test/ui-check.py                       # 合成した動画（ffmpeg の testsrc）と合成した字幕で確かめる
  uv run test/ui-check.py --video A.mp4 --data A.study.json --work 作業フォルダ --shots 画像の保存先

--data を渡した時は、そのファイルは変えずに写しを --work に作り、元の解説（x）をすべて外してから、背の高い行を中心に
5 行へ偽の解説を足し、別の 1 行から日本語を外して使う（日本語の無い行のコピーを見るため。解説の付いた行の数・置き換えた
字幕データの解説・解説の無い字幕データの確かめは、偽の解説だけが付いている前提で数える）。
このリポジトリは公開なので、実データの英文・訳・解説はここに書かない（偽の解説は中身の無い文）。
playwright は 1.61.0 に固定してある（新しい版はキャッシュに無い Chromium を要求して起動できないことがある）。

見るもの（縦持ち・横持ちそれぞれ、375×812pt でホームインジケータのある iPhone の安全領域を真似た場合と真似ない場合）:
  - 縦持ちは操作ボタンが下端の帯（一番下の段が 前・もう一度・次、上の段の左端が一覧・右端がコピー）。帯の下に安全領域の分を空ける
  - 上の段・下の段のボタンの文字が折り返さない。ボタンの高さは変わらないので寸法では分からず、文字の行数を Range で数える
  - 解説を出した背の高い行をタップして再生し、「1行ずつ」で止まった後に、行が下端の帯や上の動画に隠れない
  - 「続きから」の案内は、行をタップして見始めると消える（上が高いままだと背の高い行が帯に隠れる）。「続きから」でも消える。
    動画の ▶ で見始めた時は消えず、「続きから」で前回の行へ戻れる（押し違えて頭から見始めた時に、前回の位置を失わない）
  - 「一覧」は動画を読み込んでいる時だけ確かめる（「キャンセル」なら戻らない）。確かめの間は動画を止め、キャンセルなら再生に戻す
  - 帯の上で指を動かしてもページがスクロールせず、追従も切れない。字幕の上なら切れて「今の行へ ↓」が帯と重ならずに出る
  - コピー: 今の行の英語と日本語の 2 行（日本語の無い行は英語だけ）。「コピーしました」が帯の上に出て消える。
    Clipboard API が拒まれた時・無い時は textarea と execCommand に落ちる。両方だめなら「コピーできませんでした」。
    「今の行へ ↓」が出ている時も、どちらの表示もそれと重ならない。再生しただけではコピーしない。今の行が無い間は押せない
  - 解説ボタン: 出し入れ、設定の保存、解説の無い字幕データでは出ない
  - 同じ id の字幕データを追加し直すと置き換わり、一覧の前回位置は残る
  - ページのエラーが無い
iPhone の Safari（WebKit）の挙動、Clipboard API の許可、安全領域の実寸は実機でしか確かめられない。
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
PAD = 0.25  # ページと同じ値（1行ずつで止まる位置）

# 安全領域は Emulation.setSafeAreaInsetsOverride で env(safe-area-inset-*) に入れる。
# 縦持ちの高さ 762 は 812 から状態バーの分を引いたもの（ホーム画面アプリの状態バーは重ならない前提の概算）
CONFIGS = [
    {"name": "縦 375x812", "vp": (375, 812), "insets": None},
    {"name": "縦 375x762・安全領域", "vp": (375, 762), "insets": {"top": 0, "bottom": 34, "left": 0, "right": 0}},
    {"name": "横 812x375", "vp": (812, 375), "insets": None},
    {"name": "横 812x375・安全領域", "vp": (812, 375), "insets": {"top": 0, "bottom": 21, "left": 50, "right": 50}},
]

FAKE_X = [
    "【表現】テスト用の見出し: これは画面の確認のための偽の解説で、本物の解説ではない",
    "【文法】テスト用の説明。1 項目を 1 段に出し、長い項目は折り返す。折り返した時の行の間隔と、単語の意味との見分けを見る",
    "【推測】テスト用の推測。偽の解説",
    "【話し方】テスト用の説明。短い項目",
]


# ---------------- 字幕データの用意 ----------------
def synth(work: Path) -> tuple[Path, dict]:
    """合成した動画と字幕。英文は意味の無い文。"""
    cues, s = [], 1.0
    words = ["this", "is", "a", "test", "line", "for", "the", "player", "check"]
    for k in range(40):
        t = f"Line {k + 1}: " + " ".join(words[: 4 + k % 6]) + "." + " And here is a longer test sentence to wrap." * (k % 3)
        c = {"s": round(s, 3), "e": round(s + 2.0, 3), "t": t}
        c["ja"] = f"テスト用の訳 {k + 1}" + "。長めの訳の続き" * (k % 3)
        if k % 2 == 0:
            c["g"] = [["test", "名詞", "テスト用の意味"], ["line", "名詞", "テスト用の意味 2"]][: 1 + k % 2]
        if k % 5 == 1:
            c["alt"] = f"line alternative {k + 1}"
        if k % 6 == 2:
            c["u"] = [[0, 4]]
        cues.append(c)
        s += 2.2
    dur = round(s + 3, 3)
    video = work / "synth.mp4"
    if not video.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi",
                        "-i", "sine=frequency=440", "-t", str(dur), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        str(video)], check=True)
    data = {"format": "study-player/1", "id": "ui-check-synth", "title": "合成した字幕（画面の確認用）", "video": video.name,
            "duration": dur, "lang": "en", "langLabel": "英語", "lead": "画面の確認用に合成した字幕。", "cues": cues}
    return video, data


def prepare(data: dict, work: Path) -> dict:
    """解説付き・置き換え用・解説なしの 3 つを書き出す。返り値はファイルと、解説を付けた行・日本語を外した行。"""
    cues = data["cues"]
    score = lambda c: len(c.get("t", "")) + len(c.get("alt", "")) + 1.5 * len(c.get("ja", "")) + 25 * len(c.get("g", []))
    tall = sorted(range(len(cues)), key=lambda k: -score(cues[k]))
    rows = [1, len(cues) - 1]
    for k in tall:
        if len(rows) == 5:
            break
        if k not in rows:
            rows.append(k)
    rows.sort()
    no_ja = next(k for k in range(2, len(cues)) if k not in rows and k - 1 not in rows and k + 1 not in rows)

    def variant(tag: str, with_x: bool) -> dict:
        d = json.loads(json.dumps(data))
        for c in d["cues"]:  # 解説入りの字幕データを渡された時も、偽の解説だけにする
            c.pop("x", None)
        for k in rows if with_x else []:
            d["cues"][k]["x"] = [x + tag for x in FAKE_X[: 2 + rows.index(k) % 3]]
        d["cues"][no_ja].pop("ja", None)
        return d

    with_x, replaced = variant("", True), variant("（差し替え後）", True)
    nox = variant("", False)
    nox.update(id=data["id"] + "-nox", title="解説なしの確認用", cues=nox["cues"][:12])
    files = {}
    for key, d in (("x", with_x), ("x2", replaced), ("nox", nox)):
        files[key] = work / f"ui-check-{key}.study.json"
        files[key].write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return {"files": files, "rows": rows, "no_ja": no_ja, "data": with_x}


# ---------------- ページの中で測る ----------------
JS_LINES = """(sel) => [...document.querySelectorAll(sel)].filter((b) => !b.hidden).map((b) => {
  const r = document.createRange(); r.selectNodeContents(b);
  const fs = parseFloat(getComputedStyle(b).fontSize);
  const tops = [...r.getClientRects()].map((x) => x.top).sort((a, c) => a - c);
  let lines = tops.length ? 1 : 0;
  for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > fs * 0.5) lines++;
  const w = b.getBoundingClientRect().width;
  return { id: b.id, text: b.textContent, lines, w: Math.round(w * 10) / 10 };
})"""

JS_LAYOUT = """() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width }; };
  const $ = (id) => document.getElementById(id), ctrl = $('ctrl'), rows = [...ctrl.querySelectorAll('.row')];
  const vis = (row) => [...row.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.id);
  return {
    land: matchMedia('(orientation: landscape) and (max-height: 600px)').matches,
    iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth,
    ctrl: rect(ctrl), pos: getComputedStyle(ctrl).position, padB: parseFloat(getComputedStyle(ctrl).paddingBottom),
    touch: getComputedStyle(ctrl).touchAction, top: rect($('top')), list: rect($('list')),
    upper: vis(rows[0]), lower: vis(rows[1]), over: rows.map((r) => r.scrollWidth - r.clientWidth), next: rect($('next')), row0: rect(rows[0]),
  };
}"""

JS_STATE = """() => {
  const v = document.getElementById('v'), cs = [...document.querySelectorAll('#list .cue')];
  return { t: v.currentTime, d: v.duration, paused: v.paused, seeking: v.seeking, cur: cs.findIndex((c) => c.classList.contains('cur')),
           y: scrollY, following: document.getElementById('follow').hidden, info: !document.getElementById('info').hidden };
}"""

JS_ROW = """(k) => {
  const el = document.querySelectorAll('#list .cue')[k], r = el.getBoundingClientRect();
  const land = matchMedia('(orientation: landscape) and (max-height: 600px)').matches;
  const top = land ? 0 : document.getElementById('top').getBoundingClientRect().bottom;
  const bot = land ? innerHeight : document.getElementById('ctrl').getBoundingClientRect().top;
  return { top: r.top, bottom: r.bottom, h: r.height, edgeTop: top, edgeBot: bot, ex: el.querySelectorAll('.ex p').length };
}"""

JS_RECT = """(sel) => { const el = document.querySelector(sel); if (!el || el.hidden) return null;
  const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, text: el.textContent }; }"""

# 「一覧」の確かめが出た時に動画が止まっているかを、ページの中で記録する（ダイアログの間はページの外からは読めない。
# currentTime は 1 回の処理の中では変わらないので、ダイアログの間に進んだ秒数はここでは測れない）
JS_CONFIRM_SPY = """() => {
  if (window.__confirmSpy) return; window.__confirmSpy = [];
  const v = document.getElementById('v'), orig = window.confirm;
  window.confirm = (msg) => { const a = { paused: v.paused }; a.answer = orig.call(window, msg); window.__confirmSpy.push(a); return a.answer; };
}"""


class Checker:
    def __init__(self) -> None:
        self.ng = 0
        self.n = 0

    def __call__(self, name: str, ok: bool, detail: str = "") -> bool:
        self.n += 1
        if not ok:
            self.ng += 1
        print(f"  {'OK' if ok else 'NG'}  {name}" + (f"\n        {detail}" if detail and not ok else (f"（{detail}）" if detail else "")))
        return ok


def overlap(a: dict | None, b: dict | None) -> bool:
    return bool(a and b and a["left"] < b["right"] and b["left"] < a["right"] and a["top"] < b["bottom"] and b["top"] < a["bottom"])


def end_point(cues: list, k: int) -> float:
    c, n = cues[k], cues[k + 1] if k + 1 < len(cues) else None
    return max(c["e"], min(c["e"] + PAD, n["s"])) if n else c["e"] + PAD


def run_config(pw_browser, cfg: dict, url: str, video: Path, prep: dict, shots: Path, check: Checker, scheme: str = "light") -> None:
    w, h = cfg["vp"]
    ins = cfg["insets"] or {"top": 0, "bottom": 0, "left": 0, "right": 0}
    ctx = pw_browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                 color_scheme=scheme)
    origin = url.split("/index.html")[0]
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    # 「一覧」の確かめ（confirm）。出た文言を覚え、accept[0] が真なら「OK」、偽なら「キャンセル」で閉じる
    dialogs: list[str] = []
    accept = [True]
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept() if accept[0] else d.dismiss()))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "favicon" not in m.text else None)
    cdp = ctx.new_cdp_session(page)
    if cfg["insets"]:
        cdp.send("Emulation.setSafeAreaInsetsOverride", {"insets": cfg["insets"]})
    page.goto(url)
    data, rows, no_ja = prep["data"], prep["rows"], prep["no_ja"]
    cues, vid = data["cues"], data["id"]
    tag = cfg["name"].replace(" ", "_").replace("・", "_") + ("_dark" if scheme == "dark" else "")
    st = lambda: page.evaluate(JS_STATE)

    def lines_ok(label: str) -> None:
        res = page.evaluate(JS_LINES, "#ctrl .row button")
        bad = [f"{r['text']}={r['lines']}行" for r in res if r["lines"] != 1]
        check(f"{label}: ボタンの文字が 1 行", not bad, ", ".join(bad) or " ".join(f"{r['text']}:{r['w']}" for r in res))

    def tap_row(k: int) -> None:
        # 行を見える範囲の真ん中に出してから、見えている部分を指でタップする（帯に隠れた所を押さない）
        page.evaluate("(k) => document.querySelectorAll('#list .cue')[k].scrollIntoView({ block: 'center' })", k)
        r = page.evaluate(JS_ROW, k)
        y = (max(r["top"], r["edgeTop"]) + min(r["bottom"], r["edgeBot"])) / 2
        box = page.locator("#list .cue").nth(k).bounding_box()
        page.touchscreen.tap(box["x"] + box["width"] / 2, y)

    def wait_stop(k: int, rate: float = 3.0) -> dict | None:
        page.evaluate("(r) => { document.getElementById('v').playbackRate = r; }", rate)
        limit = time.time() + (cues[k]["e"] - cues[k]["s"]) / rate + 8
        while time.time() < limit:
            s = st()
            if s["paused"] and not s["seeking"] and s["cur"] == k and s["t"] >= min(end_point(cues, k), s["d"]) - 0.05:
                return s
            time.sleep(0.05)
        return None

    def touch_drag(x: float, y: float, dy: float) -> None:
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for i in range(12):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - dy * (i + 1) / 12}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(0.6)

    def copy_and_read(expect_toast: str) -> tuple[str | None, str]:
        page.evaluate("() => { document.getElementById('toast').hidden = true; }")  # 前のコピーの表示と取り違えない
        page.click("#copy")
        page.wait_for_function("(t) => { const e = document.getElementById('toast'); return !e.hidden && e.textContent === t; }",
                               arg=expect_toast, timeout=3000)
        return page.evaluate("() => (window.__clip || navigator.clipboard).readText()"), page.inner_text("#toast")

    print(f"== {cfg['name']}" + ("（ダークモード）" if scheme == "dark" else ""))
    # 字幕データの追加（解説付きと解説なし）
    page.set_input_files("#addData", [str(prep["files"]["x"]), str(prep["files"]["nox"])])
    page.wait_for_function("() => document.querySelectorAll('#lib li').length === 2")
    check("字幕データを 2 本追加", "2 本追加しました" in page.inner_text("#libNote"), page.inner_text("#libNote"))

    # 前回位置を入れておき、「続きから」の案内が出た状態（上が高い）で開く
    page.evaluate("(id) => localStorage.setItem('sp:t:' + id, '30')", vid)
    page.locator("#lib .open", has_text=data["title"]).first.click()
    page.set_input_files("#pickVideo", str(video))
    page.wait_for_function("() => document.getElementById('picker').hidden", timeout=20000)
    page.wait_for_function("() => !document.getElementById('info').hidden", timeout=5000)

    lay = page.evaluate(JS_LAYOUT)
    want_upper = ["back", "step", "speed", "tja", "tgl", "tex", "copy"]
    check("上の段の並び（左端 一覧・右端 コピー）", lay["upper"] == want_upper, str(lay["upper"]))
    check("下の段は 前・もう一度・次", lay["lower"] == ["prev", "again", "next"], str(lay["lower"]))
    check("帯の下に安全領域の分を空ける", abs(lay["padB"] - ins["bottom"]) < 0.5, f"padding-bottom {lay['padB']} / 安全領域 {ins['bottom']}")
    check("帯の上ではスクロールさせない（touch-action: none）", lay["touch"] == "none", lay["touch"])
    if lay["land"]:
        check("横持ち: 操作は左の列の一番下", lay["pos"] != "fixed" and abs(lay["ctrl"]["bottom"] - h) < 1
              and lay["ctrl"]["right"] <= lay["list"]["left"] + 1, f"pos={lay['pos']} ctrl={lay['ctrl']} list.left={lay['list']['left']}")
    else:
        check("縦持ち: 操作は画面の下端に固定", lay["pos"] == "fixed" and abs(lay["ctrl"]["bottom"] - h) < 1, f"pos={lay['pos']} ctrl={lay['ctrl']}")
    check("「次」の下端が安全領域より上", lay["next"]["bottom"] <= h - ins["bottom"] - 4, f"next.bottom={lay['next']['bottom']} h={h}")
    check("横にはみ出さない", lay["sw"] <= lay["iw"] and max(lay["over"]) <= 0, f"scrollWidth {lay['sw']} / {lay['iw']}、段のはみ出し {lay['over']}")
    for _ in range(3):  # 速度の表示 1.0x → 0.85x → 0.7x → 1.0x の全部で数える
        lines_ok(f"速度 {page.inner_text('#speed')}")
        page.click("#speed")
    check("今の行が無い間はコピーを押せない", page.is_disabled("#copy"))

    # 解説の表示
    ex = page.evaluate("""() => { const p = document.querySelector('#list .ex p'), g = document.querySelector('#list .gl li');
      const cs = (e) => getComputedStyle(e); const cue = p.closest('.cue');
      return { n: document.querySelectorAll('#list .cue .ex').length, fsEx: parseFloat(cs(p).fontSize), fsGl: g ? parseFloat(cs(g).fontSize) : null,
               color: cs(p).color, muted: cs(document.querySelector('.meta')).color, last: cue.lastElementChild.className, lang: p.parentElement.lang }; }""")
    check("解説が付いた行の数", ex["n"] == len(rows), f"{ex['n']} / {len(rows)}")
    check("解説は単語の意味の下で、文字は控えめ", ex["last"] == "ex" and (ex["fsGl"] is None or ex["fsEx"] < ex["fsGl"]) and ex["color"] == ex["muted"],
          f"末尾={ex['last']} 文字 {ex['fsEx']}px（単語 {ex['fsGl']}px）色 {ex['color']}（控えめの色 {ex['muted']}）")
    for k in rows:
        n = page.evaluate(JS_ROW, k)["ex"]
        if n != 2 + rows.index(k) % 3:
            check(f"行 {k + 1} の解説の項目数", False, f"{n}")

    # 1行ずつで、背の高い行をタップ → 止まった後に帯・動画に隠れない
    page.click("#step")

    def tall_rows(label: str) -> None:
        for k in rows:
            tap_row(k)
            s = wait_stop(k)
            if s is None:  # ヘッドレスの再生が固まることがあるので 1 度だけやり直す
                tap_row(k)
                s = wait_stop(k)
            r = page.evaluate(JS_ROW, k)
            fits = r["h"] <= r["edgeBot"] - r["edgeTop"] - 16
            if fits:
                ok = r["top"] >= r["edgeTop"] - 0.5 and r["bottom"] <= r["edgeBot"] + 0.5
            else:  # 入りきらない高さなら、行の頭を上端に合わせる
                ok = abs(r["top"] - (r["edgeTop"] + 8)) < 1.5
            check(f"{label}: 行 {k + 1}（高さ {r['h']:.0f}）をタップして止まった後に隠れない",
                  s is not None and ok and st()["following"],
                  f"止まった={s is not None} 行 {r['top']:.1f}〜{r['bottom']:.1f} / 見える範囲 {r['edgeTop']:.1f}〜{r['edgeBot']:.1f}"
                  + ("" if fits else "（入りきらない高さ）"))

    # 「続きから」の案内が出ている間に行をタップして見始める → 案内が消えて上が低くなる
    if not lay["land"]:
        page.screenshot(path=str(shots / f"{tag}-info.png"))
    top0 = page.evaluate("() => document.getElementById('top').getBoundingClientRect().height")
    tap_row(rows[0])
    s = wait_stop(rows[0])
    top1 = page.evaluate("() => document.getElementById('top').getBoundingClientRect().height")
    check("行をタップして見始めると「続きから」の案内が消える", s is not None and not st()["info"] and (lay["land"] or top1 < top0),
          f"上の高さ {top0} → {top1}、{st()}")
    tall_rows("見始めた後")
    page.screenshot(path=str(shots / f"{tag}-ex.png"))

    # コピー
    k = rows[-1]
    want = "\n".join(" ".join(str(cues[k].get(f, "")).split()) for f in ("t", "ja") if cues[k].get(f))
    got, toast = copy_and_read("コピーしました")
    check("コピー: 今の行の英語と日本語の 2 行", got == want, f"{got!r}")
    page.wait_for_function("() => document.getElementById('toast').hidden", timeout=4000)
    check("コピー: 「コピーしました」は少しして消える", True)
    tap_row(no_ja)
    wait_stop(no_ja)
    got, _ = copy_and_read("コピーしました")
    check("コピー: 日本語の無い行は英語だけ", got == " ".join(cues[no_ja]["t"].split()), f"{got!r}")
    # Clipboard API が拒まれた時 → execCommand
    page.evaluate("""() => { window.__clip = navigator.clipboard; window.__exec = 0; const orig = document.execCommand.bind(document);
      document.execCommand = (...a) => { window.__exec++; return orig(...a); };
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); }""")
    page.evaluate("() => Clipboard.prototype.writeText.call(window.__clip, '-')")  # 前の中身と取り違えない
    got, _ = copy_and_read("コピーしました")
    check("コピー: Clipboard API が拒まれたら execCommand に落ちる", got == " ".join(cues[no_ja]["t"].split()) and page.evaluate("() => window.__exec") == 1,
          f"{got!r} execCommand {page.evaluate('() => window.__exec')} 回")
    # Clipboard API が無い時 → execCommand
    page.evaluate("""() => { window.__desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
      Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true }); window.__exec = 0; }""")
    page.evaluate("() => Clipboard.prototype.writeText.call(window.__clip, '-')")  # 前の中身と取り違えない
    got, _ = copy_and_read("コピーしました")
    check("コピー: Clipboard API が無ければ execCommand", got == " ".join(cues[no_ja]["t"].split()) and page.evaluate("() => window.__exec") == 1, f"{got!r}")
    # 両方だめ
    page.evaluate("() => { document.execCommand = () => false; }")
    copy_and_read("コピーできませんでした")
    check("コピー: 両方だめなら「コピーできませんでした」", True)
    page.evaluate("""() => { Object.defineProperty(Navigator.prototype, 'clipboard', window.__desc); delete navigator.clipboard.writeText;
      delete document.execCommand; }""")
    # 再生しただけではコピーしない
    page.evaluate("() => Clipboard.prototype.writeText.call(window.__clip, '(sentinel)')")
    tap_row(rows[0])
    wait_stop(rows[0])
    check("再生しただけではコピーしない", page.evaluate("() => navigator.clipboard.readText()") == "(sentinel)")

    # 帯の上（上の段の左の余白）で指を動かす → スクロールしない・追従は切れない。帯の上端の 2px は避ける
    # （横持ちでは動画のすぐ下になり、Chromium の動画の操作部分の当たり判定が 2px はみ出していて、そこからはスクロールする。
    #  controls を外すと消えるので Chromium の作りで、ページの不具合ではない）
    lay = page.evaluate(JS_LAYOUT)
    y0 = st()["y"]
    touch_drag(lay["ctrl"]["left"] + 4, (lay["row0"]["top"] + lay["row0"]["bottom"]) / 2, 180)
    s = st()
    check("帯の上で指を動かしてもスクロールしない", abs(s["y"] - y0) < 1 and s["following"], f"scrollY {y0} → {s['y']}、追従={s['following']}")
    # 字幕の上で指を動かす → スクロールして追従が切れ、「今の行へ ↓」が出る
    x = lay["iw"] * (0.75 if lay["land"] else 0.5)
    y = (lay["top"]["bottom"] + lay["ctrl"]["top"]) / 2 if not lay["land"] else lay["ih"] * 0.6
    touch_drag(x, y, 160)
    s = st()
    fol = page.evaluate(JS_RECT, "#follow")
    check("字幕の上で指を動かすとスクロールし、「今の行へ ↓」が出る", abs(s["y"] - y0) > 20 and fol is not None, f"scrollY {y0} → {s['y']}")
    if fol:
        if lay["land"]:
            ok = fol["right"] <= w - ins["right"] - 4 and fol["bottom"] <= h - ins["bottom"] - 4 and fol["left"] >= lay["list"]["left"]
        else:
            ok = fol["bottom"] <= lay["ctrl"]["top"] - 4 and fol["top"] >= lay["top"]["bottom"]
        check("「今の行へ ↓」は帯と重ならない", ok, f"{fol} 帯の上端 {lay['ctrl']['top']}")
        page.click("#copy")
        page.wait_for_function("() => !document.getElementById('toast').hidden")
        tst = page.evaluate(JS_RECT, "#toast")
        check("「コピーしました」は帯の上で、「今の行へ ↓」と重ならない",
              tst["bottom"] <= lay["ctrl"]["top"] + 0.5 and not overlap(tst, fol) and tst["left"] >= 0 and tst["right"] <= w,
              f"toast {tst} follow {fol}")
        page.screenshot(path=str(shots / f"{tag}-toast-follow.png"))
        # 失敗の「コピーできませんでした」は長く、中央に出すと「今の行へ ↓」に重なる（追従が切れている間は左に寄せる）
        page.evaluate("""() => { document.getElementById('toast').hidden = true;
          navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
          document.execCommand = () => false; }""")
        page.click("#copy")
        page.wait_for_function("() => { const e = document.getElementById('toast'); return !e.hidden && e.textContent === 'コピーできませんでした'; }")
        tst = page.evaluate(JS_RECT, "#toast")
        fol2 = page.evaluate(JS_RECT, "#follow")
        check("「コピーできませんでした」も帯の上で、「今の行へ ↓」と重ならない",
              fol2 is not None and tst["bottom"] <= lay["ctrl"]["top"] + 0.5 and not overlap(tst, fol2) and tst["left"] >= 0 and tst["right"] <= w,
              f"toast {tst} follow {fol2}")
        page.screenshot(path=str(shots / f"{tag}-toastfail-follow.png"))
        page.evaluate("() => { delete navigator.clipboard.writeText; delete document.execCommand; }")
        page.click("#follow")
        time.sleep(0.3)
        r = page.evaluate(JS_ROW, st()["cur"])
        check("「今の行へ ↓」で今の行に戻る", st()["following"] and r["top"] >= r["edgeTop"] - 0.5 and r["top"] < r["edgeBot"], f"{r}")

    # 解説の出し入れ（今の行は解説付きの行）
    tap_row(rows[2])
    wait_stop(rows[2])
    page.click("#tex")
    hid = page.evaluate("() => [getComputedStyle(document.querySelector('#list .ex')).display, document.getElementById('tex').getAttribute('aria-pressed'), localStorage.getItem('sp:hideEx')]")
    r = page.evaluate(JS_ROW, rows[2])
    check("「解説」で隠れ、設定を覚え、今の行は見える", hid == ["none", "false", "true"] and r["top"] >= r["edgeTop"] - 0.5 and r["bottom"] <= r["edgeBot"] + 0.5, f"{hid} {r}")
    page.click("#tex")
    r = page.evaluate(JS_ROW, rows[2])
    fits = r["h"] <= r["edgeBot"] - r["edgeTop"] - 16
    check("もう一度押すと出て、今の行は見える", page.evaluate("() => getComputedStyle(document.querySelector('#list .ex')).display") == "block"
          and r["top"] >= r["edgeTop"] - 0.5 and (r["bottom"] <= r["edgeBot"] + 0.5 or not fits), f"{r}")
    page.click("#tex")  # 隠したまま一覧へ戻り、開き直しても隠れているか

    # 「一覧」: 動画を読み込んでいる時は確かめる。キャンセルなら戻らず、OK なら戻る。再生中に押すと、確かめの間は動画を止め、
    # キャンセルなら再生に戻す（「1行ずつ」で止まっているので、続きを再生してから押す）
    page.evaluate(JS_CONFIRM_SPY)
    page.evaluate("() => document.getElementById('v').play()")
    page.wait_for_function("() => { const v = document.getElementById('v'); return !v.paused && !v.seeking && v.readyState >= 3; }", timeout=5000)
    n0 = len(dialogs)
    accept[0] = False
    page.click("#back")
    spy, s = page.evaluate("() => window.__confirmSpy.slice(-1)[0] || null"), st()
    check("動画を読み込んでいる時の「一覧」は確かめ、キャンセルなら戻らない",
          len(dialogs) == n0 + 1 and dialogs[-1].startswith("一覧に戻りますか") and page.is_visible("#playerView") and page.is_hidden("#libraryView"),
          f"{dialogs[n0:]}")
    check("再生中の「一覧」は、確かめの間は動画を止め、キャンセルなら再生に戻る",
          spy is not None and spy["paused"] and not s["paused"],
          f"確かめが出た時 {spy}、キャンセルの後 停止={s['paused']} 時刻 {s['t']:.3f}")
    accept[0] = True
    page.click("#back")
    check("確かめて OK なら一覧へ戻る", len(dialogs) == n0 + 2 and page.is_visible("#libraryView"), f"{dialogs[n0:]}")

    # 同じ id の字幕データを追加し直す → 置き換わり、前回位置は残る
    sub = page.locator("#lib li", has_text=data["title"]).locator(".sub").inner_text()
    page.set_input_files("#addData", str(prep["files"]["x2"]))
    page.wait_for_function("() => document.getElementById('libNote').textContent.includes('置き換え')")
    lib = page.evaluate("() => JSON.parse(localStorage.getItem('sp:lib'))")
    sub2 = page.locator("#lib li", has_text=data["title"]).locator(".sub").inner_text()
    check("同じ id を追加し直すと置き換わり、一覧の前回位置は残る", len(lib) == 2 and "前回" in sub and sub2 == sub,
          f"{page.inner_text('#libNote')} / 一覧 {len(lib)} 本 / {sub} → {sub2}")
    page.locator("#lib .open", has_text=data["title"]).first.click()
    exs = page.evaluate("() => [...document.querySelectorAll('#list .ex p')].map((p) => p.textContent)")
    check("置き換えた字幕データの解説が出る", bool(exs) and all(t.endswith("（差し替え後）") for t in exs), f"{exs[:2]}")
    check("解説を隠した設定は開き直しても残る", page.evaluate("() => document.body.classList.contains('hide-ex')")
          and page.get_attribute("#tex", "aria-pressed") == "false")
    page.click("#tex")
    # 動画を選ぶと「続きから」の案内が出る（前回位置は 30 秒にしておく）。動画の ▶ で頭から少し見ても案内は残り（前回位置は
    # 上書きされるが、案内の「続きから」は出した時の時刻を覚えている）、押すと消えて前回の行で止まる
    page.evaluate("(id) => localStorage.setItem('sp:t:' + id, '30')", vid)
    page.set_input_files("#pickVideo", str(video))
    page.wait_for_function("() => document.getElementById('picker').hidden", timeout=20000)
    page.wait_for_function("() => !document.getElementById('info').hidden", timeout=5000)
    # 動画の ▶（iPhone では動画の上に大きく出る）はページの外の操作なので、play() で真似る
    page.evaluate("() => document.getElementById('v').play()")
    page.wait_for_function("() => document.getElementById('v').currentTime > 0.5", timeout=10000)
    page.evaluate("() => document.getElementById('v').pause()")
    time.sleep(0.3)
    s = st()
    saved = page.evaluate("(id) => localStorage.getItem('sp:t:' + id)", vid)
    offered = check("動画の ▶ で見始めても「続きから」の案内は残る", s["info"] and page.is_visible("#info button"), f"{s}、前回位置の保存 {saved}")
    if offered:  # 消えていたら押せない（次の確かめも NG になる）
        page.click("#info button")
    k30 = max(i for i, c in enumerate(cues) if c["s"] <= 30)
    s = wait_stop(k30)
    check("「続きから」で案内が消え、前回の行で止まる", s is not None and not st()["info"], f"{st()}")
    page.click("#back")  # 動画を読み込んでいるので確かめが出る（OK で戻る）
    # 解説の無い字幕データでは「解説」ボタンを出さない
    page.locator("#lib .open", has_text="解説なしの確認用").first.click()
    lay = page.evaluate(JS_LAYOUT)
    check("解説の無い字幕データでは「解説」ボタンが無い", page.is_hidden("#tex") and lay["upper"] == ["back", "step", "speed", "tja", "tgl", "copy"], str(lay["upper"]))
    lines_ok("解説なし")
    n1 = len(dialogs)
    page.click("#back")
    check("動画を選んでいない時の「一覧」は確かめずに戻る", len(dialogs) == n1 and page.is_visible("#libraryView"), f"{dialogs[n1:]}")
    check("ページのエラーが無い", not errors, "; ".join(errors[:5]))
    ctx.close()


def serve(port: int, root: Path) -> tuple[subprocess.Popen, int]:
    """root を配信する（port が 0 なら空いている番号）。同じ番号で別の配信が動いていると、自分の配信は始まらずに終わるのに
    index.html は返ってくるので、別の版を黙って測ることになる。始まった後に、自分の配信が生きていることと、返ってきた
    index.html が root のものと同じことを確かめる。"""
    if not port:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
    except OSError:
        pass
    else:
        sys.exit(f"{port} 番はもう使われている（別の配信が動いている）。--port で別の番号を渡すか、省いて空いている番号を使う")
    want = (root / "index.html").read_bytes()
    proc = subprocess.Popen([sys.executable, "-m", "RangeHTTPServer", str(port), "--bind", "127.0.0.1"], cwd=root,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if proc.poll() is not None:
            break
        try:
            got = urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=1).read()
        except OSError:
            time.sleep(0.1)
            continue
        time.sleep(0.2)  # 番号を取れずに終わる途中なら、ここで終わっている
        if proc.poll() is None and got == want:
            return proc, port
        break
    if proc.poll() is None:
        proc.terminate()
    sys.exit(f"配信が始まらない、または {port} 番で別の版が配信されている（返ってきた index.html が {root} のものと違う）")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--video", help="動画（省くと合成する）")
    ap.add_argument("--data", help="字幕データ .study.json（省くと合成する。ファイルは変えない）")
    ap.add_argument("--work", help="作った字幕データ・合成した動画の置き場（省くと一時フォルダ）")
    ap.add_argument("--shots", help="スクリーンショットの保存先（省くと --work）")
    ap.add_argument("--port", type=int, default=0, help="配信の番号（省くと空いている番号）")
    ap.add_argument("--only", help="この文字列を名前に含む設定だけ回す（例: 縦）")
    ap.add_argument("--root", default=str(REPO), help="配信するフォルダ（わざと壊した版で、この確認が不具合を見つけるかを試す時）")
    a = ap.parse_args()
    if bool(a.video) != bool(a.data):
        sys.exit("--video と --data は両方渡すか、両方省く")
    work = Path(a.work or tempfile.mkdtemp(prefix="study-player-ui-"))
    work.mkdir(parents=True, exist_ok=True)
    shots = Path(a.shots or work)
    shots.mkdir(parents=True, exist_ok=True)
    if a.data:
        video, data = Path(a.video), json.loads(Path(a.data).read_text(encoding="utf-8"))
    else:
        video, data = synth(work)
    prep = prepare(data, work)
    print(f"作業フォルダ {work} / 解説を付けた行 {[k + 1 for k in prep['rows']]} / 日本語を外した行 {prep['no_ja'] + 1}")
    check = Checker()
    proc, port = serve(a.port, Path(a.root))
    print(f"配信 {a.root}（{port} 番）")
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            url = f"http://127.0.0.1:{port}/index.html"
            runs = [(cfg, "light") for cfg in CONFIGS] + [(CONFIGS[1], "dark")]
            for cfg, scheme in runs:
                if a.only and a.only not in cfg["name"] + ("ダーク" if scheme == "dark" else ""):
                    continue
                try:
                    run_config(browser, cfg, url, video, prep, shots, check, scheme)
                except Exception as e:  # 待ちの時間切れなど。残りの設定は続ける
                    check(f"{cfg['name']} の途中で止まった", False, str(e).splitlines()[0])
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print(f"{check.n - check.ng}/{check.n} OK。スクリーンショット: {shots}")
    sys.exit(1 if check.ng else 0)


if __name__ == "__main__":
    main()
