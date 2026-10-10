#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.61.0", "rangehttpserver"]
# ///
"""再生まわり（1行ずつ・次・もう一度・続きから）を、WebKit（iPhone の Safari と同じエンジン）の実際の <video> で確かめる。

  uv run test/webkit-check.py --setup        # 初回だけ。Playwright の WebKit と、それが要るライブラリを sudo なしで用意する
  uv run test/webkit-check.py                # 合成した動画（ffmpeg の testsrc）と合成した字幕で確かめる
  uv run test/webkit-check.py --video A.mp4 --data A.study.json   # 実データで（どちらも読むだけ）
  uv run test/webkit-check.py --root 別の版のフォルダ               # 直す前の版・わざと壊した版で、この確認が不具合を見つけるか試す
  uv run test/webkit-check.py --engine chromium                    # 同じ確認を Chromium で

Playwright の Linux 版 WebKit（WPE）は、そのままだと GStreamer などのライブラリが足りずに起動しない。--setup は
apt-get download で取った .deb を dpkg -x で --webkit のフォルダに展開し（システムには入れない）、そこを LD_LIBRARY_PATH に
足して起動する包み（wk/pw_run.sh）を作る。パッケージ名は Ubuntu 24.04 のもの。--setup の途中で Playwright が
「Host system is missing dependencies」と長い警告を出すが、足りない分はこの後で展開するので気にしなくてよい（最後に
「まだ足りないライブラリ: なし」と出れば揃っている）。置き場の既定は ~/.cache/study-player-webkit（/tmp は日をまたぐと消える）。

見るもの（行の少し手前から再生する作りで、行の判定が 1 つ前にずれる症状と、WebKit だけの経路）:
  s1  行の頭へ飛んだ直後（巻き戻し中）に止め、1行ずつ をオンにして再生 → その行の終わりで止まり、色はその行
  s2  巻き戻し中に止めて一覧へ戻る → 開き直して「続きから」 → その行から
  s2b 巻き戻し中（シーク中を含む）に一覧へ戻る → 保存した時刻がその行の中
  s3  1行ずつ で止めた後に「次」をダブルクリック → 2 つ先の行の終わりで止まり、色はその行
  s3b 「次」を JS で 2 回（間を空けない・40ms・150ms）。WebKit も、1 回目のシークの処理が済んで seeking が届く前に 2 回目が
      来ると seeking が 2 回届き、どちらも後の飛び先を指す（Chromium と同じ形）。直す前の版は間を空けない時に外れる
  s4  1行ずつ をオンのまま開き直し、行に触らず ▶ → 最初の行の終わりで止まる
  s5  1行ずつ で止めた後に「もう一度」をダブルクリック → 同じ行を頭から再生して終わりで止まる
  s5b 「もう一度」を JS で 2 回。WebKit は 1 回目のシークの最中に同じ時刻へ飛ばすと何もしないシークとして扱い、
      seeking を早く解いて、seeking（v.seeking は false）と seeked をすぐ出す。その経路を踏んだか（no-op）も出す
  s6  最初の行を再生した後（自分のシークの印が 0 秒近く）に見終わり、1行ずつ をオンにして ▶ → 最初の行の終わりで止まる
  s7  1行ずつ で再生中に「一覧」→ 確かめを 0.3 秒・3 秒開いたままキャンセル → 一覧へ戻らず、確かめが出た時には動画が止まって
      いて、キャンセルで再生に戻り、迷った時間によらずその行の終わりで止まる。押す前から閉じた後までに動画が進んだ秒数も出す
      （変更前の版は確かめが無い。確かめの前に止めない版は、WPE では 3 秒迷うと 3.0〜3.7 秒進んで止める点を過ぎる）
WPE は動画を GStreamer で再生するので、シークの所要時間やイベントの間合いは iPhone（AVFoundation を GPU プロセスで動かす）と
同じではない。seeking / seeked の出し方（HTMLMediaElement）は WebCore の共通の処理。
環境の都合: 動画を選んだ直後は rAF が 2〜3 Hz に落ちることがある（止まる位置が 0.2 秒ほど遅れる）ので、60Hz 近くに戻るまで
待ってから操作する。シークの後に再生が進まなくなることもまれにある。その試行は SKIP にして数えない。
このリポジトリは公開なので、実データの英文・訳はここに書かない（合成した字幕は意味の無い文）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
ROLL, PAD = 0.25, 0.25  # ページと同じ値
PKGS = ("libatomic1 libavif16 libenchant-2-2 libevent-2.1-7t64 libgstreamer-plugins-base1.0-0 libgstreamer-plugins-bad1.0-0 "
        "libgstreamer-gl1.0-0 libharfbuzz-icu0 libhyphen0 libwebpdemux2 libwoff1 libxslt1.1 gstreamer1.0-plugins-base "
        "gstreamer1.0-plugins-good gstreamer1.0-libav gstreamer1.0-plugins-bad").split()
WRAPPER = """#!/bin/sh
MYDIR="$(dirname "$(readlink -f "$0")")"
SYSROOT="{root}"
export WEBKIT_EXEC_PATH="$MYDIR/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$MYDIR/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="$MYDIR/share"
export LD_LIBRARY_PATH="$MYDIR/lib:$MYDIR/sys/lib:$SYSROOT/usr/lib/x86_64-linux-gnu:$SYSROOT/lib/x86_64-linux-gnu"
export GST_PLUGIN_SYSTEM_PATH_1_0="$SYSROOT/usr/lib/x86_64-linux-gnu/gstreamer-1.0:/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
export GST_REGISTRY_1_0="{base}/gst-registry.bin"
export GST_PLUGIN_SCANNER_1_0=/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner
export GIO_EXTRA_MODULES="$SYSROOT/usr/lib/x86_64-linux-gnu/gio/modules"
exec "$MYDIR/bin/MiniBrowser" "$@"
"""


# ---------------- WebKit の用意（sudo なし） ----------------
def setup(base: Path) -> None:
    subprocess.run([sys.executable, "-m", "playwright", "install", "webkit"], check=True)
    with sync_playwright() as p:
        src = Path(p.webkit.executable_path).parent  # ~/.cache/ms-playwright/webkit-NNNN
    debs, root = base / "debs", base / "sysroot"
    debs.mkdir(parents=True, exist_ok=True)
    root.mkdir(exist_ok=True)
    sim = subprocess.run(["apt-get", "-s", "install", "--no-install-recommends", *PKGS], capture_output=True, text=True, check=True)
    need = [line.split()[1] for line in sim.stdout.splitlines() if line.startswith("Inst ")]
    print(f"足りないパッケージ {len(need)} 個を {debs} に取って {root} に展開する（システムには入れない）")
    if need:
        subprocess.run(["apt-get", "download", *need], cwd=debs, check=True)
    for deb in sorted(debs.glob("*.deb")):
        subprocess.run(["dpkg", "-x", str(deb), str(root)], check=True)
    wk = base / "wk"
    mb = wk / "minibrowser-wpe"
    mb.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "pw_run.sh", wk / "pw_run.sh")
    for name in ("bin", "lib", "share", "sys"):
        link = mb / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(src / "minibrowser-wpe" / name)
    (mb / "MiniBrowser").write_text(WRAPPER.format(root=root, base=base))
    (mb / "MiniBrowser").chmod(0o755)
    env = dict(os.environ, LD_LIBRARY_PATH=f"{mb}/lib:{mb}/sys/lib:{root}/usr/lib/x86_64-linux-gnu:{root}/lib/x86_64-linux-gnu")
    missing = set()
    for f in list((mb / "bin").iterdir()) + list((mb / "lib").glob("*.so*")):
        out = subprocess.run(["ldd", str(f)], capture_output=True, text=True, env=env).stdout
        missing |= {line.split()[0] for line in out.splitlines() if "not found" in line}
    print("まだ足りないライブラリ:", sorted(missing) or "なし")
    print(f"起動の包み: {wk / 'pw_run.sh'}")


# ---------------- 字幕データ ----------------
# 行 6 は行 5 の終わりにすき間なく続く（巻き戻し中に時刻で引くと 1 つ前の行に当たる継ぎ目）。行 1 は 0 秒近くから始まる
SYN = [(0.02, 1.80), (3.00, 4.50), (5.00, 6.20), (6.60, 8.00), (9.00, 9.60), (10.50, 12.40), (12.40, 14.80), (15.10, 16.60),
       (17.00, 19.00), (19.50, 21.50)] + [(22.0 + 2.5 * i, 23.8 + 2.5 * i) for i in range(7)]


def synth(work: Path) -> tuple[Path, Path]:
    video, data = work / "webkit-check.mp4", work / "webkit-check.study.json"
    dur = 40.0
    if not video.exists():
        # キーフレームは 5 秒おき（実際の動画もまばらで、シークに時間がかかる）
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi",
                        "-i", "sine=frequency=440", "-t", str(dur), "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
                        "-g", "125", "-keyint_min", "125", "-sc_threshold", "0", "-c:a", "aac", "-movflags", "+faststart",
                        str(video)], check=True)
    cues = [{"s": s, "e": e, "t": f"Synthetic line {k + 1}.", "ja": f"合成した行 {k + 1}"} for k, (s, e) in enumerate(SYN)]
    data.write_text(json.dumps({"format": "study-player/1", "id": "webkit-check-synth", "title": "合成した字幕（再生の確認用）",
                                "video": video.name, "duration": dur, "lang": "en", "cues": cues}, ensure_ascii=False), encoding="utf-8")
    return video, data


# ---------------- ページの操作 ----------------
LOGGER = """() => {
  const v = document.getElementById('v');
  window.__cur = () => Array.from(document.querySelectorAll('.cue')).findIndex((e) => e.classList.contains('cur'));
  if (window.__logged) return; window.__logged = true; window.__log = [];
  for (const e of ['seeking', 'seeked', 'play', 'pause', 'ended', 'error'])
    v.addEventListener(e, () => window.__log.push([e, Math.round(performance.now()), +v.currentTime.toFixed(3), v.seeking ? 1 : 0, v.paused ? 1 : 0, window.__cur()]));
}"""
# 「一覧」の確かめが出た時に動画が止まっているかを、ページの中で記録する（ダイアログの間はページの外からは読めない）。
# 進んだ秒数はここでは測れない（currentTime は 1 回の処理の中では変わらず、ダイアログを閉じた直後も開く前と同じ値を返す。
# WPE で 3 秒迷っても 0.00 だった）ので、押す前と閉じた後の時刻をページの外から比べる
CONFIRM_SPY = """() => {
  if (window.__confirmSpy) return; window.__confirmSpy = [];
  const v = document.getElementById('v'), orig = window.confirm;
  window.confirm = (msg) => { const a = { paused: v.paused }; a.answer = orig.call(window, msg); window.__confirmSpy.push(a); return a.answer; };
}"""
RAF_SETTLE = """async () => { const until = performance.now() + 20000; let med = 999;
  while (performance.now() < until) {
    const ts = await new Promise((res) => { const a = []; const f = (t) => { a.push(t); if (a.length < 12) requestAnimationFrame(f); else res(a); }; requestAnimationFrame(f); });
    const d = ts.slice(1).map((t, i) => t - ts[i]).sort((x, y) => x - y); med = d[d.length >> 1];
    if (med < 40) break; }
  return med; }"""


class Run:
    def __init__(self, browser, url: str, video: Path, data: Path, verbose: bool):
        self.b, self.url, self.video, self.data, self.verbose = browser, url, video, data, verbose
        d = json.loads(data.read_text(encoding="utf-8"))
        self.id = str(d.get("id") or d.get("video") or data.name)
        self.cues = [(float(c["s"]), float(c["e"])) for c in d["cues"]]
        self.duration = float(d.get("duration") or 0)
        self.results: list[tuple[str, str, str]] = []
        # 「一覧」の確かめへの次の答え（OK か、迷う秒数の後にキャンセルか）。1 回答えたら既定（すぐ OK）に戻す
        self.dialog_next: tuple[bool, float] = (True, 0.0)
        self.dialogs = 0
        # 前の行の終わりにすき間なく続き、行の頭の ROLL 秒手前がまだ前の行の中にある行（巻き戻し中に時刻で引くと 1 つ前に当たる）
        self.k = next((k for k in range(2, len(self.cues) - 1) if self.cues[k][0] > 5
                       and abs(self.cues[k][0] - self.cues[k - 1][1]) < 0.005 and self.cues[k][0] - ROLL >= self.cues[k - 1][0]), None)

    def ep(self, k: int) -> float:
        s, e = self.cues[k]
        return max(e, min(e + PAD, self.cues[k + 1][0])) if k + 1 < len(self.cues) else e + PAD

    def cue_at(self, t: float) -> int:
        return max((k for k, (s, _) in enumerate(self.cues) if s <= t), default=-1)

    def stop_row_at(self, t: float) -> int:
        """時刻 t から引いた「1行ずつ」の止める行（ページの式と同じ）"""
        c = self.cue_at(t)
        return 0 if c < 0 else (c if t < self.ep(c) else c + 1)

    def on_dialog(self, d) -> None:
        """「一覧」の確かめ。ダイアログが開いている間はページのスクリプトが止まる。迷う時間はここで待つ"""
        ok, wait = self.dialog_next
        self.dialog_next = (True, 0.0)
        self.dialogs += 1
        if wait:
            time.sleep(wait)
        if ok:
            d.accept()
        else:
            d.dismiss()

    def record(self, name: str, result: str, detail: str) -> None:
        self.results.append((name, result, detail))
        print(f"  {result:4} {name}  {detail}")

    # --- 部品 ---
    def page(self):
        ctx = self.b.new_context(viewport={"width": 375, "height": 812}, service_workers="block")
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: self.record("ページのエラー", "NG", str(e)))
        pg.on("dialog", self.on_dialog)  # 動画を読み込んでいる時の「一覧」の確かめ（既定は OK で戻る。s7 はキャンセル）
        pg.goto(self.url)
        pg.set_input_files("#addData", str(self.data))
        pg.wait_for_selector("#lib li .open")
        return ctx, pg

    def pick(self, pg) -> None:
        pg.click("#lib li .open")
        pg.set_input_files("#pickVideo", str(self.video))
        pg.wait_for_function("document.getElementById('picker').hidden === true", timeout=40000)
        pg.evaluate(LOGGER)
        pg.evaluate(RAF_SETTLE)
        pg.evaluate("() => { window.__log = []; }")

    def st(self, pg) -> dict:
        return pg.evaluate("""(id) => { const v = document.getElementById('v'); const s = localStorage.getItem('sp:t:' + id);
          return { ct: +v.currentTime.toFixed(3), paused: v.paused, seeking: v.seeking, cur: window.__cur ? window.__cur() : -9,
                   saved: s === null ? null : +(+s).toFixed(3) }; }""", self.id)

    def log(self, pg) -> list:
        return pg.evaluate("() => { const l = window.__log || []; window.__log = []; return l; }")

    @staticmethod
    def tap(pg, k: int) -> None:
        pg.evaluate("k => document.querySelectorAll('.cue')[k].click()", k)

    @staticmethod
    def wait_paused(pg, ms: int) -> bool:
        try:
            pg.wait_for_function("() => { const v = document.getElementById('v'); return v.paused && !v.seeking; }", timeout=ms)
            return True
        except Exception:  # noqa: BLE001  時間切れ
            return False

    @staticmethod
    def set_step(pg, on: bool) -> None:
        if (pg.evaluate("document.getElementById('step').getAttribute('aria-pressed')") == "true") != on:
            pg.click("#step")

    def stopped_at(self, pg, k: int, ms: int = 10000) -> tuple[bool, dict]:
        ok = self.wait_paused(pg, ms)
        s = self.st(pg)
        return ok and s["cur"] == k and self.ep(k) - 0.05 <= s["ct"] <= self.ep(k) + 0.5, s

    def detail(self, s: dict, log: list | None = None) -> str:
        text = f"時刻 {s['ct']} 色の行 {s['cur'] + 1 if s['cur'] >= 0 else 'なし'}"
        if self.verbose and log:
            text += " " + str([(x[0], x[2], x[3]) for x in log if x[0] in ("seeking", "seeked")])
        return text

    def stop_line(self, pg, k: int) -> bool:
        """行 k をタップし（1行ずつ はオンにしておく）、終わりで止まるのを待つ。止まらなければ再生が進まない環境の不調とみなす"""
        self.tap(pg, k)
        return self.wait_paused(pg, 15000)

    # --- 場面 ---
    def s1(self):
        k = self.k
        ctx, pg = self.page()
        self.pick(pg)
        self.set_step(pg, False)
        pg.evaluate("() => { const v = document.getElementById('v'); v.addEventListener('seeked', () => v.pause(), { once: true }); }")
        self.tap(pg, k)
        self.wait_paused(pg, 15000)
        self.set_step(pg, True)
        pg.evaluate("document.getElementById('v').play()")
        ok, s = self.stopped_at(pg, k)
        self.record(f"s1 巻き戻し中に 1行ずつ をオン → 行 {k + 1} の終わり {self.ep(k):.2f} で止まる", "OK" if ok else "NG", self.detail(s))
        ctx.close()

    def s2(self):
        k = self.k
        ctx, pg = self.page()
        self.pick(pg)
        self.set_step(pg, False)
        pg.evaluate("() => { const v = document.getElementById('v'); v.addEventListener('seeked', () => v.pause(), { once: true }); }")
        self.tap(pg, k)
        self.wait_paused(pg, 15000)
        pg.click("#back")
        saved = self.st(pg)["saved"]
        self.pick(pg)
        try:
            pg.wait_for_selector("#info button", timeout=10000)
            pg.click("#info button")
            s = self.st(pg)
        except Exception:  # noqa: BLE001  「続きから」が出ない
            s = dict(self.st(pg), cur=-1)
        ok = saved is not None and abs(saved - self.cues[k][0]) < 0.005 and s["cur"] == k
        self.record(f"s2 巻き戻し中に一覧へ → 続きから は行 {k + 1}", "OK" if ok else "NG", f"保存 {saved} / " + self.detail(s))
        ctx.close()

    def s2b(self):
        k = self.k
        ctx, pg = self.page()
        for delay in (30, 120, 250):
            self.pick(pg)
            self.set_step(pg, False)
            self.tap(pg, k)
            r = pg.evaluate("""async ([d, id]) => { await new Promise((r) => setTimeout(r, d)); const v = document.getElementById('v');
                const ct = +v.currentTime.toFixed(3), sk = v.seeking; document.getElementById('back').click();
                return { ct, sk, saved: localStorage.getItem('sp:t:' + id) }; }""", [delay, self.id])
            saved = float(r["saved"]) if r["saved"] else None
            ok = saved is not None and self.cue_at(saved) == k
            self.record(f"s2b タップから {delay}ms で一覧へ → 保存は行 {k + 1} の中", "OK" if ok else "NG",
                        f"その時 時刻 {r['ct']} seeking={int(r['sk'])} / 保存 {saved}")
        ctx.close()

    def s3(self, trials: int = 3):
        k = self.k
        for t in range(trials):
            ctx, pg = self.page()
            self.pick(pg)
            self.set_step(pg, True)
            name = f"s3 行 {k - 1} で止めて「次」をダブルクリック → 行 {k + 1} の終わりで止まる（{t + 1} 回目）"
            if not self.stop_line(pg, k - 2):
                self.record(name, "SKIP", "前の行で止まらない（再生が進まない）")
            else:
                self.log(pg)
                pg.dblclick("#next")
                ok, s = self.stopped_at(pg, k)
                self.record(name, "OK" if ok else "NG", self.detail(s, self.log(pg)))
            ctx.close()

    def s3b(self):
        k = self.k
        for gap in (0, 40, 150):
            ctx, pg = self.page()
            self.pick(pg)
            self.set_step(pg, True)
            name = f"s3b 「次」を JS で 2 回（間 {gap}ms）→ 行 {k + 1} の終わりで止まる"
            if not self.stop_line(pg, k - 2):
                self.record(name, "SKIP", "前の行で止まらない（再生が進まない）")
            else:
                self.log(pg)
                pg.evaluate("g => { const n = document.getElementById('next'); n.click(); setTimeout(() => n.click(), g); }", gap)
                pg.wait_for_timeout(gap + 50)
                ok, s = self.stopped_at(pg, k)
                log = self.log(pg)
                seeks = [x[2] for x in log if x[0] == "seeking"]
                self.record(name, "OK" if ok else "NG", self.detail(s) + f" / seeking の時刻 {seeks}")
            ctx.close()

    def s4(self):
        ctx, pg = self.page()
        self.pick(pg)
        self.set_step(pg, True)
        self.stop_line(pg, min(10, len(self.cues) - 2))
        pg.click("#back")
        self.pick(pg)
        pg.evaluate("document.getElementById('v').play()")
        ok, s = self.stopped_at(pg, 0, 8000)
        self.record(f"s4 1行ずつ のまま開き直して ▶ → 行 1 の終わり {self.ep(0):.2f} で止まる", "OK" if ok else "NG", self.detail(s))
        ctx.close()

    def s5(self, trials: int = 3):
        k = self.k
        ctx, pg = self.page()
        self.pick(pg)
        self.set_step(pg, True)
        if not self.stop_line(pg, k):
            self.record("s5 「もう一度」のダブルクリック", "SKIP", "行で止まらない（再生が進まない）")
            ctx.close()
            return
        for t in range(trials):
            self.log(pg)
            pg.dblclick("#again")
            pg.wait_for_timeout(300)
            mid = self.st(pg)["ct"]
            ok, s = self.stopped_at(pg, k)
            log = self.log(pg)
            back = any(x[0] == "seeking" and abs(x[2] - (self.cues[k][0] - ROLL)) < 0.05 for x in log)
            ok = ok and back and mid < self.ep(k) - 0.1
            self.record(f"s5 「もう一度」をダブルクリック → 行 {k + 1} を頭から再生して終わりで止まる（{t + 1} 回目）",
                        "OK" if ok else "NG", self.detail(s, log) + f" / 0.3 秒後の時刻 {mid}")
        ctx.close()

    def s5b(self):
        k = self.k
        for gap in (0, 40, 120):
            ctx, pg = self.page()
            self.pick(pg)
            self.set_step(pg, True)
            name = f"s5b 「もう一度」を JS で 2 回（間 {gap}ms）→ 行 {k + 1} の終わりで止まる"
            if not self.stop_line(pg, k):
                self.record(name, "SKIP", "行で止まらない（再生が進まない）")
            else:
                self.log(pg)
                pg.evaluate("g => { const a = document.getElementById('again'); a.click(); setTimeout(() => a.click(), g); }", gap)
                pg.wait_for_timeout(gap + 60)
                mid = self.st(pg)["ct"]
                ok, s = self.stopped_at(pg, k)
                log = self.log(pg)
                noop = any(x[0] == "seeking" and x[3] == 0 for x in log)
                ok = ok and mid < self.ep(k) - 0.1
                self.record(name, "OK" if ok else "NG", self.detail(s) + f" / 何もしないシーク(seeking=false の seeking): {'あり' if noop else 'なし'}")
            ctx.close()

    def s6(self):
        ctx, pg = self.page()
        self.pick(pg)
        self.set_step(pg, True)
        name = f"s6 行 1 を再生した後に見終わって ▶ → 行 1 の終わり {self.ep(0):.2f} で止まる"
        if not self.stop_line(pg, 0):
            self.record(name, "SKIP", "行で止まらない（再生が進まない）")
            ctx.close()
            return
        self.set_step(pg, False)
        pg.evaluate("() => { const v = document.getElementById('v'); v.currentTime = v.duration - 1.2; v.play(); }")
        try:
            pg.wait_for_function("document.getElementById('v').ended", timeout=15000)
        except Exception:  # noqa: BLE001
            self.record(name, "SKIP", "終わりまで再生されない")
            ctx.close()
            return
        self.set_step(pg, True)
        pg.evaluate("document.getElementById('v').play()")
        ok, s = self.stopped_at(pg, 0, 8000)
        self.record(name, "OK" if ok else "NG", self.detail(s))
        ctx.close()

    def s7(self):
        """1行ずつ で再生中に「一覧」→ 確かめを開いたまま迷ってキャンセル。ダイアログの間はスクリプトが止まるが、動画は止めなければ
        進む（WPE の GStreamer での値。iPhone の AVFoundation で同じかは別）。ページは確かめの前に動画を止め、キャンセルなら再生に戻す。
        一覧へ戻らないこと、確かめが出た時に動画が止まっていること、押す前から閉じた後までに迷った分だけ進んではいないこと、
        キャンセルの後に再生していること、迷った時間によらずその行の終わりで止まることを見る"""
        r = next((k for k in range(len(self.cues) - 2) if self.cues[k][0] > 20 and self.cues[k][1] - self.cues[k][0] >= 1.5), None)
        if r is None:
            self.record("s7", "SKIP", "20 秒より後に 1.5 秒以上の行が無い")
            return
        for wait in (0.3, 3.0):
            name = (f"s7 1行ずつ で行 {r + 1} を再生中に一覧 → 確かめで {wait} 秒迷ってキャンセル → 一覧へ戻らず、確かめの間は動画が止まり、"
                    f"再生に戻って行 {r + 1} の終わりで止まる")
            ctx, pg = self.page()
            self.pick(pg)
            self.set_step(pg, True)
            pg.evaluate(CONFIRM_SPY)
            self.tap(pg, r)
            try:
                pg.wait_for_function(f"() => {{ const v = document.getElementById('v'); return !v.seeking && !v.paused && v.currentTime > {self.cues[r][0] + 0.3}; }}",
                                     timeout=15000)
            except Exception:  # noqa: BLE001  再生が進まない（環境の不調）
                self.record(name, "SKIP", "行の頭を越えて再生が進まない")
                ctx.close()
                continue
            t0 = self.st(pg)["ct"]
            n0 = self.dialogs
            self.dialog_next = (False, wait)
            pg.click("#back")
            s1 = self.st(pg)  # click がダイアログより先に戻っても、ここでダイアログに答え終わる
            asked = self.dialogs - n0
            still = pg.evaluate("() => !document.getElementById('playerView').hidden && document.getElementById('picker').hidden")
            spy = pg.evaluate("() => (window.__confirmSpy || []).slice(-1)[0] || null")
            if not still:
                self.record(name, "NG", f"確かめ {asked} 回、一覧へ戻った")
                ctx.close()
                continue
            # 確かめの間に止めない版は、迷う間に止める点を過ぎる（0.5 秒以上過ぎたら、その行では止めず時刻から引き直した行で止まる）。
            # 押す前から閉じた後までに進んだ秒数には、押すまでの遅れ（WPE で 0.3〜0.7 秒）が入るので、1.5 秒を超えた時だけ
            # 迷う間も進んだとみなす（止めない版は 3 秒迷うと 3 秒以上進む。0.3 秒の方はこの秒数では見分けられない）
            adv = s1["ct"] - t0
            ran = spy is None or not spy["paused"] or adv > 1.5
            want = r if s1["ct"] < self.ep(r) + 0.5 else self.stop_row_at(s1["ct"])
            ok_stop, s = self.stopped_at(pg, want)
            ok = asked == 1 and not ran and not s1["paused"] and want == r and ok_stop
            during = "確かめが出ない" if spy is None else f"確かめが出た時の動画 {'止まっている' if spy['paused'] else '再生中'}"
            self.record(name, "OK" if ok else "NG",
                        f"確かめ {asked} 回、{during}、キャンセルの後 {'止まったまま' if s1['paused'] else '再生中'}、"
                        f"押す前の時刻 {t0} → 閉じた後 {s1['ct']}（{adv:.2f} 秒進んだ。押すまでの遅れを含む）、止める行の期待 {want + 1}、"
                        + self.detail(s))
            ctx.close()


def serve(port: int, root: Path) -> tuple[subprocess.Popen, int]:
    """root を配信する（port が 0 なら空いている番号）。同じ番号で別の配信が動いていると、自分の配信は始まらずに終わるのに
    index.html は返ってくるので、別の版を黙って測ることになる（--root で直す前の版を渡した陰性対照が素通りする）。始まった後に、
    自分の配信が生きていることと、返ってきた index.html が root のものと同じことを確かめる。"""
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
    ap.add_argument("--setup", action="store_true", help="WebKit と足りないライブラリを --webkit に用意して終わる")
    ap.add_argument("--webkit", default=str(Path.home() / ".cache" / "study-player-webkit"), help="--setup で作るフォルダ")
    ap.add_argument("--engine", choices=["webkit", "chromium"], default="webkit")
    ap.add_argument("--video", help="動画（省くと合成する）")
    ap.add_argument("--data", help="字幕データ .study.json（省くと合成する。ファイルは変えない）")
    ap.add_argument("--work", help="合成した動画と字幕の置き場（省くと一時フォルダ）")
    ap.add_argument("--port", type=int, default=0, help="配信の番号（省くと空いている番号）")
    ap.add_argument("--root", default=str(REPO), help="配信するフォルダ（直す前の版などで、この確認が不具合を見つけるか試す時）")
    ap.add_argument("--only", help="この名前の場面だけ（カンマ区切り。例: s1,s3b）")
    ap.add_argument("-v", "--verbose", action="store_true", help="seeking / seeked の届き方も出す")
    a = ap.parse_args()
    base = Path(a.webkit).expanduser()
    if a.setup:
        setup(base)
        return
    if bool(a.video) != bool(a.data):
        sys.exit("--video と --data は両方渡すか、両方省く")
    exe = base / "wk" / "pw_run.sh"
    if a.engine == "webkit" and not exe.exists():
        sys.exit(f"{exe} が無い。先に uv run test/webkit-check.py --setup を一度回す")
    if a.data:
        video, data = Path(a.video), Path(a.data)
    else:
        work = Path(a.work or tempfile.mkdtemp(prefix="study-player-webkit-"))
        work.mkdir(parents=True, exist_ok=True)
        video, data = synth(work)
    only = set(a.only.split(",")) if a.only else None
    proc, port = serve(a.port, Path(a.root))
    try:
        with sync_playwright() as pw:
            browser = (pw.webkit.launch(executable_path=str(exe), headless=True) if a.engine == "webkit"
                       else pw.chromium.launch(headless=True))
            run = Run(browser, f"http://127.0.0.1:{port}/index.html", video, data, a.verbose)
            print(f"{a.engine} {browser.version} / 配信 {a.root}（{port} 番）/ 字幕 {len(run.cues)} 行"
                  + (f" / すき間なく続く行 {run.k + 1}" if run.k is not None else ""))
            for name in ("s1", "s2", "s2b", "s3", "s3b", "s4", "s5", "s5b", "s6", "s7"):
                if only and name not in only:
                    continue
                if run.k is None and name not in ("s4", "s6", "s7"):
                    run.record(name, "SKIP", "前の行にすき間なく続く行（5 秒より後）が字幕に無い")
                    continue
                try:
                    getattr(run, name)()
                except Exception as e:  # noqa: BLE001  待ちの時間切れなど。残りの場面は続ける
                    run.record(name, "NG", "途中で止まった: " + str(e).splitlines()[0])
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    n = {r: sum(1 for x in run.results if x[1] == r) for r in ("OK", "NG", "SKIP")}
    print(f"OK {n['OK']} / NG {n['NG']} / SKIP {n['SKIP']}")
    sys.exit(1 if n["NG"] else 0)


if __name__ == "__main__":
    main()
