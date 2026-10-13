// 使用 Vite 的 ?raw 导入 HTML 内容
import htmlRaw from './overlay.html?raw';

export default class OverlayManager {
  /**
   * @param {Object} options
   * @param {number} options.canvasWidth  - 浮层 canvas 像素宽度（分辨率）
   * @param {number} options.canvasHeight - 浮层 canvas 像素高度
   * @param {number} options.stageWidth   - 世界坐标宽度（例如 480）
   * @param {number} options.stageHeight  - 世界坐标高度（例如 360）
   * @param {HTMLCanvasElement} options.canvasElement - 主窗口中的 canvas 元素（用于计算偏移）
   * @param {nw.Window} options.mainWindow - 主窗口的 nw.Window 对象（用于监听关闭）
   * @param {boolean} options.autoCreate  - 是否在构造时自动创建窗口（默认 true）
   */
  constructor(options = {}) {
    // 合并默认参数
    this.options = {
      canvasWidth: 1920,
      canvasHeight: 1080,
      stageWidth: 480,
      stageHeight: 360,
      canvasElement: null,
      mainWindow: null,
      autoCreate: true,
      ...options,
    };

    // 私有属性（以 _ 开头）
    this._canvasWidth = this.options.canvasWidth;
    this._canvasHeight = this.options.canvasHeight;
    this._stageWidth = this.options.stageWidth;
    this._stageHeight = this.options.stageHeight;

    this._win = null;              // 浮层窗口对象
    this._canvas = null;           // 浮层 canvas 元素
    this._ctx = null;              // 浮层 canvas 2d context
    this._ready = false;           // 窗口是否加载完成
    this._disposed = false;        // 是否已销毁
    this._drawMode = 'offset';     // 'offset' | 'pixel'
    this._penWidth = 1;
    this._penColor = '#000000';

    // 偏移缓存（主 canvas 左上角在屏幕上的像素位置）
    this._offsetX = 0;
    this._offsetY = 0;

    // 就绪回调队列
    this._onReadyCallbacks = [];

    // 绑定事件处理函数
    this._onWindowLoaded = this._onWindowLoaded.bind(this);
    this._onMainWindowClose = this._onMainWindowClose.bind(this);

    // 如果提供了主窗口，立即注册关闭监听
    if (this.options.mainWindow) {
      this.registerMainWindow(this.options.mainWindow);
    }

    // 自动创建
    if (this.options.autoCreate !== false) {
      this.create();
    }
  }

  // ---------- 公开属性 ----------
  get ready() {
    return this._ready;
  }

  get stageWidth() {
    return this._stageWidth;
  }
  set stageWidth(value) {
    this._stageWidth = value;
  }

  get stageHeight() {
    return this._stageHeight;
  }
  set stageHeight(value) {
    this._stageHeight = value;
  }

  // 浮层窗口对象（只读）
  get window() {
    return this._win;
  }
  // 浮层 canvas 元素（只读）
  get canvas() {
    return this._canvas;
  }
  // 浮层 canvas 上下文（只读）
  get context() {
    return this._ctx;
  }

  // ---------- 注册主窗口关闭 ----------
  registerMainWindow(mainWin) {
    if (mainWin && typeof mainWin.on === 'function') {
      // 移除旧监听（防止重复）
      if (this._mainWindow) {
        this._mainWindow.removeListener('close', this._onMainWindowClose);
      }
      this._mainWindow = mainWin;
      mainWin.on('close', this._onMainWindowClose);
    }
  }

  // ---------- 创建 / 销毁 ----------
  create() {
    if (this._win && !this._win.closed) {
      // 如果窗口已存在，先销毁再重建（避免冲突）
      this.dispose();
    }

    this._disposed = false;
    this._ready = false;

    // 使用 Blob 生成 URL（避免跨域和路径问题）
    const blob = new Blob([htmlRaw], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    const winOptions = {
      frame: false,
      transparent: true,
      always_on_top: true,
      focus: false,
      show_in_taskbar: false,
      resizable: false,
      x: 0,
      y: 0,
      width: screen.availWidth,
      height: screen.availHeight,
    };

    this._win = nw.Window.open(url, winOptions);

    // 监听加载完成
    this._win.on('loaded', this._onWindowLoaded);

    // 如果窗口加载失败或意外关闭，清理状态
    this._win.on('closed', () => {
      if (!this._disposed) {
        this._win = null;
        this._canvas = null;
        this._ctx = null;
        this._ready = false;
      }
    });

    return this._win;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;

    if (this._win && !this._win.closed) {
      this._win.removeListener('loaded', this._onWindowLoaded);
      this._win.close();
    }
    this._win = null;
    this._canvas = null;
    this._ctx = null;

    // 移除主窗口监听
    if (this._mainWindow) {
      this._mainWindow.removeListener('close', this._onMainWindowClose);
      this._mainWindow = null;
    }
  }

  // 重新创建（dispose 后再次创建）
  recreate() {
    this.create();
  }

  // ---------- 就绪回调 ----------
  onReady(callback) {
    if (typeof callback !== 'function') return;
    if (this._ready) {
      callback(this);
    } else {
      this._onReadyCallbacks.push(callback);
    }
  }

  // ---------- 坐标更新 ----------
  updateOffsets() {
    if (!this.options.canvasElement) {
      this._offsetX = 0;
      this._offsetY = 0;
      return;
    }

    const el = this.options.canvasElement;
    const rect = el.getBoundingClientRect();

    // 获取主窗口在屏幕上的位置
    let mainWinX = 0,
      mainWinY = 0;
    if (this._mainWindow) {
      const pos = this._mainWindow.getPosition();
      mainWinX = pos[0];
      mainWinY = pos[1];
    } else {
      // 如果未提供主窗口，尝试获取当前窗口（渲染进程）
      try {
        const curWin = nw.Window.get();
        const pos = curWin.getPosition();
        mainWinX = pos[0];
        mainWinY = pos[1];
      } catch (_) {
        // 忽略
      }
    }

    this._offsetX = rect.left + mainWinX;
    this._offsetY = rect.top + mainWinY;
  }

  // ---------- 坐标转换 ----------
  // 世界坐标 → 屏幕像素（浮层 canvas 像素）
  _worldToPixel(wx, wy) {
    const halfW = this._stageWidth / 2;
    const halfH = this._stageHeight / 2;
    const px = (wx / halfW) * (this._canvasWidth / 2) + this._canvasWidth / 2;
    const py = -(wy / halfH) * (this._canvasHeight / 2) + this._canvasHeight / 2; // y 轴向上
    return { x: px + this._offsetX, y: py + this._offsetY };
  }

  // 像素模式：直接返回屏幕像素坐标（不做映射）
  _pixelToCanvas(px, py) {
    return { x: px, y: py };
  }

  // 根据当前绘制模式转换坐标
  _transformCoords(x, y) {
    if (this._drawMode === 'pixel') {
      return this._pixelToCanvas(x, y);
    } else {
      return this._worldToPixel(x, y);
    }
  }

  // ---------- 绘制模式 ----------
  setDrawMode(mode) {
    if (mode === 'offset' || mode === 'pixel') {
      this._drawMode = mode;
    } else {
      throw new Error('Invalid draw mode. Use "offset" or "pixel"');
    }
  }

  // ---------- 画笔属性 ----------
  setPenWidth(width) {
    this._penWidth = width;
  }

  setPenColor(color) {
    // 简单校验 #RRGGBB 格式
    if (/^#[\da-fA-F]{6}$/.test(color)) {
      this._penColor = color;
    } else {
      console.warn('Invalid color format, use #rrggbb');
    }
  }

  // ---------- 绘制 API ----------
  drawLine(x1, y1, x2, y2) {
    if (!this._ctx || !this._ready) return;
    const p1 = this._transformCoords(x1, y1);
    const p2 = this._transformCoords(x2, y2);
    this._ctx.save();
    this._ctx.lineWidth = this._penWidth;
    this._ctx.strokeStyle = this._penColor;
    this._ctx.beginPath();
    this._ctx.moveTo(p1.x, p1.y);
    this._ctx.lineTo(p2.x, p2.y);
    this._ctx.stroke();
    this._ctx.restore();
  }

  drawPoint(x, y) {
    if (!this._ctx || !this._ready) return;
    const p = this._transformCoords(x, y);
    this._ctx.save();
    this._ctx.fillStyle = this._penColor;
    this._ctx.beginPath();
    this._ctx.arc(p.x, p.y, this._penWidth / 2, 0, Math.PI * 2);
    this._ctx.fill();
    this._ctx.restore();
  }

  /**
   * 绘制图像
   * @param {CanvasImageSource} img  - 图像源
   * @param {number} x  - x 坐标（世界或像素，取决于模式）
   * @param {number} y  - y 坐标
   * @param {number} sx - 水平缩放（1 为原始大小）
   * @param {number} sy - 垂直缩放
   * @param {number} rot - 旋转弧度（可选）
   * @param {number} rotx - 旋转中心偏移 x（像素，相对于图片左上角，可选，默认图片中心）
   * @param {number} roty - 旋转中心偏移 y（像素）
   */
  drawImg(img, x, y, sx, sy, rot = 0, rotx = undefined, roty = undefined) {
    if (!this._ctx || !this._ready) return;
    const p = this._transformCoords(x, y);
    this._ctx.save();
    this._ctx.translate(p.x, p.y);

    // 缩放
    if (sx !== 1 || sy !== 1) {
      this._ctx.scale(sx, sy);
    }

    // 旋转
    if (rot !== 0) {
      // 旋转中心：默认图片中心
      let cx = img.width / 2;
      let cy = img.height / 2;
      if (rotx !== undefined && roty !== undefined) {
        cx = rotx;
        cy = roty;
      }
      this._ctx.translate(cx, cy);
      this._ctx.rotate(rot);
      this._ctx.translate(-cx, -cy);
    }

    // 绘制（图片左上角与 p 对齐）
    this._ctx.drawImage(img, 0, 0, img.width, img.height);
    this._ctx.restore();
  }

  // ---------- 分辨率控制 ----------
  setCanvasPixel(width, height) {
    this._canvasWidth = width;
    this._canvasHeight = height;
    if (this._canvas) {
      this._canvas.width = width;
      this._canvas.height = height;
    }
  }

  // ---------- 清屏 ----------
  clearCanvas() {
    if (this._ctx && this._ready) {
      this._ctx.clearRect(0, 0, this._canvasWidth, this._canvasHeight);
    }
  }

  // ---------- 内部事件处理 ----------
  _onWindowLoaded() {
    if (this._disposed) return;
    // 获取 canvas
    this._canvas = this._win.window.document.getElementById('renderCanvas');
    if (!this._canvas) {
      console.error('OverlayManager: Canvas element not found');
      return;
    }
    this._ctx = this._canvas.getContext('2d');

    // 设置分辨率
    this.setCanvasPixel(this._canvasWidth, this._canvasHeight);

    // 更新偏移量
    this.updateOffsets();

    // 标记就绪
    this._ready = true;

    // 触发所有就绪回调
    this._onReadyCallbacks.forEach((cb) => cb(this));
    this._onReadyCallbacks = [];
  }

  _onMainWindowClose() {
    this.dispose();
  }
}