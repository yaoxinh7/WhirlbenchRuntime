// AudioClip.js
import { CreateSoundAsync } from "@babylonjs/core";

/**
 * 播放状态类，用于接收 playAsync 的结束状态。
 * 可复用实例，避免内存分配。
 */
export class PlayStatus {
    /**
     * @param {number} [code=0] - 状态码：0=正常完成，1=被stop中断，2=错误
     * @param {string} [msg] - 附加信息（错误时使用）
     */
    constructor(code = 0, msg = undefined) {
        this.code = code;
        this.msg = msg;
    }
}

/**
 * 封装的音频剪辑类，基于 Babylon.js 的 StaticSound (Audio Engine V2)
 * 提供进度控制、克隆、异步播放等待、常用音效等功能。
 */
export class AudioClip {
    /**
     * 构造函数 – 支持两种创建方式：
     * 1. 从 Blob 创建新实例：new AudioClip(blob, scene, options)
     * 2. 包装已有的 StaticSound（由 clone 内部使用）：new AudioClip(staticSound, null, { isClone: true })
     *
     * @param {Blob|StaticSound} blobOrSound - Blob 对象或已存在的 StaticSound 实例
     * @param {Scene|null} scene - Babylon 场景（从 Blob 创建时必须提供）
     * @param {Object} [options] - 可选配置
     * @param {boolean} [options.isClone=false] - 是否为克隆实例（内部使用）
     * @param {boolean} [options.autoplay=false] - 是否自动播放
     * @param {boolean} [options.loop=false] - 是否循环
     * @param {boolean} [options.spatial=false] - 是否启用 3D 空间音效
     */
    constructor(blobOrSound, scene, options = {}) {
        const { isClone = false, autoplay = false, loop = false, spatial = false } = options;

        /** @type {boolean} 是否为克隆实例（共享母版 buffer） */
        this.isClone = isClone;

        /** @type {boolean} 是否已释放资源 */
        this.disposed = false;

        /** @type {StaticSound} 底层 Babylon 声音对象（对外暴露） */
        this.sound = null;

        /** @private 当前活跃的 playAsync 的 resolve 函数 */
        this._pendingResolve = null;
        /** @private 当前活跃的 playAsync 的 reject 函数 */
        this._pendingReject = null;
        /** @private 当前活跃的 playAsync 的 onEnded 回调移除函数 */
        this._endedObserver = null;
        /** @private 当前活跃的 playAsync 传入的 PlayStatus 实例引用 */
        this._pendingStatusObj = null;

        // 根据参数类型创建 sound
        if (blobOrSound instanceof Blob) {
            if (!scene) throw new Error("从 Blob 创建 AudioClip 时，必须提供 scene 参数");
            this._initFromBlob(blobOrSound, scene, { autoplay, loop, spatial });
        } else {
            // 直接包装已有的 StaticSound（clone 时使用）
            this.sound = blobOrSound;
            if (!this.sound) throw new Error("无效的 StaticSound 实例");
        }
    }
    
    /**
     * 设置声音的最大可听距离（即声音半径），距离超出后音量不再衰减。
     * 注意：此属性仅在 distanceModel 为 "linear" 时生效[reference:1]。
     *
     * @param {number} distance - 最大可听距离，单位与场景一致。
     * @param {boolean} [autoSetLinearModel=false] - 是否自动将距离衰减模型设置为 "linear"。如果不启用，请确保当前模型为 "linear"。
     */
    setMaxDistance(distance, autoSetLinearModel = false) {
        this._ensureNotDisposed();
        if (this.sound.spatial) {
            if (autoSetLinearModel) {
                this.sound.spatial.distanceModel = "linear";
            }
            this.sound.spatial.maxDistance = distance;
        } else {
            console.warn("当前声音未启用 spatial 或 spatial 对象不可用");
        }
    }

    /**
     * 设置声音的距离衰减模型。
     *
     * @param {"linear" | "inverse" | "exponential"} model - 衰减模型。
     *   - "linear": 线性衰减，配合 maxDistance 使用效果最明显。
     *   - "inverse": 反比衰减，物理上更真实。
     *   - "exponential": 指数衰减，效果更剧烈。
     */
    setDistanceModel(model) {
        this._ensureNotDisposed();
        if (this.sound.spatial) {
            this.sound.spatial.distanceModel = model;
        } else {
            console.warn("当前声音未启用 spatial 或 spatial 对象不可用");
        }
    }

    /** @private 异步初始化从 Blob 创建的 sound */
    async _initFromBlob(blob, scene, { autoplay, loop, spatial }) {
        const url = URL.createObjectURL(blob);
        try {
            this.sound = await CreateSoundAsync("AudioClip_" + Date.now(), url, scene, {
                autoplay,
                loop,
                spatialSound: spatial,
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /* ======================== 基础属性 ======================== */

    /** 当前播放进度（毫秒） */
    get progress() {
        this._ensureNotDisposed();
        return this.sound.currentTime * 1000;
    }

    /** 音频总长度（毫秒） */
    get length() {
        this._ensureNotDisposed();
        return this.sound.duration * 1000;
    }

    /* ======================== 核心播放控制 ======================== */

    /**
     * 普通播放（非阻塞，不等待结束）
     * 从当前进度开始播放
     */
    play() {
        this._ensureNotDisposed();
        if (this.sound.state === "playing") {
            this.sound.pause();
        }
        this.sound.play();
    }

    /**
     * 异步播放（可 await）
     * 播放结束后 Promise 才会 resolve，可通过传入 PlayStatus 对象获取结束原因。
     *
     * @param {PlayStatus} [statusObj] - 可选，用于接收结束状态的对象（可复用，避免分配）
     * @returns {Promise<void>}
     */
    async playAsync(statusObj) {
        this._ensureNotDisposed();

        // 取消之前未完成的 pending 播放
        this._cancelPendingPlay("新的播放请求中断了之前的播放");

        // 如果正在播放，先暂停再从头播放（按当前进度重新开始）
        if (this.sound.state === "playing") {
            this.sound.pause();
        }

        // 开始播放
        this.sound.play();

        // 保存状态对象引用
        this._pendingStatusObj = statusObj || null;

        // 创建等待结束的 Promise
        return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;

            // 监听播放结束（正常结束）
            this._endedObserver = this.sound.onEndedObservable.addOnce(() => {
                if (this._pendingStatusObj) {
                    this._pendingStatusObj.code = 0;
                    this._pendingStatusObj.msg = undefined;
                }
                this._clearPending();
                resolve();
            });
        });
    }

    /**
     * 停止播放（保留当前进度）
     * 如果存在正在等待的 playAsync，会将其 resolve 并标记为“被中断”
     */
    stop() {
        this._ensureNotDisposed();
        if (this.sound.state === "playing") {
            this.sound.pause();   // pause 保留进度，不触发 onEndedObservable
        }
        // 通知等待中的 playAsync：被停止中断
        this._resolvePending(1, "被 stop() 中断");
    }

    /**
     * 重置进度为 0
     * 不影响播放状态（如果正在播放，跳转到开头继续播放）
     */
    reset() {
        this._ensureNotDisposed();
        this.sound.currentTime = 0;
    }

    /**
     * 设置播放进度（毫秒）
     * @param {number} ms - 毫秒值
     */
    setProgress(ms) {
        this._ensureNotDisposed();
        const seconds = Math.max(0, Math.min(ms / 1000, this.sound.duration));
        this.sound.currentTime = seconds;
    }

    /**
     * 释放资源
     * 注意：克隆实例调用 dispose 只会释放自身，共享的 buffer 由母版负责。
     */
    dispose() {
        if (this.disposed) return;
        this._cancelPendingPlay("实例已释放");
        if (this.sound && !this.sound.isDisposed) {
            this.sound.dispose();
        }
        this.sound = null;
        this.disposed = true;
    }

    /**
     * 克隆当前实例（共享音频 buffer，不重新加载）
     * @returns {Promise<AudioClip>}
     */
    async clone() {
        this._ensureNotDisposed();
        const clonedSound = await this.sound.cloneAsync({ cloneBuffer: false });
        const clip = new AudioClip(clonedSound, null, { isClone: true });
        return clip;
    }

    /* ======================== 音效控制函数 ======================== */

    /**
     * 设置播放倍速（同时改变音调）
     * @param {number} rate - 倍速，1 为正常速度
     */
    setPlaybackRate(rate) {
        this._ensureNotDisposed();
        this.sound.playbackRate = rate;
    }

    /**
     * 设置音量（带可选淡变）
     * @param {number} volume - 0～1
     * @param {number} [duration=0] - 淡变持续时间（秒）
     */
    setVolume(volume, duration = 0) {
        this._ensureNotDisposed();
        if (duration > 0) {
            this.sound.setVolume(volume, { duration, shape: "linear" });
        } else {
            this.sound.volume = volume;
        }
    }

    /**
     * 启用/禁用 3D 空间音效
     * @param {boolean} enabled
     */
    setSpatialEnabled(enabled) {
        this._ensureNotDisposed();
        if (this.sound.spatial && typeof this.sound.spatial.setEnabled === "function") {
            this.sound.spatial.setEnabled(enabled);
        } else {
            // 降级尝试直接设置属性（部分版本支持）
            this.sound.spatial = enabled;
        }
    }

    /**
     * 设置 3D 空间位置（需先启用 spatial）
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setSpatialPosition(x, y, z) {
        this._ensureNotDisposed();
        if (this.sound.spatial && typeof this.sound.spatial.setPosition === "function") {
            this.sound.spatial.setPosition(x, y, z);
        } else {
            console.warn("当前声音未启用 spatial 或 spatial.setPosition 不可用");
        }
    }

    /**
     * 设置左右声道平衡（非 3D 环境）
     * @param {number} pan - -1（左）～ 1（右）
     */
    setPan(pan) {
        this._ensureNotDisposed();
        if (this.sound.stereo && typeof this.sound.stereo.setPan === "function") {
            this.sound.stereo.setPan(pan);
        } else {
            // 尝试直接设置 pan 属性（部分版本支持）
            this.sound.pan = pan;
        }
    }

    /* ======================== 私有辅助方法 ======================== */

    /** 确保实例未被释放 */
    _ensureNotDisposed() {
        if (this.disposed) {
            throw new Error("AudioClip 已被释放，无法执行此操作");
        }
    }

    /** 清除当前 pending 的播放等待 */
    _clearPending() {
        if (this._endedObserver) {
            this._endedObserver.remove();
            this._endedObserver = null;
        }
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingStatusObj = null;
    }

    /** 中断当前正在等待的 playAsync 并设置状态 */
    _resolvePending(code, msg) {
        if (this._pendingResolve) {
            if (this._pendingStatusObj) {
                this._pendingStatusObj.code = code;
                this._pendingStatusObj.msg = msg;
            }
            this._pendingResolve();
            this._clearPending();
        }
    }

    /** 取消当前 pending 的播放（例如新播放请求到来） */
    _cancelPendingPlay(reason) {
        if (this._pendingResolve) {
            if (this._pendingStatusObj) {
                this._pendingStatusObj.code = 1;
                this._pendingStatusObj.msg = reason;
            }
            this._pendingResolve();
            this._clearPending();
        }
    }
}