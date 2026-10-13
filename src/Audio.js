class AudioManager {
  // 私有字段
  #fileCache = new Map();       // 路径 -> 加载完成的音频母版
  #loadingPromises = new Map(); // 路径 -> 加载中的 Promise（防重复加载）
  #activeAudios = new Map();    // UUID -> 当前播放的音频实例（仅用于阻塞模式管理）
  #maxConcurrent;               // 最大并发播放数

  constructor({ maxConcurrent = 10 } = {}) {
    this.#maxConcurrent = maxConcurrent;
  }

  // ---------- 路径规范化 ----------
  #normalizePath(path) {
    if (!path) return path;
    if (/^(data:|blob:|https?:|file:|\.\/|\.\.\/|\/|[a-zA-Z]:[\\/])/.test(path)) return path;
    return `./assets/${path}`;
  }

  // ---------- 加载音频（返回 Promise<HTMLAudioElement>） ----------
  #loadAudio(path) {
    const normalized = this.#normalizePath(path);
    if (this.#fileCache.has(normalized)) {
      const cached = this.#fileCache.get(normalized);
      if (cached.readyState >= 2) return Promise.resolve(cached);
    }
    if (this.#loadingPromises.has(normalized)) {
      return this.#loadingPromises.get(normalized);
    }
    const audio = new Audio();
    audio.src = normalized;
    audio.preload = 'auto';
    const loadPromise = new Promise((resolve, reject) => {
      const onCanPlay = () => {
        cleanup();
        this.#fileCache.set(normalized, audio);
        this.#loadingPromises.delete(normalized);
        resolve(audio);
      };
      const onError = (e) => {
        cleanup();
        this.#loadingPromises.delete(normalized);
        console.error(`[AudioManager] 加载失败: ${normalized}`, e);
        reject(new Error(`加载失败: ${normalized}`));
      };
      const cleanup = () => {
        audio.removeEventListener('canplaythrough', onCanPlay);
        audio.removeEventListener('loadeddata', onCanPlay);
        audio.removeEventListener('error', onError);
      };
      audio.addEventListener('canplaythrough', onCanPlay);
      audio.addEventListener('loadeddata', onCanPlay);
      audio.addEventListener('error', onError);
      if (audio.readyState >= 2) {
        cleanup();
        this.#fileCache.set(normalized, audio);
        this.#loadingPromises.delete(normalized);
        resolve(audio);
      }
    });
    this.#loadingPromises.set(normalized, loadPromise);
    return loadPromise;
  }

  // ---------- 停止指定 UUID 的播放（用于重置） ----------
  #stopAudio(uuid) {
    const audio = this.#activeAudios.get(uuid);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      this.#activeAudios.delete(uuid);
    }
  }

  // ---------- 并发控制：超出最大数量时停止最旧的播放 ----------
  #enforceConcurrency() {
    if (this.#activeAudios.size >= this.#maxConcurrent) {
      let oldestUuid = null;
      let oldestTime = Infinity;
      for (const [uid, audio] of this.#activeAudios.entries()) {
        if (audio._startTime < oldestTime) {
          oldestTime = audio._startTime;
          oldestUuid = uid;
        }
      }
      if (oldestUuid) {
        this.#stopAudio(oldestUuid);
      }
    }
  }

  // ---------- 公共 API ----------

  /**
   * 生成器函数：阻塞式播放并等待完成
   * @param {string} uuid 唯一标识（重复调用会重置并重新播放）
   * @param {string} path 音频路径
   * @yields {null} 等待过程中每帧 yield null
   */
  *playAudioGenerator(uuid, path) {
    let myAudio = null;
    try {
      const normalized = this.#normalizePath(path);

      // ---- 1. 等待音频加载完成（轮询） ----
      let masterAudio = this.#fileCache.get(normalized);
      if (!masterAudio || masterAudio.readyState < 2) {
        if (!this.#loadingPromises.has(normalized)) {
          this.#loadAudio(path); // 异步启动加载
        }
        while (true) {
          masterAudio = this.#fileCache.get(normalized);
          if (masterAudio && masterAudio.readyState >= 2) break;
          if (!this.#loadingPromises.has(normalized) && !masterAudio) {
            console.error(`[AudioManager] 音频加载失败: ${normalized}`);
            return;
          }
          yield null; // 等待下一帧
        }
      }

      // ---- 2. 创建播放实例 ----
      const playAudio = masterAudio.cloneNode(true);
      playAudio.currentTime = 0;

      // ---- 3. 重置同 UUID 的旧播放 ----
      this.#stopAudio(uuid);

      // ---- 4. 并发控制 ----
      this.#enforceConcurrency();

      // ---- 5. 存储新实例 ----
      playAudio._startTime = Date.now();
      this.#activeAudios.set(uuid, playAudio);
      myAudio = playAudio;

      // ---- 6. 开始播放（不等待 Promise）----
      const playPromise = playAudio.play();
      playPromise.catch(err => {
        // 播放被拒绝（如自动播放策略），清理并记录
        if (this.#activeAudios.get(uuid) === myAudio) {
          this.#activeAudios.delete(uuid);
          console.error(`[AudioManager] 播放启动失败 (${uuid}):`, err);
        }
      });

      // ---- 7. 等待播放开始（避免立刻进入结束循环）----
      let started = false;
      while (!started) {
        if (this.#activeAudios.get(uuid) !== myAudio) return; // 被重置
        if (myAudio.ended) break; // 极短音频已结束
        if (myAudio.error) break;
        // 检查是否已经开始播放（currentTime > 0 或 未暂停且有有效时长）
        if (myAudio.currentTime > 0 || (myAudio.duration > 0 && !myAudio.paused)) {
          started = true;
          break;
        }
        yield null; // 等待下一帧
      }

      // ---- 8. 等待播放结束或重置 ----
      while (true) {
        if (this.#activeAudios.get(uuid) !== myAudio) break; // 被重置
        if (myAudio.ended) break;
        if (myAudio.error) break;
        yield null;
      }
    } finally {
      // 清理（如果当前实例未被外部重置，则移除并释放）
      if (myAudio && this.#activeAudios.get(uuid) === myAudio) {
        this.#activeAudios.delete(uuid);
        myAudio.pause();
        myAudio.currentTime = 0;
      }
    }
  }

  /**
   * 异步播放（非阻塞，支持声音叠加）
   * @param {string} uuid 唯一标识（同 UUID 可同时播放多个，实现叠加）
   * @param {string} path 音频路径
   */
  async playAudioAsync(uuid, path) {
    try {
      const masterAudio = await this.#loadAudio(path);
      const playAudio = masterAudio.cloneNode(true);
      playAudio.currentTime = 0;

      // 异步播放不停止旧实例，允许叠加，但受并发控制
      this.#enforceConcurrency();

      playAudio._startTime = Date.now();
      this.#activeAudios.set(uuid, playAudio);

      await playAudio.play();

      // 播放结束后自动清理
      const endedHandler = () => {
        if (this.#activeAudios.get(uuid) === playAudio) {
          this.#activeAudios.delete(uuid);
        }
        playAudio.removeEventListener('ended', endedHandler);
      };
      playAudio.addEventListener('ended', endedHandler);
    } catch (err) {
      console.error(`[AudioManager] 异步播放失败 (${uuid}):`, err);
    }
  }

  /**
   * 停止所有音频播放，并解冻所有等待中的生成器
   */
  stopAll() {
    for (const [uuid, audio] of this.#activeAudios) {
      audio.pause();
      audio.currentTime = 0;
    }
    this.#activeAudios.clear();
  }

  /**
   * 清理指定路径的音频缓存
   */
  clearAudioCache(path) {
    const normalized = this.#normalizePath(path);
    const cached = this.#fileCache.get(normalized);
    if (cached) {
      cached.pause();
      cached.src = '';
      cached.load();
      this.#fileCache.delete(normalized);
    }
    this.#loadingPromises.delete(normalized);
  }

  /**
   * 完全重置管理器（清空所有缓存和播放）
   */
  reset() {
    this.stopAll();
    for (const [path, audio] of this.#fileCache) {
      audio.pause();
      audio.src = '';
      audio.load();
    }
    this.#fileCache.clear();
    this.#loadingPromises.clear();
  }

  get activeCount() {
    return this.#activeAudios.size;
  }

  get cacheSize() {
    return this.#fileCache.size;
  }
}

export default AudioManager;