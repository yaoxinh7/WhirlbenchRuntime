import { MeshBuilder, StandardMaterial, Color3 } from '@babylonjs/core';
import * as BABYLON from '@babylonjs/core';

export class SpriteStage {
    constructor(scene,{
        width,
        height,
        backend
    }) {
        this.scene = scene;
        this.batchMap = new Map();        // 纹理 → Thin Instance批次
        this.materialMap = new Map();    // 存纹理和纹理大小
        this.nextId = 0;                 // 精灵id自增
        this.layerPool = [];
        this.layerMap = new Map();
        this.spriteRefMap = new Map();

        this.svgscale=4;

        // 画笔配置
        this.pInitLines = 8192;// 初始容量
        this.pMaxLines = 131072;// 最大保留线条数(超出就烘焙到RT)
        this.pEvictRatio = 0.1;// 溢出时移除比例
        this.pBakeBatch = 1024;// 触发烘焙的线条数
        this.pHighDefRT = true;// 高清渲染纹理
        this.maxLines = this.pInitLines; // 当前容量
        this.pChunkLines = 8192;// 每次上传的块大小
        this.pColor = "0x0000ff";// 蓝色
        this.pSize = 1;// 画笔粗细
        this.pLineCnt = 0;// 已有线条数
        this.pCntChanged = false;// 数量是否变化
        this.pDirty = false;// 是否有更新
        this.pMesh = null;// 线条mesh
        this.pMat = null;// 线条材质
        this.pMatBuf = new Float32Array(this.maxLines * 16); // 矩阵数据
        this.pColBuf = new Float32Array(this.maxLines * 4);// 颜色数据
        this.pDirtyStart = -1;// 脏数据开始索引
        this.pDirtyEnd = 0;// 脏数据结束索引

        // 舞台边界（用于裁剪）
        this.pBounds = { left: -(width/2), right: (width/2), bottom: -(height/2), top: (height/2) };

        // 烘焙相关
        this.pBakeTex = null;
        this.pBakeMat = null;
        this.pBakeMesh = null;
        this.pBakeCam = null;
        this.pSkipBakeThisFrame = false;
        this.pNeedBake = false;

        // 碰撞检测相关
        this.collisionRT = null;          // 碰撞检测渲染纹理
        this.collisionCam = null;         // 碰撞检测相机
        this.collisionMaterial = null;    // 碰撞检测材质
        this.collisionRTSize = 512;       // 碰撞检测纹理尺寸（可优化）
        this.alphaDataCache = new Map();  // 纹理alpha数据缓存
        this.useGPUCollision = true;     // 是否使用GPU加速碰撞检测（实验性）

        // 屏幕空间模式：透视相机下2D角色固定在屏幕上（类似UI）
        this.screenSpace = false;        // 是否启用屏幕空间模式
        this._screenSpaceCam = null;     // 内部正交相机（用于渲染2D精灵）
        this._mainCamera = null;         // 场景主相机引用（需要隐藏2D层的相机）

        this.backend=backend;
    }

    // 初始化屏幕空间模式（创建内部正交相机，隔离2D渲染）
    _initScreenSpace() {
        this._mainCamera = this.scene.activeCamera;
        if (this._mainCamera) {
            this._mainCamera.layerMask &= ~0x2;
            //this._mainCamera.layerMask = 0xFFFFFFFF;
        }
        this._screenSpaceCam = new BABYLON.FreeCamera(
            "screenSpaceCam",
            new BABYLON.Vector3(0, 0, -10),
            this.scene
        );

        this._screenSpaceCam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
        this._screenSpaceCam.minZ = 0.1;
        this._screenSpaceCam.maxZ = 100;
        this._screenSpaceCam.orthoLeft = this.pBounds.left;
        this._screenSpaceCam.orthoRight = this.pBounds.right;
        this._screenSpaceCam.orthoBottom = this.pBounds.bottom;
        this._screenSpaceCam.orthoTop = this.pBounds.top;
        this._screenSpaceCam.setTarget(BABYLON.Vector3.Zero());
        this._screenSpaceCam.layerMask = 0x2;

        for (const mesh of this.scene.meshes) {
            if (mesh.renderingGroupId === 2) {
                mesh.layerMask = 0x2;
            } else {
                mesh.layerMask &= ~0x2;
            }
        }

        // 监听后续新增的网格，自动分配layerMask
        var self = this;
        this._screenSpaceHandler = function(mesh) {
            if (!self.screenSpace || !self._screenSpaceCam) return;
            if (mesh.renderingGroupId === 2) {
                mesh.layerMask = 0x2;
            } else {
                mesh.layerMask &= ~0x2;
            }
        };
        if (this.scene.onNewMeshAddedObservable) {
            this.scene.onNewMeshAddedObservable.add(this._screenSpaceHandler);
        }

        //this.scene.activeCameras = [ this._screenSpaceCam,this._mainCamera,];
        this.scene.activeCameras = [ this._mainCamera,this._screenSpaceCam,];
        //this.scene.autoClear=false;
        //this.scene.autoClearDepthAndStencil=false;

        //this.scene.activeCameras = [ this._mainCamera,this._screenSpaceCam,];
        //this.scene.activeCamera = this._screenSpaceCam
    }

    // 设置画笔颜色
    setPenColor(color) {
        this.pColor = color;
    }

    // 设置画笔粗细
    setPenSize(size) {
        this.pSize = size;
    }

    // 手动设置上传块大小
    setPenUploadChunkLines(chunkLines) {
        this.pChunkLines = chunkLines;
    }

    // 画一条线
    drawLine(x1, y1, x2, y2) {
        this._ensurePenThinInstance();
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len <= 0) return;

        this._ensurePenBufferCapacity(this.pLineCnt + 1);
        const idx = this.pLineCnt;

        // 计算线段中点、长度、方向
        // MIT-origin note: line center offset rule参考leopard/scratch-render PenSkin实现（size=1/3时偏移0.5）
        const lineOffset = (this.pSize === 1 || this.pSize === 3) ? 0.5 : 0;
        const midX = (x1 + x2) * 0.5 + lineOffset;
        const midY = (y1 + y2) * 0.5 + lineOffset;
        const cos = dx / len;
        const sin = dy / len;
        const scaleX = len;
        const scaleY = this.pSize;

        // 设置矩阵（让平面旋转缩放并移动到线段中点）
        const off = idx * 16;
        this.pMatBuf[off] = cos * scaleX;
        this.pMatBuf[off + 1] = sin * scaleX;
        this.pMatBuf[off + 2] = 0;
        this.pMatBuf[off + 3] = 0;
        this.pMatBuf[off + 4] = -sin * scaleY;
        this.pMatBuf[off + 5] = cos * scaleY;
        this.pMatBuf[off + 6] = 0;
        this.pMatBuf[off + 7] = 0;
        this.pMatBuf[off + 8] = 0;
        this.pMatBuf[off + 9] = 0;
        this.pMatBuf[off + 10] = 1;
        this.pMatBuf[off + 11] = 0;
        this.pMatBuf[off + 12] = midX;
        this.pMatBuf[off + 13] = midY;
        this.pMatBuf[off + 14] = 1.5;  // 深度
        this.pMatBuf[off + 15] = 1;

        // 颜色直接使用当前颜色值（转换为RGB分量）
        const colOff = idx * 4;
        const r = ((this.pColor >> 16) & 0xFF) / 255;
        const g = ((this.pColor >> 8) & 0xFF) / 255;
        const b = (this.pColor & 0xFF) / 255;
        this.pColBuf[colOff] = r;
        this.pColBuf[colOff + 1] = g;
        this.pColBuf[colOff + 2] = b;
        this.pColBuf[colOff + 3] = 1;

        this.pLineCnt = idx + 1;
        this.pCntChanged = true;
        this._markPenDirtyRange(idx, idx + 1);
        this.pDirty = true;

        if (this.pLineCnt >= this.pBakeBatch && !this.pSkipBakeThisFrame) this.pNeedBake = true;
    }

    // 清除所有线条
    clearPen() {
        this.pLineCnt = 0;
        this.pCntChanged = true;
        this.pDirtyStart = -1;
        this.pDirtyEnd = 0;
        this.pDirty = true;
        this.pSkipBakeThisFrame = true;
        this.pNeedBake = false;
        this._clearBakedPenTexture();
        // 如果容量太大就缩回初始大小
        if (this.maxLines > this.pInitLines) {
            this._resizePenBuffers(this.pInitLines);
            if (this.pMesh) {
                this.pMesh.thinInstanceSetBuffer("matrix", this.pMatBuf, 16, false);
                this.pMesh.thinInstanceSetBuffer("instanceColor", this.pColBuf, 4, false);
            }
        }
    }

    // 更新画笔数据到GPU（在renderTick里调用）
    _updatePen() {
        if (!this.pDirty) return;
        if (this.pMesh) {
            if (this.pCntChanged) this.pMesh.thinInstanceCount = this.pLineCnt;
            if (this.pLineCnt > 0 && this.pDirtyStart >= 0 && this.pDirtyEnd > this.pDirtyStart) {
                for (let off = this.pDirtyStart; off < this.pDirtyEnd; off += this.pChunkLines) {
                    const chunk = Math.min(this.pChunkLines, this.pDirtyEnd - off);
                    this.pMesh.thinInstancePartialBufferUpdate("matrix", chunk, off);
                    this.pMesh.thinInstancePartialBufferUpdate("instanceColor", chunk, off);
                }
            }
        }
        this.pCntChanged = false;
        this.pDirtyStart = -1;
        this.pDirtyEnd = 0;
        this.pDirty = false;
        if (this.pNeedBake && !this.pSkipBakeThisFrame) this._bakeRuntimePenBatch();
        this.pSkipBakeThisFrame = false;
    }

    // 确保画笔实例存在
    _ensurePenThinInstance() {
        if (this.pMesh) return;
        // 创建平面，作为每条线的基础模型
        this.pMesh = MeshBuilder.CreatePlane(
            "penThinLine",
            { width: 1, height: 1, sideOrientation: BABYLON.Mesh.FRONTSIDE },
            this.scene
        );
        this.pMesh.isPickable = false;
        this.pMesh.renderingGroupId = 2;
        this.pMesh.alphaIndex = -1;
        if (this.screenSpace) {
            this.pMesh.layerMask = 0x2;
        }
        this.pMat = new StandardMaterial("penThinLineMat", this.scene);
        this.pMat.disableLighting = true;
        this.pMat.emissiveColor = Color3.White();
        this.pMat.useVertexColor = true;
        this.pMat.backFaceCulling = true;
        this.pMesh.material = this.pMat;
        this.pMesh.thinInstanceSetBuffer("matrix", this.pMatBuf, 16, false);
        this.pMesh.thinInstanceSetBuffer("instanceColor", this.pColBuf, 4, false);
        this.pMesh.thinInstanceCount = 0;
        this._ensurePenBakeLayer();
    }

    // 创建烘焙用的纹理层
    _ensurePenBakeLayer() {
        if (this.pBakeTex) {
            this._syncPenBakeTextureSize();
            return;
        }
        const texSize = this._getPenBakeTextureSize();
        const w = texSize.width;
        const h = texSize.height;
        const dispW = this.pBounds.right - this.pBounds.left;
        const dispH = this.pBounds.top - this.pBounds.bottom;

        // 正交相机，匹配舞台边界
        this.pBakeCam = new BABYLON.FreeCamera("penBakeCamera", new BABYLON.Vector3(0, 0, -10), this.scene);
        this.pBakeCam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
        this.pBakeCam.minZ = 0.1;
        this.pBakeCam.maxZ = 100;
        this.pBakeCam.orthoLeft = this.pBounds.left;
        this.pBakeCam.orthoRight = this.pBounds.right;
        this.pBakeCam.orthoBottom = this.pBounds.bottom;
        this.pBakeCam.orthoTop = this.pBounds.top;
        this.pBakeCam.setTarget(BABYLON.Vector3.Zero());

        // 渲染纹理
        this.pBakeTex = new BABYLON.RenderTargetTexture(
            "penBakedRT",
            { width: w, height: h },
            this.scene,
            {
                generateMipMaps: false,
                doNotChangeAspectRatio: true,
                samplingMode: BABYLON.Texture.NEAREST_SAMPLINGMODE,
                generateDepthBuffer: false,
                generateStencilBuffer: false
            }
        );
        this.pBakeTex.clearColor = new BABYLON.Color4(0, 0, 0, 0);
        this.pBakeTex.activeCamera = this.pBakeCam;
        this.pBakeTex.renderList = [this.pMesh];
        this.pBakeTex.renderParticles = false;
        this.pBakeTex.renderSprites = false;
        this.pBakeTex.skipInitialClear = true;
        this.pBakeTex.refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

        // 材质使用烘焙纹理
        this.pBakeMat = new StandardMaterial("penBakedMat", this.scene);
        this.pBakeMat.disableLighting = true;
        this.pBakeMat.emissiveColor = Color3.White();
        this.pBakeMat.diffuseTexture = this.pBakeTex;
        this.pBakeMat.opacityTexture = this.pBakeTex;
        this.pBakeMat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;

        this.pBakeMesh = MeshBuilder.CreatePlane(
            "penBakedLayer",
            { width: dispW, height: dispH, sideOrientation: BABYLON.Mesh.FRONTSIDE },
            this.scene
        );
        this.pBakeMesh.material = this.pBakeMat;
        this.pBakeMesh.position.set(0, 0, 5);
        this.pBakeMesh.isPickable = false;
        this.pBakeMesh.renderingGroupId = 2;
        this.pBakeMesh.alphaIndex = -2;
        if (this.screenSpace) {
            this.pBakeMesh.layerMask = 0x2;
        }
    }

    // 获取烘焙纹理尺寸（根据是否高清和引擎渲染尺寸）
    _getPenBakeTextureSize() {
        if (!this.pHighDefRT || !this.scene || typeof this.scene.getEngine !== "function") {
            return {
                width: this.pBounds.right - this.pBounds.left,
                height: this.pBounds.top - this.pBounds.bottom
            };
        }
        const eng = this.scene.getEngine();
        const rw = eng && typeof eng.getRenderWidth === "function" ? Number(eng.getRenderWidth()) : NaN;
        const rh = eng && typeof eng.getRenderHeight === "function" ? Number(eng.getRenderHeight()) : NaN;
        return {
            width: (Number.isFinite(rw) && rw > 0) ? Math.round(rw) : this.pBounds.right - this.pBounds.left,
            height: (Number.isFinite(rh) && rh > 0) ? Math.round(rh) : this.pBounds.top - this.pBounds.bottom
        };
    }

    // 同步烘焙纹理尺寸（如果渲染分辨率变了）
    _syncPenBakeTextureSize(force = false) {
        if (!this.pBakeTex) return;
        const sz = this._getPenBakeTextureSize();
        const cur = typeof this.pBakeTex.getSize === "function" ? this.pBakeTex.getSize() : null;
        const curW = cur && Number.isFinite(cur.width) ? cur.width : 0;
        const curH = cur && Number.isFinite(cur.height) ? cur.height : 0;
        if (!force && curW === sz.width && curH === sz.height) return;
        this.pBakeTex.resize({ width: sz.width, height: sz.height });
    }

    // 烘焙当前线条到纹理，并清空运行时线条（减少实时drawcall）
    _bakeRuntimePenBatch() {
        if (this.pLineCnt <= 0) return;
        this._ensurePenThinInstance();
        this._flushPenBuffersToGpu(0, this.pLineCnt);
        this._bakePenLinesToTexture();
        this._resetPenRuntimeLines();
        this.pNeedBake = false;
    }

    // 强制上传所有线条到GPU（烘焙前需要）
    _flushPenBuffersToGpu(start, end) {
        if (!this.pMesh || end <= start) return;
        this.pMesh.thinInstanceCount = this.pLineCnt;
        this.pMesh.thinInstancePartialBufferUpdate("matrix", end - start, start);
        this.pMesh.thinInstancePartialBufferUpdate("instanceColor", end - start, start);
    }

    // 执行烘焙（渲染到纹理）
    _bakePenLinesToTexture() {
        if (!this.pBakeTex || !this.pMesh || this.pLineCnt <= 0) return;
        this._syncPenBakeTextureSize();
        this.pBakeTex.renderList = [this.pMesh];
        this.pBakeTex.resetRefreshCounter();
        this.pBakeTex.render(false);
    }

    // 清空运行时线条（保留烘焙纹理）
    _resetPenRuntimeLines() {
        this.pLineCnt = 0;
        this.pCntChanged = true;
        this.pDirtyStart = -1;
        this.pDirtyEnd = 0;
        this.pDirty = true;
    }

    // 清除烘焙纹理内容
    _clearBakedPenTexture() {
        if (!this.pBakeTex) return;
        const prevSkip = this.pBakeTex.skipInitialClear;
        const prevList = this.pBakeTex.renderList;
        this.pBakeTex.skipInitialClear = false;
        this.pBakeTex.renderList = [];
        this.pBakeTex.resetRefreshCounter();
        this.pBakeTex.render(false);
        this.pBakeTex.renderList = prevList;
        this.pBakeTex.skipInitialClear = prevSkip;
    }

    // 标记脏数据区间
    _markPenDirtyRange(start, end) {
        if (this.pDirtyStart < 0 || start < this.pDirtyStart) this.pDirtyStart = start;
        if (end > this.pDirtyEnd) this.pDirtyEnd = end;
    }

    // 确保缓冲区够用，不够则扩容或淘汰
    _ensurePenBufferCapacity(need) {
        if (need <= this.maxLines) return;
        const hardCap = Math.max(this.pInitLines, this.pMaxLines);
        if (need > hardCap) {
            if (this.pSkipBakeThisFrame && this.pLineCnt > 0) {
                this._bakeRuntimePenBatch();
                if (need <= this.maxLines) return;
            }
            this._evictPenLines(need - hardCap);
            if (this.pLineCnt + 1 <= this.maxLines) return;
        }
        let next = this.maxLines;
        while (next < need && next < hardCap) next *= 2;
        next = Math.min(next, hardCap);
        if (next > this.maxLines) {
            this._resizePenBuffers(next);
            if (this.pMesh) {
                this.pMesh.thinInstanceSetBuffer("matrix", this.pMatBuf, 16, false);
                this.pMesh.thinInstanceSetBuffer("instanceColor", this.pColBuf, 4, false);
                this.pCntChanged = true;
                this._markPenDirtyRange(0, this.pLineCnt);
                this.pDirty = true;
            }
        } else if (need > this.maxLines) {
            this._evictPenLines(need - this.maxLines);
        }
    }

    // 调整缓冲区大小
    _resizePenBuffers(newMax) {
        const newMat = new Float32Array(newMax * 16);
        newMat.set(this.pMatBuf.subarray(0, this.pLineCnt * 16));
        this.pMatBuf = newMat;
        const newCol = new Float32Array(newMax * 4);
        newCol.set(this.pColBuf.subarray(0, this.pLineCnt * 4));
        this.pColBuf = newCol;
        this.maxLines = newMax;
    }

    // 淘汰旧线条（当缓冲区满且不允许扩容时）
    _evictPenLines(needFree) {
        const drop = Math.max(1, Math.floor(this.maxLines * this.pEvictRatio), needFree);
        const toDrop = Math.min(this.pLineCnt, drop);
        if (toDrop <= 0) return;
        const remain = this.pLineCnt - toDrop;
        if (remain > 0) {
            this.pMatBuf.copyWithin(0, toDrop * 16, this.pLineCnt * 16);
            this.pColBuf.copyWithin(0, toDrop * 4, this.pLineCnt * 4);
        }
        this.pLineCnt = remain;
        this.pCntChanged = true;
        this._markPenDirtyRange(0, remain);
        this.pDirty = true;
    }

    // ------------------- 精灵相关 -------------------

    _generateId() {
        return `sprite_${this.nextId++}`;
    }

    // 创建精灵数据（只是数据，不渲染）
    createSprite(
        texturePath,
        x = 0,
        y = 0,
        direction = 0,
        size = 100,
        rotationCenterOffsetX = 0,
        rotationCenterOffsetY = 0,
        visible=true,
    ) {
        const id = this._generateId();
        const layerOrder = this.layerPool.length;
        this.layerPool.push(id);
        this.layerMap.set(id, layerOrder);
        const spr = {
            id,
            texture: texturePath,
            texturePath,
            x,
            y,
            direction,
            size,
            rotationCenterOffsetX,
            rotationCenterOffsetY,
            visible,
            color: 0,
            fisheye: 0,
            whirl: 0,
            pixelate: 0,
            mosaic: 0,
            brightness: 0,
            ghost: 0,
            layerOrder,
        };
        spr.setlayer = (mode) => {
            const next = this._setSpriteLayer(id, mode);
            if (next !== undefined) spr.layerOrder = next;
        };
        spr.offsetlayer = (offset) => {
            const next = this._offsetSpriteLayer(id, offset);
            if (next !== undefined) spr.layerOrder = next;
        };
        this.spriteRefMap.set(id, spr);
        return spr;
    }

    // 每帧更新精灵（根据传入的sprite列表）
    renderTick(sprites) {
        if (this.screenSpace) {
            if (!this._screenSpaceCam) {
                this._initScreenSpace();
            } else if (this.scene.activeCamera !== this._mainCamera) {
                if (this._mainCamera) this._mainCamera.layerMask &= ~0x2;
                this.scene.activeCameras = [this._mainCamera, this._screenSpaceCam];
            }
        }
        this._syncPenBakeTextureSize();
        const curIds = new Set();
        const sprMap = new Map();
        for (const spr of sprites) {
            const id = spr.id;
            this._syncSpriteLayer(id, spr);
            curIds.add(id);
            sprMap.set(id, spr);
        }

        const ordered = [];
        for (const id of this.layerPool) {
            if (sprMap.has(id)) ordered.push(sprMap.get(id));
        }

        const texGroups = new Map();
        for (const spr of ordered) {
            if (!spr.visible) continue;
            const tex = this._resolveTexturePath(spr);
            if (!texGroups.has(tex)) texGroups.set(tex, []);
            texGroups.get(tex).push(spr);
        }

        const usedTextures = new Set();
        for (const [tex, group] of texGroups) {
            usedTextures.add(tex);
            this._updateBatch(tex, group);
        }

        // 清理已移除的纹理批次
        for (const [tex, batch] of this.batchMap) {
            if (!usedTextures.has(tex)) {
                batch.mesh.dispose();
                this.batchMap.delete(tex);
            }
        }

        // 清理已移除的精灵
        for (const [id] of this.spriteRefMap) {
            if (!curIds.has(id)) {
                this.spriteRefMap.delete(id);
                this._removeSpriteLayer(id);
            }
        }

        this._updatePen();
    }

    // ---------- 实例化批次相关 ----------

    _computeInstanceMatrix(spr, matEnt) {
        const texW = matEnt.size.width;
        const texH = matEnt.size.height;
        const m = new Float32Array(16);
        let targetW, targetH;
        if (spr.width !== undefined && spr.height !== undefined) {
            targetW = spr.width;
            targetH = spr.height;
        } else if (spr.width !== undefined) {
            targetW = spr.width;
            targetH = spr.width * (texH / texW);
        } else if (spr.height !== undefined) {
            targetH = spr.height;
            targetW = spr.height * (texW / texH);
        } else {
            const scale = (spr.size !== undefined ? spr.size : 100) / 100;
            targetW = texW * scale;
            targetH = texH * scale;
        }
        const fx = Number(spr.fisheye || 0);
        if (fx) {
            const v = Math.max(-100, Math.min(100, fx));
            targetW *= (1 + v * 0.0015);
        }
        const whirl = Number(spr.whirl || 0);
        if (whirl) {
            const w = Math.max(-180, Math.min(180, whirl));
            const rk = 1 + Math.abs(w) * 0.001;
            targetW *= rk;
            targetH /= rk;
        }
        const angle = (90 - spr.direction) * Math.PI / 180;
        const rotX = spr.rotationCenterOffsetX || 0;
        const rotY = spr.rotationCenterOffsetY || 0;
        const centerX = texW * 0.5;
        const centerY = texH * 0.5;
        const scaleX = targetW / texW;
        const scaleY = targetH / texH;
        const deltaX = centerX - rotX;
        const deltaY = rotY - centerY;
        const offLocalX = deltaX * scaleX;
        const offLocalY = deltaY * scaleY;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotOffX = offLocalX * cos - offLocalY * sin;
        const rotOffY = offLocalX * sin + offLocalY * cos;
        const posX = spr.x + rotOffX;
        const posY = spr.y + rotOffY;
        const posZ = 1 + spr.layerOrder * -0.01;
        m[0] = cos * targetW;
        m[1] = sin * targetW;
        m[2] = 0;
        m[3] = 0;
        m[4] = -sin * targetH;
        m[5] = cos * targetH;
        m[6] = 0;
        m[7] = 0;
        m[8] = 0;
        m[9] = 0;
        m[10] = 1;
        m[11] = 0;
        m[12] = posX;
        m[13] = posY;
        m[14] = posZ;
        m[15] = 1;
        return m;
    }

    _computeInstanceColor(spr) {
        const ghost = Number(spr.ghost || 0);
        const brightness = Number(spr.brightness || 0);
        const color = spr.color || 0;
        let r, g, b;
        if (color) {
            r = ((color >> 16) & 0xFF) / 255;
            g = ((color >> 8) & 0xFF) / 255;
            b = (color & 0xFF) / 255;
        } else {
            r = 1; g = 1; b = 1;
        }
        const bm = 1 + brightness / 100;
        r = Math.min(1, Math.max(0, r * bm));
        g = Math.min(1, Math.max(0, g * bm));
        b = Math.min(1, Math.max(0, b * bm));
        const alpha = Math.max(0, Math.min(1, 1 - ghost / 100));
        return new Float32Array([r, g, b, alpha]);
    }

    _ensureBatch(texPath) {
        let batch = this.batchMap.get(texPath);
        if (batch) return batch;
        this._getOrCreateMaterial(texPath);
        const tracking = this.materialMap.get(texPath);
        const mat = new StandardMaterial(`spriteBatchMat_${texPath}`, this.scene);
        mat.disableLighting = true;
        mat.emissiveColor = Color3.White();
        mat.useVertexColor = true;
        mat.backFaceCulling = false;
        mat.forceDepthWrite = false;
        mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;
        if (tracking && tracking.texture) {
            mat.diffuseTexture = tracking.texture;
            mat.useAlphaFromDiffuseTexture = true;
        }
        const mesh = MeshBuilder.CreatePlane(
            `spriteBatch_${texPath}`,
            { width: 1, height: 1, sideOrientation: BABYLON.Mesh.FRONTSIDE },
            this.scene
        );
        mesh.material = mat;
        mesh.renderingGroupId = 2;
        mesh.isPickable = false;
        if (this.screenSpace) mesh.layerMask = 0x2;
        batch = {
            mesh,
            material: mat,
            matrixBuf: new Float32Array(0),
            colorBuf: new Float32Array(0),
            instanceCount: 0,
        };
        this.batchMap.set(texPath, batch);
        return batch;
    }

    _updateBatch(texPath, sprites) {
        const count = sprites.length;
        if (count === 0) {
            const batch = this.batchMap.get(texPath);
            if (batch) {
                batch.mesh.dispose();
                this.batchMap.delete(texPath);
            }
            return;
        }
        const batch = this._ensureBatch(texPath);
        const matEnt = this.materialMap.get(texPath);
        if (matEnt && matEnt.texture && batch.material.diffuseTexture !== matEnt.texture) {
            batch.material.diffuseTexture = matEnt.texture;
            batch.material.useAlphaFromDiffuseTexture = true;
        }
        batch.mesh.alphaIndex = sprites[0].layerOrder;

        const capacityChanged = batch.matrixBuf.length < count * 16;
        if (capacityChanged) {
            batch.matrixBuf = new Float32Array(count * 16);
            batch.colorBuf = new Float32Array(count * 4);
            batch.mesh.thinInstanceSetBuffer("matrix", batch.matrixBuf, 16, false);
            batch.mesh.thinInstanceSetBuffer("instanceColor", batch.colorBuf, 4, false);
        }
        batch.instanceCount = count;
        batch.mesh.thinInstanceCount = count;

        for (let i = 0; i < count; i++) {
            const spr = sprites[i];
            const matOff = i * 16;
            const colOff = i * 4;
            if (matEnt && matEnt.size) {
                const m = this._computeInstanceMatrix(spr, matEnt);
                batch.matrixBuf.set(m, matOff);
            } else {
                const mb = batch.matrixBuf;
                mb[matOff] = 1; mb[matOff + 1] = 0; mb[matOff + 2] = 0; mb[matOff + 3] = 0;
                mb[matOff + 4] = 0; mb[matOff + 5] = 1; mb[matOff + 6] = 0; mb[matOff + 7] = 0;
                mb[matOff + 8] = 0; mb[matOff + 9] = 0; mb[matOff + 10] = 1; mb[matOff + 11] = 0;
                mb[matOff + 12] = spr.x; mb[matOff + 13] = spr.y; mb[matOff + 14] = 1; mb[matOff + 15] = 1;
            }
            const c = this._computeInstanceColor(spr);
            batch.colorBuf.set(c, colOff);
        }

        batch.mesh.thinInstancePartialBufferUpdate("matrix", count, 0);
        batch.mesh.thinInstancePartialBufferUpdate("instanceColor", count, 0);
    }

    _setSpriteLayer(id, mode) {
        if (!this.layerMap.has(id)) return;
        const cur = this.layerMap.get(id);
        this.layerPool.splice(cur, 1);
        if (mode === "front") {
            this.layerPool.push(id);
        } else if (mode === "back") {
            this.layerPool.unshift(id);
        } else {
            this.layerPool.splice(cur, 0, id);
        }
        this._rebuildLayerOrder();
        return this.layerMap.get(id);
    }

    _offsetSpriteLayer(id, offset) {
        if (!this.layerMap.has(id)) return;
        const cur = this.layerMap.get(id);
        const delta = Number(offset || 0);
        let next = cur + delta;
        if (next < 0) next = 0;
        const max = this.layerPool.length - 1;
        if (next > max) next = max;
        if (next === cur) return cur;
        this.layerPool.splice(cur, 1);
        this.layerPool.splice(next, 0, id);
        this._rebuildLayerOrder();
        return this.layerMap.get(id);
    }

    _syncSpriteLayer(id, spr) {
        if (!this.layerMap.has(id)) {
            this.layerPool.push(id);
            this.layerMap.set(id, this.layerPool.length - 1);
            this._rebuildLayerOrder();
        }
        spr.layerOrder = this.layerMap.get(id);
    }

    _rebuildLayerOrder() {
        for (let i = 0; i < this.layerPool.length; i++) {
            this.layerMap.set(this.layerPool[i], i);
        }
        for (const [id, spr] of this.spriteRefMap) {
            spr.layerOrder = this.layerMap.get(id) ?? 0;
        }
    }

    _removeSpriteLayer(id) {
        if (!this.layerMap.has(id)) return;
        const idx = this.layerMap.get(id);
        this.layerPool.splice(idx, 1);
        this.layerMap.delete(id);
        this._rebuildLayerOrder();
    }

    _resolveTexturePath(spr) {
        const raw = spr.texturePath || spr.texture;
        const tex = this._normalizeTexturePath(raw);
        spr.texturePath = tex;
        spr.texture = tex;
        return tex;
    }

    _normalizeTexturePath(path) {
        if (!path) return path;
        if (/^(data:|blob:|https?:|file:|\.\/|\.\.\/|\/|[a-zA-Z]:[\\/])/.test(path)) return path;
        return `./assets/${path}`;
    }

    _getSpriteVisibility(spr) {
        const g = Number(spr.ghost ?? 0);
        const alpha = 1 - g / 100;
        if (alpha <= 0) return 0;
        if (alpha >= 1) return 1;
        return alpha;
    }

    _getOrCreateMaterial(texPath) {
        if (this.backend) return;
        let ent = this.materialMap.get(texPath);
        if (!ent) {
            const mat = new StandardMaterial(`mat_${texPath}`, this.scene);
            const tempTex = this._createTransparentTexture();
            this._setupSpriteMaterial(mat, tempTex);
            ent = { material: mat, texture: tempTex, size: null, loading: null };
            this.materialMap.set(texPath, ent);
            // 异步加载纹理
            ent.loading = this._loadTextureCanvas(texPath)
                .then(({ canvas, width, height, displayWidth, displayHeight }) => {
                    const loadedTex = this._createDynamicTextureFromCanvas(texPath, canvas, width, height);
                    mat.diffuseTexture = loadedTex;
                    if (ent.texture && ent.texture !== loadedTex) ent.texture.dispose();
                    ent.texture = loadedTex;
                    ent.size = {
                        width: displayWidth !== undefined ? displayWidth : width,
                        height: displayHeight !== undefined ? displayHeight : height
                    };
                    this._refreshMaterialMeshScale(mat);
                });
        }
        return ent.material;
    }

    _setupSpriteMaterial(mat, tex) {
        mat.diffuseTexture = tex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        mat.forceDepthWrite = false;
        mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;
        mat.disableLighting=true;
        mat.emissiveColor = Color3.White();
        
    }

    // 纹理加载完成后无需手动刷新，下一帧 _updateBatch 自动使用 matEnt.size
    _refreshMaterialMeshScale(mat) {
    }

    _createTransparentTexture() {
        return this._createDynamicTextureFromCanvas("__empty__", null, 1, 1);
    }

    _createDynamicTextureFromCanvas(name, canvas, w, h) {
        const isSvg = name && name.toLowerCase().includes('.svg');
        const samplingMode = isSvg
            ? BABYLON.Constants.TEXTURE_LINEAR_SAMPLINGMODE
            : BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE;
        
        const tex = new BABYLON.DynamicTexture(
            `dyn_${name}`,
            { width: w, height: h },
            this.scene,
            false,
            samplingMode
        );
        if (isSvg) {
            
        }
        tex.anisotropicFilteringLevel = 16; // 最大 16
        const ctx = tex.getContext();
        ctx.clearRect(0, 0, w, h);
        if (canvas) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(canvas, 0, 0, w, h);
        }
        tex.wrapU = BABYLON.Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.wrapV = BABYLON.Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.hasAlpha = true;
        tex.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
        tex.update(this._shouldInvertCanvasTextureY());
        return tex;
    }

    async _loadTextureCanvas(texPath) {
        const img = await this._loadImage(texPath);
        let w = Math.round(img.naturalWidth || img.width || 1);
        let h = Math.round(img.naturalHeight || img.height || 1);
        
        // 针对 SVG 提高纹理分辨率
        const isSvg = texPath && texPath.toLowerCase().endsWith('.svg');
        if (isSvg) {
            const scale = this.svgscale; // 或 4，根据性能需求调整
            w *= scale;
            h *= scale;
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;  // 保持边缘清晰（对 SVG 可选 true 获得平滑）
        ctx.drawImage(img, 0, 0, w, h);
        
        const bitmapScale = this._getBitmapDisplayScale(texPath);
        return {
            canvas,
            width: w,
            height: h,
            displayWidth: w / bitmapScale,
            displayHeight: h / bitmapScale
        };
    }

    _getBitmapDisplayScale(texPath) {
        if (!texPath) return 1;
        if (texPath.toLowerCase().endsWith('.svg')) return this.svgscale;   // 与 PNG 一致或更高
        if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(texPath)) return 2;
        return 1;
    }

    _loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.decoding = "sync";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`load img fail: ${src}`));
            img.src = src;
        });
    }

    _toScratchRotationRadians(dir) {
        return (dir - 90) * Math.PI / 180;
    }

    _shouldInvertCanvasTextureY() {
        return true;
    }

    /**
     * 确保碰撞检测渲染目标纹理已初始化
     * @private
     */
    _ensureCollisionRT() {
        if (this.collisionRT) return;
        
        const size = this.collisionRTSize;
        const bounds = this.pBounds;
        const dispW = bounds.right - bounds.left;
        const dispH = bounds.top - bounds.bottom;
        
        // 正交相机，匹配舞台边界
        this.collisionCam = new BABYLON.FreeCamera("collisionCamera", new BABYLON.Vector3(0, 0, -10), this.scene);
        this.collisionCam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
        this.collisionCam.minZ = 0.1;
        this.collisionCam.maxZ = 100;
        this.collisionCam.orthoLeft = bounds.left;
        this.collisionCam.orthoRight = bounds.right;
        this.collisionCam.orthoBottom = bounds.bottom;
        this.collisionCam.orthoTop = bounds.top;
        this.collisionCam.setTarget(BABYLON.Vector3.Zero());
        
        // 渲染纹理 - 启用stencil buffer用于遮罩
        this.collisionRT = new BABYLON.RenderTargetTexture(
            "collisionRT",
            { width: size, height: size },
            this.scene,
            {
                generateMipMaps: false,
                doNotChangeAspectRatio: true,
                samplingMode: BABYLON.Texture.NEAREST_SAMPLINGMODE,
                generateDepthBuffer: true,
                generateStencilBuffer: true
            }
        );
        this.collisionRT.clearColor = new BABYLON.Color4(0, 0, 0, 0);
        this.collisionRT.activeCamera = this.collisionCam;
        this.collisionRT.renderParticles = false;
        this.collisionRT.renderSprites = false;
        this.collisionRT.skipInitialClear = false;
        this.collisionRT.refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
        
        // 碰撞检测材质 - 只输出alpha值
        this.collisionMaterial = new StandardMaterial("collisionMat", this.scene);
        this.collisionMaterial.disableLighting = true;
        this.collisionMaterial.emissiveColor = new Color3(1, 1, 1);
        this.collisionMaterial.diffuseColor = new Color3(1, 1, 1);
        this.collisionMaterial.specularColor = new Color3(0, 0, 0);
        this.collisionMaterial.alpha = 1;
        this.collisionMaterial.backFaceCulling = false;
        // 使用alpha测试，只渲染不透明像素
        this.collisionMaterial.alphaMode = BABYLON.Engine.ALPHA_COMBINE;
        this.collisionMaterial.separateCullingPass = false;
    }

    /**
     * 获取精灵对应的mesh
     * @private
     */
    _getSpriteMesh(sprite) {
        return null;
    }

    /**
     * GPU加速的碰撞检测
     * @private
     */
    _gpuCollisionDetection(sprite1, sprite2) {
        this._ensureCollisionRT();
        
        const mesh1 = this._getSpriteMesh(sprite1);
        const mesh2 = this._getSpriteMesh(sprite2);
        if (!mesh1 || !mesh2) return false;
        
        // 保存原始材质
        const originalMat1 = mesh1.material;
        const originalMat2 = mesh2.material;
        
        try {
            // 设置碰撞检测材质
            mesh1.material = this.collisionMaterial;
            mesh2.material = this.collisionMaterial;
            
            // 清除渲染纹理
            const engine = this.scene.getEngine();
            this.collisionRT.clearColor = new BABYLON.Color4(0, 0, 0, 0);
            
            // 第一步：渲染第一个精灵到stencil buffer
            // 设置stencil操作：始终通过，替换为1
            // 在Babylon.js中，我们需要通过材质设置stencil
            // 简化：直接渲染两个精灵，然后检查重叠
            
            // 临时设置渲染列表
            this.collisionRT.renderList = [mesh1, mesh2];
            this.collisionRT.resetRefreshCounter();
            this.collisionRT.render(false);
            
            // 读取像素数据
            const bounds = this.pBounds;
            const width = this.collisionRTSize;
            const height = this.collisionRTSize;
            
            // 计算重叠区域在纹理中的坐标
            const box1 = this._getSpriteBoundingBox(sprite1);
            const box2 = this._getSpriteBoundingBox(sprite2);
            const overlapLeft = Math.max(box1.left, box2.left);
            const overlapRight = Math.min(box1.right, box2.right);
            const overlapBottom = Math.max(box1.bottom, box2.bottom);
            const overlapTop = Math.min(box1.top, box2.top);
            
            if (overlapLeft >= overlapRight || overlapBottom >= overlapTop) {
                return false;
            }
            
            // 将世界坐标转换为纹理坐标
            const scaleX = width / (bounds.right - bounds.left);
            const scaleY = height / (bounds.top - bounds.bottom);
            const offsetX = -bounds.left;
            const offsetY = -bounds.bottom;
            
            const texLeft = Math.floor((overlapLeft + offsetX) * scaleX);
            const texRight = Math.ceil((overlapRight + offsetX) * scaleX);
            const texBottom = Math.floor((overlapBottom + offsetY) * scaleY);
            const texTop = Math.ceil((overlapTop + offsetY) * scaleY);
            
            const readWidth = Math.max(1, texRight - texLeft);
            const readHeight = Math.max(1, texTop - texBottom);
            
            // 读取像素
            const pixelData = new Uint8Array(readWidth * readHeight * 4);
            engine.readPixels(texLeft, texBottom, readWidth, readHeight, pixelData);
            
            // 检查是否有不透明像素
            for (let i = 0; i < pixelData.length; i += 4) {
                if (pixelData[i + 3] > 128) { // alpha通道
                    return true;
                }
            }
            
            return false;
        } finally {
            // 恢复原始材质
            if (originalMat1) mesh1.material = originalMat1;
            if (originalMat2) mesh2.material = originalMat2;
            // 清空渲染列表
            this.collisionRT.renderList = [];
        }
    }

    /**
     * 检查两个精灵是否碰撞（像素级精确检测）
     * @param {Object} sprite1 - 第一个精灵对象（由 createSprite 创建）
     * @param {Object} sprite2 - 第二个精灵对象
     * @returns {boolean} 是否碰撞
     */
    checkhit(sprite1, sprite2) {
        const box1 = this._getSpriteBoundingBox(sprite1);
        const box2 = this._getSpriteBoundingBox(sprite2);
        return this._boxesIntersect(box1, box2);


        //return this._gpuCollisionDetection(sprite1, sprite2);

    }

    /**
     * 获取精灵的纹理尺寸和缩放后尺寸
     * @private
     */
    _getSpriteDimensions(sprite) {
        const matEnt = this.materialMap.get(sprite.texture);
        if (!matEnt || !matEnt.size) {
            // 纹理未加载，返回默认尺寸
            return { texW: 1, texH: 1, targetW: 1, targetH: 1, scaleX: 1, scaleY: 1 };
        }
        const texW = matEnt.size.width;
        const texH = matEnt.size.height;
        let targetW, targetH;
        if (sprite.width !== undefined && sprite.height !== undefined) {
            targetW = sprite.width;
            targetH = sprite.height;
        } else if (sprite.width !== undefined) {
            targetW = sprite.width;
            targetH = sprite.width * (texH / texW);
        } else if (sprite.height !== undefined) {
            targetH = sprite.height;
            targetW = sprite.height * (texW / texH);
        } else {
            const scale = (sprite.size !== undefined ? sprite.size : 100) / 100;
            targetW = texW * scale;
            targetH = texH * scale;
        }
        const scaleX = targetW / texW;
        const scaleY = targetH / texH;
        return { texW, texH, targetW, targetH, scaleX, scaleY };
    }

    /**
     * 获取精灵纹理的 alpha 数据（二维数组，0-255）
     * @private
     */
    _getTextureAlphaData(sprite) {
        const texturePath = sprite.texture;
        // 检查缓存
        if (this.alphaDataCache.has(texturePath)) {
            return this.alphaDataCache.get(texturePath);
        }
        
        const matEnt = this.materialMap.get(texturePath);
        if (!matEnt || !matEnt.texture) {
            // 纹理未加载，返回全透明数据
            const result = { width: 1, height: 1, data: [[0]] };
            this.alphaDataCache.set(texturePath, result);
            return result;
        }
        const texture = matEnt.texture;
        // 确保纹理是 DynamicTexture
        if (typeof texture.getContext !== 'function') {
            const result = { width: 1, height: 1, data: [[0]] };
            this.alphaDataCache.set(texturePath, result);
            return result;
        }
        const ctx = texture.getContext();
        const width = texture.getSize().width;
        const height = texture.getSize().height;
        // 读取 ImageData
        const imageData = ctx.getImageData(0, 0, width, height);
        const alphaData = [];
        for (let y = 0; y < height; y++) {
            const row = [];
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                row.push(imageData.data[idx + 3]); // alpha 通道
            }
            alphaData.push(row);
        }
        const result = { width, height, data: alphaData };
        this.alphaDataCache.set(texturePath, result);
        return result;
    }

    /**
     * 快速将世界坐标转换为精灵纹理坐标（使用预计算的变换和alpha数据）
     * @private
     */
    _worldToTextureFast(sprite, worldX, worldY, transformData, alphaData) {
        const { texW, texH, scaleX, scaleY, rotX, rotY, cos, sin, spriteX, spriteY } = transformData;
        // 世界坐标相对于精灵中心
        const dx = worldX - spriteX;
        const dy = worldY - spriteY;
        // 反向旋转
        const localX = dx * cos + dy * sin;
        const localY = -dx * sin + dy * cos;
        // 除以缩放比例
        const texLocalX = localX / scaleX;
        const texLocalY = localY / scaleY;
        // 加上旋转中心偏移
        const u = texLocalX + rotX;
        const v = texLocalY + rotY;
        // 检查是否在纹理范围内
        if (u < 0 || u >= texW || v < 0 || v >= texH) {
            return 0;
        }
        // 注意：纹理坐标可能是浮点数，需要四舍五入到最近的像素
        const x = Math.floor(u);
        const y = Math.floor(v);
        if (x >= 0 && x < alphaData.width && y >= 0 && y < alphaData.height) {
            return alphaData.data[y][x];
        }
        return 0;
    }

    /**
     * 获取精灵四个角的世界坐标（考虑旋转中心、缩放、旋转）
     * @private
     */
    _getSpriteCorners(sprite) {
        const { texW, texH, targetW, targetH, scaleX, scaleY } = this._getSpriteDimensions(sprite);
        const rotX = sprite.rotationCenterOffsetX || 0;
        const rotY = sprite.rotationCenterOffsetY || 0;
        
        // 局部角点相对于旋转中心（缩放前）
        const localCorners = [
            { x: -rotX, y: -rotY },
            { x: texW - rotX, y: -rotY },
            { x: texW - rotX, y: texH - rotY },
            { x: -rotX, y: texH - rotY }
        ];
        
        // 应用缩放
        const scaledCorners = localCorners.map(corner => ({
            x: corner.x * scaleX,
            y: corner.y * scaleY
        }));
        
        // 旋转角度（弧度）
        const angle = (90 - (sprite.direction || 0)) * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        
        // 应用旋转和平移（sprite.x, sprite.y 已经是考虑了旋转中心偏移的位置）
        // 注意：sprite.x 和 sprite.y 是旋转中心的世界坐标
        const worldCorners = scaledCorners.map(corner => {
            const rx = corner.x * cos - corner.y * sin;
            const ry = corner.x * sin + corner.y * cos;
            return {
                x: sprite.x + rx,
                y: sprite.y + ry
            };
        });
        
        return worldCorners;
    }

    /**
     * 获取精灵的轴对齐包围盒
     * @private
     */
    _getSpriteBoundingBox(sprite) {
        const corners = this._getSpriteCorners(sprite);
        let left = Infinity;
        let right = -Infinity;
        let top = -Infinity;
        let bottom = Infinity;
        for (const corner of corners) {
            if (corner.x < left) left = corner.x;
            if (corner.x > right) right = corner.x;
            if (corner.y > top) top = corner.y;
            if (corner.y < bottom) bottom = corner.y;
        }
        return { left, right, top, bottom };
    }

    /**
     * 检查两个包围盒是否相交
     * @private
     */
    _boxesIntersect(box1, box2) {
        return !(box1.right < box2.left || box1.left > box2.right ||
                box1.bottom > box2.top || box1.top < box2.bottom);
    }

    /**
     * 获取精灵的变换数据（用于坐标转换）
     * @private
     */
    _getSpriteTransformData(sprite) {
        const { texW, texH, scaleX, scaleY } = this._getSpriteDimensions(sprite);
        const rotX = sprite.rotationCenterOffsetX || 0;
        const rotY = sprite.rotationCenterOffsetY || 0;
        const angle = (90 - (sprite.direction || 0)) * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return { texW, texH, scaleX, scaleY, rotX, rotY, cos, sin, spriteX: sprite.x, spriteY: sprite.y };
    }

    /**
     * 将世界坐标转换为精灵纹理坐标，并返回 alpha 值（0-255）
     * @private
     */
    _worldToTexture(sprite, worldX, worldY) {
        const { texW, texH, scaleX, scaleY, rotX, rotY, cos, sin, spriteX, spriteY } = this._getSpriteTransformData(sprite);
        // 世界坐标相对于精灵中心
        const dx = worldX - spriteX;
        const dy = worldY - spriteY;
        // 反向旋转
        const localX = dx * cos + dy * sin;
        const localY = -dx * sin + dy * cos;
        // 除以缩放比例
        const texLocalX = localX / scaleX;
        const texLocalY = localY / scaleY;
        // 加上旋转中心偏移
        const u = texLocalX + rotX;
        const v = texLocalY + rotY;
        // 检查是否在纹理范围内
         if (u < 0 || u >= texW || v < 0 || v >= texH) {
             return { u, v, alpha: 0 };
         }
         // 获取 alpha 数据
         const alphaData = this._getTextureAlphaData(sprite);
         // 注意：纹理坐标可能是浮点数，需要四舍五入到最近的像素
         const x = Math.floor(u);
         const y = Math.floor(v);
         if (x >= 0 && x < alphaData.width && y >= 0 && y < alphaData.height) {
             const alpha = alphaData.data[y][x];
             return { u, v, alpha };
         }
         return { u, v, alpha: 0 };
    }

    /**
     * 像素级精确碰撞检测
     * @private
     */
    _pixelPerfectCollision(sprite1, sprite2) {
        // 预计算变换数据和alpha数据
        const transformData1 = this._getSpriteTransformData(sprite1);
        const transformData2 = this._getSpriteTransformData(sprite2);
        const alphaData1 = this._getTextureAlphaData(sprite1);
        const alphaData2 = this._getTextureAlphaData(sprite2);
        
        // 获取两个精灵的包围盒
        const box1 = this._getSpriteBoundingBox(sprite1);
        const box2 = this._getSpriteBoundingBox(sprite2);
        // 计算重叠区域
        const overlapLeft = Math.max(box1.left, box2.left);
        const overlapRight = Math.min(box1.right, box2.right);
        const overlapBottom = Math.max(box1.bottom, box2.bottom);
        const overlapTop = Math.min(box1.top, box2.top);
        if (overlapLeft >= overlapRight || overlapBottom >= overlapTop) {
            return false; // 没有重叠
        }
        
        const overlapWidth = overlapRight - overlapLeft;
        const overlapHeight = overlapTop - overlapBottom;
        const overlapArea = overlapWidth * overlapHeight;
        
        // 动态步长：根据重叠区域大小调整
        // 面积越大，步长越大，但最大不超过8像素
        let step = 1;
        if (overlapArea > 1000) step = 2;
        if (overlapArea > 5000) step = 3;
        if (overlapArea > 20000) step = 4;
        if (overlapArea > 50000) step = 6;
        if (overlapArea > 100000) step = 8;
        
        // 先快速检测四个角点
        const corners = [
            { x: overlapLeft, y: overlapBottom },
            { x: overlapRight, y: overlapBottom },
            { x: overlapLeft, y: overlapTop },
            { x: overlapRight, y: overlapTop }
        ];
        
        for (const corner of corners) {
            const alpha1 = this._worldToTextureFast(sprite1, corner.x, corner.y, transformData1, alphaData1);
            const alpha2 = this._worldToTextureFast(sprite2, corner.x, corner.y, transformData2, alphaData2);
            if (alpha1 > 128 && alpha2 > 128) {
                return true;
            }
        }
        
        // 遍历重叠区域
        for (let y = overlapBottom; y <= overlapTop; y += step) {
            for (let x = overlapLeft; x <= overlapRight; x += step) {
                const alpha1 = this._worldToTextureFast(sprite1, x, y, transformData1, alphaData1);
                const alpha2 = this._worldToTextureFast(sprite2, x, y, transformData2, alphaData2);
                // 如果两个精灵在该点都不透明（alpha > 阈值），则发生碰撞
                if (alpha1 > 128 && alpha2 > 128) {
                    return true;
                }
            }
        }
        return false;
    }
}
