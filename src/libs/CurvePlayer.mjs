/**
 * EasingGenerator - 缓动曲线模板生成器
 * 为 CurvePlayer 生成节点数组，支持多种常见缓动类型与组合模式。
 *
 * @example
 * import CurvePlayer from './CurvePlayer.js';
 * import { EasingGenerator } from './EasingGenerator.js';
 *
 * const player = new CurvePlayer();
 * const nodes = EasingGenerator.generate('elastic', 'InOut', 40);
 * player.parse(nodes);
 * console.log(player.getX(0.3));
 */

export class EasingGenerator {
    /**
     * 生成指定缓动与模式的节点数组
     * @param {string} type - 缓动类型: 'linear','sine','quad','cubic','quart','quint','expo','circ','back','elastic','bounce'
     * @param {string} mode - 模式: 'In','Out','InOut','OutIn'
     * @param {number} [numPoints=20] - 中间采样点数量（不含首尾自动节点），值越大曲线越精确
     * @returns {Array} CurvePlayer.parse 兼容的节点数组
     */
    static generate(type, mode, numPoints = 20) {
        const tValues = [];
        const count = Math.max(2, numPoints);
        for (let i = 0; i <= count; i++) {
            tValues.push(i / count); // [0, 1] 均匀进度
        }

        const easingIn = this._getEasingIn(type);
        const nodes = [];

        // 首节点（自动补充为 (0,0)）
        nodes.push({ type: 'Smooth', isStart: true });

        // 中间采样点（不含 t=0 和 t=1）
        for (let i = 1; i < tValues.length - 1; i++) {
            const t = tValues[i];
            let y;
            switch (mode) {
                case 'In':
                    y = easingIn(t);
                    break;
                case 'Out':
                    y = 1 - easingIn(1 - t);
                    break;
                case 'InOut':
                    if (t < 0.5) {
                        y = easingIn(2 * t) / 2;
                    } else {
                        y = 0.5 + (1 - easingIn(2 - 2 * t)) / 2;
                    }
                    break;
                case 'OutIn':
                    if (t < 0.5) {
                        y = (1 - easingIn(1 - 2 * t)) / 2;
                    } else {
                        y = 0.5 + easingIn(2 * t - 1) / 2;
                    }
                    break;
                default:
                    y = t; // fallback linear
            }
            // 允许轻微的数值溢出（如 back/elastic 可能超出 [0,1]），不进行裁剪
            nodes.push({ type: 'Smooth', x: t, y });
        }

        // 尾节点（自动补充为 (1,1)）
        nodes.push({ type: 'Smooth', isEnd: true });

        return nodes;
    }

    /**
     * 获取各缓动类型的 In 函数 (t ∈ [0,1] → y ∈ [0,1])
     * @private
     */
    static _getEasingIn(type) {
        switch (type) {
            case 'linear':
                return t => t;
            case 'sine':
                return t => 1 - Math.cos((t * Math.PI) / 2);
            case 'quad':
                return t => t * t;
            case 'cubic':
                return t => t * t * t;
            case 'quart':
                return t => t * t * t * t;
            case 'quint':
                return t => t * t * t * t * t;
            case 'expo':
                return t => t === 0 ? 0 : Math.pow(2, 10 * (t - 1));
            case 'circ':
                return t => 1 - Math.sqrt(1 - t * t);
            case 'back': {
                const s = 1.70158;
                return t => t * t * ((s + 1) * t - s);
            }
            case 'elastic': {
                const c4 = (2 * Math.PI) / 3;
                return t => {
                    if (t === 0 || t === 1) return t;
                    return -Math.pow(2, 10 * (t - 1)) * Math.sin((t - 1.075) * c4);
                };
            }
            case 'bounce':
                return t => {
                    // 使用经典 bounce out 反转得到 bounce in
                    return 1 - this._bounceOut(1 - t);
                };
            default:
                return t => t;
        }
    }

    /**
     * bounce out 辅助函数
     * @private
     */
    static _bounceOut(t) {
        const n1 = 7.5625;
        const d1 = 2.75;
        if (t < 1 / d1) {
            return n1 * t * t;
        } else if (t < 2 / d1) {
            t -= 1.5 / d1;
            return n1 * t * t + 0.75;
        } else if (t < 2.5 / d1) {
            t -= 2.25 / d1;
            return n1 * t * t + 0.9375;
        } else {
            t -= 2.625 / d1;
            return n1 * t * t + 0.984375;
        }
    }
}

/**
 * CurvePlayer - 曲线解析与播放器
 * 支持 Linear、Smooth(三次样条)、Bezier、Step 四种节点类型。
 * 提供智能缓存机制，适配高频计时器调用场景。
 * 
 * @example
 * const player = new CurvePlayer();
 * player.parse([
 *   { type: 'Linear', isStart: true },
 *   { type: 'Smooth', x: 0.5, y: 0.75 },
 *   { type: 'Linear', isEnd: true }
 * ]);
 * console.log(player.getX(0.5)); // 输出对应 y 值（倍数）
 * console.log(player.getXNode(0.5)); // 输出左侧节点索引
 */

export default class CurvePlayer {
    constructor() {
        /** @type {boolean} 曲线是否可用，解析失败时为 false */
        this.valid = true;

        /** @type {Array|null} 最近一次成功解析的原始 JSON 数据 */
        this.data = null;

        /** @type {Array} 归一化处理后的节点数组 */
        this.nodes = [];

        /** @type {number} 节点数量 */
        this.nodeCount = 0;

        // ---- 缓存属性 ----
        /** @type {number} 缓存：区间左边界 x */
        this._front = -1;
        /** @type {number} 缓存：区间右边界 x */
        this._next = -1;
        /** @type {number} 缓存：左节点索引 */
        this._count = -1;

        // ---- 扩展属性 ----
        /** @type {number} 当前（或最近一次查询）区间起点的 y 值 */
        this.frontY = 0;
        /** @type {number} 当前（或最近一次查询）区间终点的 y 值 */
        this.nextY = 1;

        this._initDefault();
    }

    // ======================== 私有：初始化默认曲线 ========================
    _initDefault() {
        const defaultJson = [
            { type: 'Linear', isStart: true },
            { type: 'Linear', isEnd: true }
        ];
        this.data = defaultJson;
        this.nodes = [
            { type: 'Linear', x: 0, y: 0, isStart: true },
            { type: 'Linear', x: 1, y: 1, isEnd: true }
        ];
        this.nodeCount = 2;
        this.valid = true;
        this._clearCache();
        this.frontY = 0;
        this.nextY = 1;
    }

    // ======================== 私有：清除区间缓存 ========================
    _clearCache() {
        this._front = -1;
        this._next = -1;
        this._count = -1;
    }

    // ======================== 核心方法：解析 JSON ========================
    /**
     * 解析曲线配置 JSON
     * @param {Array} json - 节点配置数组，首元素必须含 isStart:true，尾元素必须含 isEnd:true
     * @returns {CurvePlayer} 支持链式调用
     * @throws {Error} 缺少起始/结束标记时抛出
     */
    parse(json) {
        if (!Array.isArray(json) || json.length < 2) {
            this.valid = false;
            throw new Error('[CurvePlayer.parse] 输入必须是非空数组且至少包含 2 个节点');
        }

        const first = json[0];
        const last = json[json.length - 1];

        if (!first || !first.isStart) {
            this.valid = false;
            throw new Error('[CurvePlayer.parse] 第一个节点必须带有 isStart: true');
        }
        if (!last || !last.isEnd) {
            this.valid = false;
            throw new Error('[CurvePlayer.parse] 最后一个节点必须带有 isEnd: true');
        }

        const rawNodes = [];
        const len = json.length;

        for (let i = 0; i < len; i++) {
            const item = json[i];
            const node = {
                type: item.type || 'Linear',
            };

            if (item.isStart) {
                node.x = 0;
                node.y = 0;
                node.isStart = true;
            } else if (item.isEnd) {
                node.x = 1;
                node.y = 1;
                node.isEnd = true;
            } else {
                let ix = Number(item.x);
                if (isNaN(ix)) {
                    this.valid = false;
                    throw new Error(`[CurvePlayer.parse] 节点索引 ${i} 的 x 值无效: ${item.x}`);
                }
                ix = Math.max(0, Math.min(1, ix));
                node.x = ix;
                node.y = Number(item.y);
                if (isNaN(node.y)) {
                    this.valid = false;
                    throw new Error(`[CurvePlayer.parse] 节点索引 ${i} 的 y 值无效: ${item.y}`);
                }
            }

            if (node.type === 'Bezier' && !node.isEnd) {
                node._cp1x = (item.cp1x !== undefined) ? Number(item.cp1x) : undefined;
                node._cp1y = (item.cp1y !== undefined) ? Number(item.cp1y) : undefined;
                node._cp2x = (item.cp2x !== undefined) ? Number(item.cp2x) : undefined;
                node._cp2y = (item.cp2y !== undefined) ? Number(item.cp2y) : undefined;
            }

            rawNodes.push(node);
        }

        // 为 Bezier 节点补全控制点（基于线性退化）
        for (let i = 0; i < rawNodes.length - 1; i++) {
            const node = rawNodes[i];
            if (node.type === 'Bezier') {
                const next = rawNodes[i + 1];
                const dx = next.x - node.x;
                const dy = next.y - node.y;
                if (node._cp1x === undefined) node._cp1x = node.x + dx / 3;
                if (node._cp1y === undefined) node._cp1y = node.y + dy / 3;
                if (node._cp2x === undefined) node._cp2x = node.x + (2 * dx) / 3;
                if (node._cp2y === undefined) node._cp2y = node.y + (2 * dy) / 3;
                node.cp1x = node._cp1x;
                node.cp1y = node._cp1y;
                node.cp2x = node._cp2x;
                node.cp2y = node._cp2y;
                delete node._cp1x;
                delete node._cp1y;
                delete node._cp2x;
                delete node._cp2y;
            }
        }

        this.nodes = rawNodes;
        this.nodeCount = rawNodes.length;
        this.data = json;
        this.valid = true;
        this._clearCache();

        // 初始化扩展属性
        if (this.nodeCount >= 2) {
            this.frontY = this.nodes[0].y;
            this.nextY = this.nodes[1].y;
        } else {
            this.frontY = 0;
            this.nextY = 0;
        }

        return this;
    }

    // ======================== 二分查找 ========================
    _binarySearch(x) {
        const nodes = this.nodes;
        let lo = 0;
        let hi = this.nodeCount - 1;
        let best = 0;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (nodes[mid].x <= x) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best;
    }

    // ======================== 获取区间索引（带缓存） ========================
    _getSegmentIndex(x) {
        const cx = Math.max(0, Math.min(1, x));

        // 缓存命中
        if (
            this._count >= 0 &&
            this._count < this.nodeCount - 1 &&
            cx >= this._front &&
            cx <= this._next
        ) {
            // 更新扩展属性
            this.frontY = this.nodes[this._count].y;
            this.nextY = this.nodes[this._count + 1].y;
            return this._count;
        }

        // 未命中，二分
        let idx = this._binarySearch(cx);
        if (idx >= this.nodeCount - 1) idx = this.nodeCount - 2;
        if (idx < 0) idx = 0;

        this._count = idx;
        this._front = this.nodes[idx].x;
        this._next = this.nodes[idx + 1].x;

        // 更新扩展属性
        this.frontY = this.nodes[idx].y;
        this.nextY = this.nodes[idx + 1].y;

        return idx;
    }

    // ======================== 公开：获取 y 值 ========================
    /**
     * 获取曲线上 x 位置对应的 y 值（倍数，可超出 [0,1]）
     * @param {number} x - 进度值，范围 [0, 1]
     * @returns {number} y 值
     */
    getX(x) {
        if (!this.valid || this.nodeCount < 2) {
            return x;
        }

        const cx = Math.max(0, Math.min(1, x));
        const idx = this._getSegmentIndex(cx);
        const nodeA = this.nodes[idx];
        const nodeB = this.nodes[idx + 1];

        if (cx <= nodeA.x) return nodeA.y;
        if (cx >= nodeB.x) return nodeB.y;

        switch (nodeA.type) {
            case 'Linear': return this._interpLinear(nodeA, nodeB, cx);
            case 'Step':   return nodeA.y;
            case 'Bezier': return this._interpBezier(nodeA, nodeB, cx);
            case 'Smooth': return this._interpSmooth(idx, cx);
            default:       return this._interpLinear(nodeA, nodeB, cx);
        }
    }

    // ======================== 公开：获取左侧节点索引 ========================
    /**
     * 返回曲线 x 上对应的节点索引（x 位置左侧的第一个节点）
     * @param {number} x - 进度值，范围 [0, 1]
     * @returns {number} 节点索引
     */
    getXNode(x) {
        if (!this.valid || this.nodeCount === 0) {
            return 0;
        }
        const cx = Math.max(0, Math.min(1, x));
        const idx = this._getSegmentIndex(cx);

        if (cx >= this.nodes[idx + 1].x && idx + 1 < this.nodeCount) {
            return idx + 1;
        }
        return idx;
    }

    // ======================== 线性插值 ========================
    _interpLinear(a, b, x) {
        const dx = b.x - a.x;
        if (Math.abs(dx) < 1e-12) return a.y;
        const t = (x - a.x) / dx;
        return a.y + (b.y - a.y) * t;
    }

    // ======================== 贝塞尔插值 ========================
    _interpBezier(a, b, x) {
        const cp1x = a.cp1x ?? a.x;
        const cp1y = a.cp1y ?? a.y;
        const cp2x = a.cp2x ?? b.x;
        const cp2y = a.cp2y ?? b.y;

        const targetX = x;
        let tLo = 0;
        let tHi = 1;

        const xAt = (t) => {
            const u = 1 - t;
            return u * u * u * a.x +
                3 * u * u * t * cp1x +
                3 * u * t * t * cp2x +
                t * t * t * b.x;
        };

        for (let iter = 0; iter < 40; iter++) {
            const tMid = (tLo + tHi) / 2;
            const xMid = xAt(tMid);
            if (Math.abs(xMid - targetX) < 1e-10) {
                return this._bezierYAt(tMid, a.y, cp1y, cp2y, b.y);
            }
            if (xMid < targetX) {
                tLo = tMid;
            } else {
                tHi = tMid;
            }
        }
        const tFinal = (tLo + tHi) / 2;
        return this._bezierYAt(tFinal, a.y, cp1y, cp2y, b.y);
    }

    _bezierYAt(t, y0, cp1y, cp2y, y3) {
        const u = 1 - t;
        return u * u * u * y0 +
            3 * u * u * t * cp1y +
            3 * u * t * t * cp2y +
            t * t * t * y3;
    }

    // ======================== 平滑样条插值 (Catmull-Rom) ========================
    _interpSmooth(idx, x) {
        const nodes = this.nodes;
        const n = this.nodeCount;

        const i0 = Math.max(0, idx - 1);
        const i1 = idx;
        const i2 = idx + 1;
        const i3 = Math.min(n - 1, idx + 2);

        let P0x, P0y, P1x, P1y, P2x, P2y, P3x, P3y;

        P1x = nodes[i1].x;
        P1y = nodes[i1].y;
        P2x = nodes[i2].x;
        P2y = nodes[i2].y;

        if (idx === 0) {
            P0x = 2 * P1x - P2x;
            P0y = 2 * P1y - P2y;
        } else {
            P0x = nodes[i0].x;
            P0y = nodes[i0].y;
        }

        if (idx + 2 >= n) {
            P3x = 2 * P2x - P1x;
            P3y = 2 * P2y - P1y;
        } else {
            P3x = nodes[i3].x;
            P3y = nodes[i3].y;
        }

        const targetX = x;

        const xAt = (t) => {
            const t2 = t * t;
            const t3 = t2 * t;
            return 0.5 * (
                (2 * P1x) +
                (-P0x + P2x) * t +
                (2 * P0x - 5 * P1x + 4 * P2x - P3x) * t2 +
                (-P0x + 3 * P1x - 3 * P2x + P3x) * t3
            );
        };

        let tLo = 0;
        let tHi = 1;
        for (let iter = 0; iter < 40; iter++) {
            const tMid = (tLo + tHi) / 2;
            const xMid = xAt(tMid);
            if (Math.abs(xMid - targetX) < 1e-10) {
                return this._catmullRomYAt(tMid, P0y, P1y, P2y, P3y);
            }
            if (xMid < targetX) {
                tLo = tMid;
            } else {
                tHi = tMid;
            }
        }
        const tFinal = (tLo + tHi) / 2;
        return this._catmullRomYAt(tFinal, P0y, P1y, P2y, P3y);
    }

    _catmullRomYAt(t, P0y, P1y, P2y, P3y) {
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (
            (2 * P1y) +
            (-P0y + P2y) * t +
            (2 * P0y - 5 * P1y + 4 * P2y - P3y) * t2 +
            (-P0y + 3 * P1y - 3 * P2y + P3y) * t3
        );
    }
}