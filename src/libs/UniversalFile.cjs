

function isNodeEnvironment() {
  // 检查是否存在 process 对象，并且 process.versions.node 是字符串
  return (
    typeof process !== 'undefined' &&
    process.versions !== null &&
    typeof process.versions.node === 'string'
  );
}

/**
 * UniversalFile - 跨环境文件操作类（浏览器 / Node.js / NW.js）
 * 将文件内容一次性加载到内存，所有读写均在缓存上进行，最后同步到磁盘。
 * 索引约定：所有行操作方法中，行号 lineIndex 从 0 开始（即第一行为 0）。
 */
class UniversalFile {
    /**
     * @param {string|null} filePath - 初始文件路径
     * @param {object} [options]
     * @param {string} [options.encoding='utf-8']
     * @param {string} [options.basePath] - 相对路径的基准目录
     */
    constructor(filePath = null, { encoding = 'utf-8', basePath = '' } = {}) {
        this.encoding = encoding;
        this.basePath = basePath;

        // ---------- 环境判断 ----------
        this._env = isNodeEnvironment()?'node':'browser';
        if (this._env === 'node') {
            this._fs = require('fs');
            this._path = require('path');
        } else {
            this._fs = null;
            this._path = null;
        }

        // ---------- 内部状态 ----------
        this._loaded = false;
        /** @type {ArrayBuffer|null} */
        this._contentBuffer = null;
        /** @type {fs.FileHandle|null} */
        this._handle = null;

        // ---------- 公共属性 ----------
        this.SupportFs = this._env === 'node';   // 是否支持真实文件系统
        this.File = null;                        // Node: FileHandle, Browser: Blob

        // 初始路径
        this.filePath = filePath;
    }




    // ========== 路径属性 ==========
    /** @type {string|null} */
    get filePath() {
        return this._filePath;
    }
    set filePath(value) {
        if (value === this._filePath) return;
        this._filePath = value;
        this._loaded = false;

        if (value == null) {
            this._resolvedPath = null;
            this.isAbsolute = false;
            return;
        }

        if (this._env === 'node') {
            console.log(this._path)
            this.isAbsolute = this._path.isAbsolute(value);
            const base = this.basePath || process.cwd();
            this._resolvedPath = this.isAbsolute ? value : this._path.resolve(base, value);
        } else {
            this.isAbsolute = /^(https?:|file:|data:|blob:|\/)/i.test(value);
            if (!this.isAbsolute) {
                const base = this.basePath || globalThis.location.href.replace(/[^/]*$/, '');
                this._resolvedPath = new URL(value, base).href;
            } else {
                this._resolvedPath = value;
            }
        }
    }

    /** 解析后的绝对路径 */
    get resolvedPath() {
        return this._resolvedPath;
    }

    // ========== 核心加载 ==========
    /**
     * 加载文件并缓存内容。若路径已变更，会自动关闭旧句柄并打开新文件。
     */
    async load() {
        if (this._loaded) return;
        if (!this._resolvedPath) throw new Error('未设置文件路径 (filePath)');

        // 关闭上一个可能还打开的句柄
        if (this._handle) {
            await this._handle.close().catch(() => { });
            this._handle = null;
        }

        if (this._env === 'node') {
            this._handle = await this._fs.promises.open(this._resolvedPath, 'a+');
            const buf = await this._fs.promises.readFile(this._resolvedPath);
            this._contentBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            this.File = this._handle;
        } else {
            const res = await fetch(this._resolvedPath);
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            this._contentBuffer = await res.arrayBuffer();
            this.File = new Blob([this._contentBuffer], {
                type: res.headers.get('Content-Type') || 'application/octet-stream'
            });
        }
        this._loaded = true;
    }

    // ========== 基础读取（基于缓存）==========
    async read() {
        this.#ensureLoaded();
        return new TextDecoder(this.encoding).decode(this._contentBuffer);
    }

    async readArrayBuffer() {
        this.#ensureLoaded();
        return this._contentBuffer.slice(0);
    }

    readBlob() {
        this.#ensureLoaded();
        return new Blob([this._contentBuffer]);
    }

    async readLine(lineIndex) {
        const lines = (await this.read()).split(/\r?\n/);
        return lines[lineIndex] ?? null;
    }

    // ========== 基础写入 ==========
    async write(content) {
        this.#ensureLoaded();
        const encoded = new TextEncoder().encode(content);
        this._contentBuffer = encoded.buffer;
        if (this._env === 'node') {
            await this._handle.truncate(0);
            await this._handle.write(encoded);
        } else {
            this.#download(content, this._filePath);
        }
    }

    async addLine(line) {
        this.#ensureLoaded();
        if (this._env === 'node') {
            const oldText = new TextDecoder(this.encoding).decode(this._contentBuffer);
            const newText = oldText ? oldText + '\n' + line : line;
            this._contentBuffer = new TextEncoder().encode(newText).buffer;
            await this._handle.write(new TextEncoder().encode((oldText ? '\n' : '') + line));
        } else {
            const oldText = new TextDecoder(this.encoding).decode(this._contentBuffer);
            const newText = oldText ? oldText + '\n' + line : line;
            this._contentBuffer = new TextEncoder().encode(newText).buffer;
            this.#download(newText, this._filePath);
        }
    }

    // ========== 新增行操作方法（索引从 0 开始）==========
    /**
     * 替换指定行的内容
     * @param {string} data - 新内容
     * @param {number} lineIndex - 行索引（0 为第一行）
     */
    async writeLine(data, lineIndex) {
        this.#ensureLoaded();
        const lines = this.#getLines();
        if (lineIndex < 0 || lineIndex >= lines.length) {
            throw new RangeError(`行索引 ${lineIndex} 超出范围 (0~${lines.length - 1})`);
        }
        lines[lineIndex] = data;
        const newText = lines.join('\n');
        await this.write(newText);
    }

    /**
     * 删除指定行，后续行索引自动减 1
     * @param {number} lineIndex - 要删除的行索引（0 开始）
     */
    async removeLine(lineIndex) {
        this.#ensureLoaded();
        const lines = this.#getLines();
        if (lineIndex < 0 || lineIndex >= lines.length) {
            throw new RangeError(`行索引 ${lineIndex} 超出范围 (0~${lines.length - 1})`);
        }
        lines.splice(lineIndex, 1);
        const newText = lines.join('\n');
        await this.write(newText);
    }

    /** 内部：将缓存文本按行分割为数组 */
    #getLines() {
        const text = new TextDecoder(this.encoding).decode(this._contentBuffer);
        return text.split(/\r?\n/);
    }

    // ========== JSON 快捷操作 ==========
    /**
     * 将对象保存为 JSON 文件（覆盖原有内容）
     * @param {object} obj - 要保存的对象
     */
    async saveObject(obj) {
        const json = JSON.stringify(obj, null, 2);
        await this.write(json);
    }

    /**
     * 从文件读取 JSON 并解析为对象
     * @returns {Promise<object>}
     */
    async loadObject() {
        const text = await this.read();
        return JSON.parse(text);
    }

    // ========== 资源管理 ==========
    /** 手动关闭文件句柄并清空缓存，防止内存泄漏 */
    async close() {
        if (this._handle) {
            await this._handle.close().catch(() => { });
            this._handle = null;
        }
        this._contentBuffer = null;
        this.File = null;
        this._loaded = false;
    }

    /** 强制重新加载（相当于 close + load） */
    async reload() {
        await this.close();
        await this.load();
    }

    /** 检查文件是否存在 */
    async exists() {
        if (!this._resolvedPath) return false;
        if (this._env === 'node') {
            try {
                await this._fs.promises.access(this._resolvedPath);
                return true;
            } catch { return false; }
        } else {
            try {
                await fetch(this._resolvedPath, { method: 'HEAD' });
                return true;
            } catch { return false; }
        }
    }

    // ========== 内部工具 ==========
    #ensureLoaded() {
        if (!this._loaded) throw new Error('请先调用 load() 加载文件');
    }

    #download(content, filename) {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename?.split('/').pop() || 'file.txt';
        a.click();
        URL.revokeObjectURL(url);
    }

    #detectEnv() {
        try {
            if (typeof process !== 'undefined' && process.versions?.node && typeof require === 'function') {
                return 'node';
            }
        } catch { /* ignore */ }
        return 'browser';
    }
}

module.exports=UniversalFile;