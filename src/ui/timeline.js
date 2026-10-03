// 下のタイムライン。標高の面グラフに、色分け中の値を線で重ねる。クリック・ドラッグで移動。
import { METRICS, makeRamp } from '../palette.js';
import { fmtHM, fmtDist } from '../format.js';

export class Timeline {
  constructor(canvas, { onSeek, onHover }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onHover = onHover;
    this.track = null;
    this.metric = 'speed';
    this.static = document.createElement('canvas');
    this.hoverX = -1;
    this.dragging = false;
    this.pad = { t: 8, b: 18, l: 2, r: 2 };

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return Math.min(r.width - this.pad.r, Math.max(this.pad.l, e.clientX - r.left));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.track) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.onSeek(this.timeAtX(pos(e)));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.track) return;
      this.hoverX = pos(e);
      if (this.dragging) this.onSeek(this.timeAtX(this.hoverX));
      this.onHover?.(this.timeAtX(this.hoverX), this.hoverX);
    });
    const up = () => {
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = -1;
      this.onHover?.(null);
    });
    new ResizeObserver(() => this.layout()).observe(canvas);
  }

  setTrack(track) {
    this.track = track;
    this.layout();
  }

  setMetric(metric) {
    this.metric = metric;
    this.renderStatic();
  }

  get w() {
    return this.canvas.clientWidth;
  }
  get h() {
    return this.canvas.clientHeight;
  }

  /** x（CSS px）→ 時刻 */
  timeAtX(x) {
    const t = this.track;
    const u = (x - this.pad.l) / Math.max(1, this.w - this.pad.l - this.pad.r);
    if (t.hasTime) return t.t0 + u * (t.t1 - t.t0);
    // 時刻がないときは距離で並べる（t は距離に比例している）
    return t.timeAtSample(u * (t.samples.n - 1));
  }

  xAtTime(tm) {
    const t = this.track;
    const iw = this.w - this.pad.l - this.pad.r;
    if (t.hasTime) return this.pad.l + ((tm - t.t0) / (t.t1 - t.t0)) * iw;
    const st = t.at(tm);
    return this.pad.l + (st.s / (t.samples.n - 1)) * iw;
  }

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, this.w);
    const h = Math.max(1, this.h);
    for (const c of [this.canvas, this.static]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.renderStatic();
  }

  /** 値の列を作る（横 1px ごと） */
  columns() {
    const t = this.track;
    const S = t.samples;
    const W = Math.max(2, Math.round(this.w - this.pad.l - this.pad.r));
    const ele = new Float32Array(W);
    const val = new Float32Array(W);
    const sIdx = new Float32Array(W);
    const st = {};
    for (let c = 0; c < W; c++) {
      const u = c / (W - 1);
      let s;
      if (t.hasTime) s = t.at(t.t0 + u * (t.t1 - t.t0), st).s;
      else s = u * (S.n - 1);
      sIdx[c] = s;
      ele[c] = t.sampleValue(S.ele, s);
      switch (this.metric) {
        case 'speed':
          val[c] = t.hasTime ? t.at(t.t0 + u * (t.t1 - t.t0), st).speed * 3.6 : t.sampleValue(S.speed, s) * 3.6;
          break;
        case 'ele':
          val[c] = ele[c];
          break;
        case 'time':
          val[c] = t.sampleValue(S.timeFrac, s);
          break;
        case 'grade':
          val[c] = t.sampleValue(S.grade, s);
          break;
        case 'hr':
          val[c] = t.sampleValue(S.hr, s);
          break;
      }
    }
    return { W, ele, val, sIdx };
  }

  renderStatic() {
    const t = this.track;
    const g = this.static.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.static.width, this.static.height);
    if (!t) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { t: pt, b: pb, l: pl } = this.pad;
    const H = this.h - pt - pb;
    const { W, ele, val } = this.columns();
    this.cols = { W, ele, val };

    // 休憩の帯
    if (t.hasTime) {
      g.fillStyle = 'rgba(255, 195, 92, 0.10)';
      for (const s of t.stops) {
        const x0 = this.xAtTime(s.tStart);
        const x1 = this.xAtTime(s.tEnd);
        g.fillRect(x0, pt, Math.max(1, x1 - x0), H);
      }
    }

    // 標高の面
    let eMin = Infinity;
    let eMax = -Infinity;
    for (let c = 0; c < W; c++) {
      eMin = Math.min(eMin, ele[c]);
      eMax = Math.max(eMax, ele[c]);
    }
    const eRange = Math.max(5, eMax - eMin);
    const eLo = eMin - eRange * 0.08;
    const yE = (v) => pt + H - ((v - eLo) / (eRange * 1.16)) * H;
    const grad = g.createLinearGradient(0, pt, 0, pt + H);
    grad.addColorStop(0, 'rgba(255,255,255,0.20)');
    grad.addColorStop(1, 'rgba(255,255,255,0.02)');
    g.beginPath();
    g.moveTo(pl, pt + H);
    for (let c = 0; c < W; c++) g.lineTo(pl + c, yE(ele[c]));
    g.lineTo(pl + W - 1, pt + H);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    for (let c = 0; c < W; c++) g.lineTo(pl + c, yE(ele[c]));
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.stroke();

    // 色分けの値（標高のときは標高の線を色付け）
    const m = METRICS[this.metric];
    const ramp = makeRamp(m.stops);
    const [lo, hi] = t.ranges[this.metric];
    // 線の縦の範囲。速度は 0 から、心拍は少し余白をとる
    let yLo = lo;
    let yHi = hi;
    if (this.metric === 'speed') {
      yLo = 0;
      yHi = hi * 1.15;
    } else if (this.metric === 'hr') {
      yLo = lo - 10;
      yHi = hi + 5;
    }
    const yV = this.metric === 'ele' ? yE : (v) => pt + H - (Math.min(1.04, Math.max(-0.02, (v - yLo) / (yHi - yLo || 1))) * 0.86 + 0.04) * H;
    g.lineWidth = 2;
    g.lineCap = 'round';
    const step = 2;
    for (let c = 0; c < W - step; c += step) {
      const v = val[c];
      g.strokeStyle = ramp((v - lo) / (hi - lo || 1)).getStyle();
      g.beginPath();
      g.moveTo(pl + c, yV(v));
      g.lineTo(pl + c + step, yV(val[c + step]));
      g.stroke();
    }
    this.yV = yV;
    this.lo = lo;
    this.hi = hi;

    // 目盛り
    g.fillStyle = 'rgba(200,210,235,0.6)';
    g.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'alphabetic';
    if (t.hasTime) {
      const span = t.t1 - t.t0;
      const mins = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((v) => v * 60000);
      const pxPerMs = W / span;
      const tick = mins.find((v) => v * pxPerMs >= 70) ?? mins[mins.length - 1];
      const first = Math.ceil(t.t0 / tick) * tick;
      for (let tm = first; tm <= t.t1; tm += tick) {
        const x = this.xAtTime(tm);
        if (x < 18 || x > this.w - 18) continue;
        g.fillRect(x, pt + H, 1, 3);
        g.textAlign = 'center';
        g.fillText(fmtHM(tm), x, this.h - 3);
      }
    } else {
      const total = t.total;
      const marks = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      const tick = marks.find((v) => (v / total) * W >= 70) ?? 50000;
      for (let dd = tick; dd < total; dd += tick) {
        const x = pl + (dd / total) * W;
        g.fillRect(x, pt + H, 1, 3);
        g.textAlign = 'center';
        g.fillText(fmtDist(dd), x, this.h - 3);
      }
    }
  }

  draw(currentT) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.track) return;
    g.drawImage(this.static, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { t: pt, b: pb } = this.pad;
    const H = this.h - pt - pb;
    const x = this.xAtTime(currentT);

    // 歩き終えた部分は少し明るく
    g.fillStyle = 'rgba(94, 231, 255, 0.07)';
    g.fillRect(this.pad.l, pt, Math.max(0, x - this.pad.l), H);

    if (this.hoverX >= 0) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(Math.round(this.hoverX), pt, 1, H);
    }

    // 再生位置
    const grad = g.createLinearGradient(0, pt, 0, pt + H);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(94,231,255,0.4)');
    g.fillStyle = grad;
    g.fillRect(Math.round(x) - 1, pt - 2, 2, H + 4);
    if (this.cols) {
      const c = Math.min(this.cols.W - 1, Math.max(0, Math.round(x - this.pad.l)));
      const y = this.yV(this.cols.val[c]);
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.shadowColor = 'rgba(94,231,255,0.9)';
      g.shadowBlur = 12;
      g.fill();
      g.shadowBlur = 0;
    }
  }
}
