/**
 * ShadowWaterMaterial (JS version, ESM)
 * ------------------------------------
 * 基于 Babylon.js / @babylonjs/materials 的 WaterMaterial 修改而来：
 * - 修复点光/聚光阴影只应遮挡其自身贡献的问题
 * - 补齐水面对局部灯光的高光响应
 * - 增加水体基础亮度、浑浊度等可控参数
 *
 * 兼容：Babylon.js 9.1.0 / @babylonjs/materials 9.1.0
 *
 * ---------------------------------------------------------------------------
 * Apache License 2.0 Notice
 * ---------------------------------------------------------------------------
 * This file contains modifications to Babylon.js WaterMaterial.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WaterMaterial } from "@babylonjs/materials/water/waterMaterial.js";

import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { EffectFallbacks } from "@babylonjs/core/Materials/effectFallbacks.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration.js";
import { MaterialFlags } from "@babylonjs/core/Materials/materialFlags.js";
import { AddClipPlaneUniforms } from "@babylonjs/core/Materials/clipPlaneMaterialHelper.js";
import {
  HandleFallbacksForShadows,
  PrepareAttributesForBones,
  PrepareAttributesForInstances,
  PrepareDefinesForAttributes,
  PrepareDefinesForFrameBoundValues,
  PrepareDefinesForLights,
  PrepareDefinesForMisc,
  PrepareUniformsAndSamplersList,
} from "@babylonjs/core/Materials/materialHelper.functions.js";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector.js";

// ShaderStore + includes（确保 bundle/按需加载时 include 可用）
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions.js";
import "@babylonjs/core/Shaders/ShadersInclude/imageProcessingDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/imageProcessingFunctions.js";
import "@babylonjs/core/Shaders/ShadersInclude/lightFragmentDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/lightUboDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/lightsFragmentFunctions.js";
import "@babylonjs/core/Shaders/ShadersInclude/shadowsFragmentFunctions.js";
import "@babylonjs/core/Shaders/ShadersInclude/clipPlaneFragmentDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/logDepthDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/fogFragmentDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/clipPlaneFragment.js";
import "@babylonjs/core/Shaders/ShadersInclude/lightFragment.js";
import "@babylonjs/core/Shaders/ShadersInclude/logDepthFragment.js";
import "@babylonjs/core/Shaders/ShadersInclude/fogFragment.js";

import "@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/bakedVertexAnimationDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/instancesDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/clipPlaneVertexDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/fogVertexDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/logDepthDeclaration.js";
import "@babylonjs/core/Shaders/ShadersInclude/instancesVertex.js";
import "@babylonjs/core/Shaders/ShadersInclude/bonesVertex.js";
import "@babylonjs/core/Shaders/ShadersInclude/bakedVertexAnimation.js";
import "@babylonjs/core/Shaders/ShadersInclude/clipPlaneVertex.js";
import "@babylonjs/core/Shaders/ShadersInclude/fogVertex.js";
import "@babylonjs/core/Shaders/ShadersInclude/shadowsVertex.js";
import "@babylonjs/core/Shaders/ShadersInclude/vertexColorMixing.js";
import "@babylonjs/core/Shaders/ShadersInclude/logDepthVertex.js";

// -----------------------------------------------------------------------------
// 自定义 lightFragment include：用“光照权重”来加权 shadow，避免点光超出照射范围时仍然参与平均导致把日光压暗
// 原版：aggShadow += shadow; numLights += 1.0;
// 改为：按当前光源在该像素的“未乘 shadow 的贡献(info.diffuse/specular)”作为权重
// -----------------------------------------------------------------------------
if (ShaderStore.IncludesShadersStore.lightFragment && !ShaderStore.IncludesShadersStore.shadowWaterLightFragment) {
  ShaderStore.IncludesShadersStore.shadowWaterLightFragment = ShaderStore.IncludesShadersStore.lightFragment.replace(
    "aggShadow+=shadow;numLights+=1.0;",
    [
      // 用未乘 shadow 的光照贡献（info.diffuse）做权重，并做一个“非线性压缩”，让远处很弱的点光贡献更快衰减（连续、无硬阈值）
      // 这样点光被遮挡时，只会影响它真正照得到的区域，不会“全局压暗”日光。
      "float _lw{X}=max(max(info.diffuse.r,info.diffuse.g),info.diffuse.b);",
      "float _w{X}=_lw{X}*_lw{X};_w{X}*=_w{X};", // pow4
      "aggShadow+=shadow*_w{X};numLights+=_w{X};",
    ].join("")
  );
}

class ShadowWaterMaterialDefines extends MaterialDefines {
  constructor() {
    super();

    this.BUMP = false;
    this.REFLECTION = false;

    this.CLIPPLANE = false;
    this.CLIPPLANE2 = false;
    this.CLIPPLANE3 = false;
    this.CLIPPLANE4 = false;
    this.CLIPPLANE5 = false;
    this.CLIPPLANE6 = false;

    this.ALPHATEST = false;
    this.DEPTHPREPASS = false;

    this.POINTSIZE = false;
    this.FOG = false;

    this.NORMAL = false;
    this.UV1 = false;
    this.UV2 = false;
    this.VERTEXCOLOR = false;
    this.VERTEXALPHA = false;

    this.NUM_BONE_INFLUENCERS = 0;
    this.BonesPerMesh = 0;

    this.INSTANCES = false;
    this.INSTANCESCOLOR = false;

    this.SPECULARTERM = false;

    this.LOGARITHMICDEPTH = false;
    this.USE_REVERSE_DEPTHBUFFER = false;

    this.FRESNELSEPARATE = false;
    this.BUMPSUPERIMPOSE = false;
    this.NORMAL_LAYER3 = false;
    this.BUMPAFFECTSREFLECTION = false;
    this.USE_WORLD_COORDINATES = false;

    this.IMAGEPROCESSING = false;
    this.IS_REFLECTION_LINEAR = false;
    this.IS_REFRACTION_LINEAR = false;
    this.VIGNETTE = false;
    this.VIGNETTEBLENDMODEMULTIPLY = false;
    this.VIGNETTEBLENDMODEOPAQUE = false;
    this.TONEMAPPING = 0;
    this.CONTRAST = false;
    this.EXPOSURE = false;
    this.COLORCURVES = false;
    this.COLORGRADING = false;
    this.COLORGRADING3D = false;
    this.SAMPLER3DGREENDEPTH = false;
    this.SAMPLER3DBGRMAP = false;
    this.DITHER = false;
    this.IMAGEPROCESSINGPOSTPROCESS = false;
    this.SKIPFINALCOLORCLAMP = false;

    this.rebuild();
  }
}

export class ShadowWaterMaterial extends WaterMaterial {
  constructor(name, scene, renderTargetSize) {
    super(name, scene, renderTargetSize);
    /**
     * 水面“基础亮度/底色”强度（主要影响折射/水色那部分），用于在无直射光时避免水面发白。
     * - 1：保持当前效果（默认）
     * - 0：仅保留反射（更贴近“完全由环境决定”）
     * 建议 0.2~0.8。
     */
    this.baseWaterIntensity = 1.0;
    /**
     * 水体浑浊度/杂质密度（越大越浑浊）。
     * 用一个近似的 Beer-Lambert 吸收来衰减“水底/折射画面”的可见度，并让颜色更趋向 waterColor。
     * - 0：完全清澈（不额外衰减折射画面）
     * - 0.5~2：常见浑浊范围（取决于场景尺度与相机高度）
     */
    this.turbidityDensity = 0.0;
    /**
     * 是否在“折射 RTT”（水下画面）渲染时，临时开启/覆盖 Scene.fog，从源头把水下物体雾化。
     * 相比只在最终合成里对 refractiveColor 做衰减，这种方式能更自然地让水下反射/折射细节随距离“糊开”。
     */
    this.enableTurbidityFogInRefraction = true;
    /**
     * 折射 RTT 的可视距离基准（世界单位）。最终 fogEnd 会按 turbidityDensity 反比缩放：
     *   fogEnd ≈ turbidityFogDistance / turbidityDensity
     */
    this.turbidityFogDistance = 50.0;
    /** 折射 RTT 雾的起始距离（世界单位） */
    this.turbidityFogStart = 0.0;

    // 在渲染 refraction RTT 时临时覆盖 scene fog，并在渲染结束后恢复
    this._turbidityFogStack = [];
    if (this.refractionTexture && !this._turbidityFogObserversAdded) {
      this._turbidityFogObserversAdded = true;
      this.refractionTexture.onBeforeRenderObservable.add(() => {
        const s = this.getScene();
        if (!s) return;
        if (!this.enableTurbidityFogInRefraction) return;
        const d = this.turbidityDensity ?? 0.0;
        if (d <= 0.0) return;

        // push current fog state
        this._turbidityFogStack.push({
          fogMode: s.fogMode,
          fogStart: s.fogStart,
          fogEnd: s.fogEnd,
          fogDensity: s.fogDensity,
          fogColor: s.fogColor ? s.fogColor.clone() : null,
        });

        const fogEnd = Math.max(this.turbidityFogStart + 0.001, this.turbidityFogDistance / Math.max(d, 1e-3));
        s.fogMode = 3; // Scene.FOGMODE_LINEAR
        s.fogStart = this.turbidityFogStart;
        s.fogEnd = fogEnd;
        if (s.fogColor && this.waterColor) {
          s.fogColor.copyFrom(this.waterColor);
        }
      });

      this.refractionTexture.onAfterRenderObservable.add(() => {
        const s = this.getScene();
        if (!s) return;
        const prev = this._turbidityFogStack.pop();
        if (!prev) return;
        s.fogMode = prev.fogMode;
        s.fogStart = prev.fogStart;
        s.fogEnd = prev.fogEnd;
        s.fogDensity = prev.fogDensity;
        if (prev.fogColor && s.fogColor) {
          s.fogColor.copyFrom(prev.fogColor);
        }
      });
    }
    /** 完全阴影处对“透射(折射+水色) + 高光”的最低亮度系数（反射部分不乘） */
    this.shadowDarkness = 0.35;
    /**
     * 反射 UV 边缘渐隐宽度（X 方向，0~0.2）。用于抑制 reflection RTT 的 MIRROR wrap 伪影。
     * 如果你看到屏幕底部仍有“黑边/黑条”，优先调大 reflectionEdgeFadeY。
     */
    this.reflectionEdgeFade = 0.02;
    /**
     * 反射 UV 边缘渐隐宽度（Y 方向，0~0.5）。底部黑边通常需要更大的 Y 渐隐。
     */
    this.reflectionEdgeFadeY = 0.15;
    /**
     * 反射(Reflection RTT) 的 UV 扰动强度倍率。
     * 用于“bumpHeight 调大更真实，但反射里的物体被撕裂太严重”的场景：
     * - 1：不改变（默认）
     * - 0.5：反射画面只受到一半 bumpHeight 扰动
     */
    this.reflectionBumpMultiplier = 1.0;
    /**
     * 把 Babylon 灯光(点光/聚光/平行光/半球光)的“局部衰减”映射到水面亮度的强度。
     * - 0：完全不额外受灯光影响（更接近原版 WaterMaterial：几乎只看 RTT）
     * - >0：点光源会只在局部“圈”内影响水面（渐变），并且其阴影影响也会随衰减变弱
     */
    this.directLightContribution = 1.0;
    /** 是否启用高光（用于点光/聚光在水面上的“光点”反射） */
    this.enableSpecular = true;
    /** 高光颜色（RGB） */
    this.specularColor = new Color3(1, 1, 1);
    /** 高光锐度/光泽度（越大越“尖”），会写入 vSpecularColor.a */
    this.specularPower = 256.0;
    /** 高光强度（避免“塑料感”/过亮），0~1 常用 */
    this.specularIntensity = 0.35;
    /** 水的镜面反射基准 F0（物理上水约 0.02） */
    this.specularF0 = 0.02;
    /**
     * “波光/闪光”(glint) 开关：只在高光足够亮时才显示，避免出现半亮导致的塑料感。
     * 该项是在常规高光(finalSpecular)之外额外叠加的“阈值化高光”。
     */
    this.enableSparkle = true;
    /** 波光亮度阈值（基于高光亮度的归一化门限），越大越“只剩最亮的闪点” */
    this.sparkleThreshold = 0.65;
    /** 阈值软化宽度（避免硬阈值导致闪烁/锯齿） */
    this.sparkleSoftness = 0.08;
    /** 波光额外增益（越大越亮） */
    this.sparkleIntensity = 3.0;
    /** 波光 mask 的幂（越大越接近“只有最亮的点才出现”） */
    this.sparklePower = 2.0;
    /**
     * 波光能量缩放（独立于 specularIntensity）。
     * 用来解决“为了去塑料感把 specularIntensity 降低后，波光也跟着变淡”的问题。
     * - 不影响常规高光 baseSpecular（仍然保持更物理、更不塑料）
     * - 只影响波光 sparkle 的触发与亮度
     */
    this.sparkleSpecularScale = 3.0;
    /** 日光(方向光)波光额外增强（解决“太阳波光只有 0.2 左右很淡”的问题） */
    this.sparkleDirectionalBoost = 3.0;
    /**
     * 波光在正视角(NoV≈1)下的最低 Fresnel（用于解决“点光在水面上方、垂直向下看不到波光”的问题）。
     * 波光仍然会受 sparkleThreshold 控制：不够亮就不显示，因此不会引入半亮塑料感。
     */
    this.sparkleMinFresnel = 0.06;
    /**
     * 波光亮度映射强度：用于把“高光能量”映射到 0..1 再做阈值判断。
     * 解决“光源离水面很高(尤其点光很远)时，高光能量变小导致即使照到也过不了阈值”的问题。
     * 值越大越容易触发波光，但仍受 sparkleThreshold 控制，不会出现半亮塑料感。
     */
    this.sparkleLumaScale = 10.0;
    /**
     * 仅当场景存在方向光时，对波光做“碎化”噪声调制（更像日光碎波光）。
     * 噪声基于世界坐标与时间，不影响水面正常反射/折射，只影响波光 mask。
     */
    this.sparkleNoiseScale = 0.35;
    this.sparkleNoiseSpeed = 0.15;
    this.sparkleNoiseThreshold = 0.72;
    // 默认降低一些，避免高亮处出现“噪点感”；需要更碎可再调大
    this.sparkleNoiseAmount = 0.35;
    /** 噪声阈值软化（避免看起来像像素噪点） */
    this.sparkleNoiseSoftness = 0.08;
    /**
     * 碎波光细节层（0~1）：加入第二层更高频的噪声以打散“像素格/棋盘格”观感。
     * - 0：只用一层（可能更容易看到格子）
     * - 0.3~0.7：推荐
     * - 1：细节最强（可能更碎）
     */
    this.sparkleNoiseDetail = 0.55;
    /**
     * 波光抗锯齿强度：用于根据屏幕导数(fwidth)自动加宽阈值过渡，抑制高亮处“像素点/闪烁”。
     * WebGPU/WebGL2 下效果最好；WebGL1 若无导数支持会退化为仅使用 softness。
     */
    this.sparkleAAStrength = 1.0;
    /**
     * waveLength 越大（波纹越“粗”），波光阈值越容易表现出像素化边缘。
     * 这里用 waveLength 来自适应放宽波光阈值的抗锯齿宽度，给波光一个更平滑的“过渡”。
     */
    this.sparkleWaveLengthRef = 10.0;
    this.sparkleWaveLengthAAMax = 3.0;

    // -----------------------------------------------------------------------
    // 方向光(太阳)独立波光系统（更接近 three.js Water.js 的思路）
    // 不依赖 Babylon 的 Light 对象（只需外部把太阳方向/颜色传进来）
    // -----------------------------------------------------------------------
    /** 是否启用“太阳独立波光”(sun glint) */
    this.enableSunGlint = true;
    /**
     * 太阳方向（从水面指向太阳的方向，单位向量）
     * 如果你用 Babylon DirectionalLight：通常可用 -light.direction 归一化得到。
     */
    this.sunDirection = new Vector3(0, 1, 0);
    /** 太阳颜色（RGB） */
    this.sunColor = new Color3(1, 1, 1);
    /** 太阳波光强度 */
    this.sunGlintIntensity = 1.0;
    /** 太阳波光锐度（越大越尖/越像亮点群），建议 64~512 */
    this.sunGlintPower = 256.0;
    /**
     * 太阳反射“圆盘/亮斑”大小倍率（影响太阳波光的高光半径）。
     * - 1：默认大小
     * - >1：更大、更容易形成“太阳盘/亮带”
     * - <1：更小、更尖锐
     */
    this.sunGlintDiskSize = 1.0;
    /** 太阳波光 Fresnel 幂（越大越偏掠射更强） */
    this.sunGlintFresnelPower = 3.0;
    /** 太阳波光阈值（0~1，越大越只保留最亮的闪点） */
    this.sunGlintThreshold = 0.82;
    /** 太阳波光阈值软化（避免像素化/锯齿） */
    this.sunGlintSoftness = 0.03;
    /** 太阳波光噪声：空间尺度（越大越细碎） */
    this.sunGlintNoiseScale = 0.25;
    /** 太阳波光噪声：时间速度 */
    this.sunGlintNoiseSpeed = 0.35;
    /** 太阳波光噪声阈值（稀疏化） */
    this.sunGlintNoiseThreshold = 0.72;
    /** 太阳波光噪声影响强度（0~1） */
    this.sunGlintNoiseAmount = 0.9;
    /**
     * 法线/波浪对“折射/反射 UV 扰动”和“受光(漫反射/高光)”的统一强度系数。
     * 建议范围 1~8（取决于你的 normalSampler 幅度与 bumpHeight）。
     */
    this.normalStrength = 4.0;
    /**
     * 受光（漫反射/高光）用的法线扰动强度。
     * 通常应小于 UV 扰动，否则高光会被波峰波谷“抹开”显得过大/发塑料。
     */
    this.lightingNormalStrength = 1.5;

    /**
     * 法线层数（模仿 three.js Water.js 的多层法线叠加）。
     * - 1：单层（更像“只有在移动”）
     * - 2/3：多层干涉（更像“有波浪”）
     */
    this.normalLayerCount = 2;
    /** 第二层法线：UV 缩放（相对于第一层），越大越细碎 */
    this.normalLayer2Scale = 0.75;
    /** 第二层法线：滚动速度系数 */
    this.normalLayer2Speed = 1.3;
    /** 第二层法线：混合权重（0~1） */
    this.normalLayer2Weight = 0.35;
    /** 第三层法线：UV 缩放（相对于第一层） */
    this.normalLayer3Scale = 1.35;
    /** 第三层法线：滚动速度系数 */
    this.normalLayer3Speed = 0.85;
    /** 第三层法线：混合权重（0~1） */
    this.normalLayer3Weight = 0.2;

    /**
     * 法线/波浪动画时间参数（用于解决“法线移动一抽一抽”的问题）。
     * 说明：当 time 值增长到很大时，float 精度会变差，导致时间步进（看起来像抖动/抽动）。
     * 这里使用高精度计时器（performance.now / Date.now）并做 wrap，避免 time 变得过大。
     */
    this.timeScale = 1.0;
    /** time 的循环周期（秒）。<=0 表示不循环；建议保持 60~600 之间。 */
    this.timeWrapSeconds = 300.0;
    this._timeStartMs = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
    /**
     * 兜底 HDR 压缩（场景未启用 tonemapping 时，避免强光把颜色夹成纯白导致 RTT 细节消失）。
     * 如果你的管线已经启用 ImageProcessing+Tonemapping，可以关掉它。
     */
    this.enableFallbackTonemapping = true;
    /**
     * 灯光渐变的响应曲线强度（越大越“收敛”成一个更小的圈）。
     * 一般点光源建议 2~8。
     */
    this.directLightScale = 4.0;
    /**
     * 局部灯光（点光/聚光）半径衰减曲线幂（越大圈越小、边缘越硬但仍平滑）。
     * 一般建议 2~8。
     */
    this.directLightFalloffPower = 4.0;
    /**
     * 多盏阴影灯叠加时的“压暗程度”曲线（>1 会让半阴影更暗，避免两盏灯阴影重合处反而变亮）。
     * 一般建议 2。
     */
    this.shadowCombinePower = 2.0;
    /**
     * 局部灯光（点光/聚光）最大作用半径上限（世界单位）。
     * Babylon 的 PointLight.range 默认可能非常大（近似无限），会导致整片水面都被当作“在光圈内”。
     * 这个参数用于在材质侧强制截断，确保点光只影响一个圈。
     */
    this.localLightRangeMax = 100.0;
  }

  getClassName() {
    return "ShadowWaterMaterial";
  }

  /**
   * 便捷函数：从 Babylon 的 DirectionalLight 同步太阳方向与颜色。
   * @param directionalLight Babylon DirectionalLight
   */
  setSunFromDirectionalLight(directionalLight) {
    if (!directionalLight) return;
    // Babylon 的 DirectionalLight.direction 是“光线射向”的方向；我们需要“从表面指向太阳”的方向
    this.sunDirection.copyFrom(directionalLight.direction).scaleInPlace(-1);
    this.sunDirection.normalize();
    if (directionalLight.diffuse) {
      this.sunColor.copyFrom(directionalLight.diffuse);
    }
  }

  isReadyForSubMesh(mesh, subMesh, useInstances) {
    // 基本逻辑复制自 WaterMaterial（9.1.0），仅替换 shaderName + 增加一个 uniform：shadowDarkness
    const drawWrapper = subMesh._drawWrapper;
    if (this.isFrozen) {
      if (drawWrapper.effect && drawWrapper._wasPreviouslyReady && drawWrapper._wasPreviouslyUsingInstances === useInstances) {
        return true;
      }
    }

    if (!subMesh.materialDefines) {
      subMesh.materialDefines = new ShadowWaterMaterialDefines();
    }

    const defines = subMesh.materialDefines;
    const scene = this.getScene();
    if (this._isReadyForSubMesh(subMesh)) {
      return true;
    }

    const engine = scene.getEngine();

    if (defines._areTexturesDirty) {
      defines._needUVs = false;
      if (scene.texturesEnabled) {
        if (this.bumpTexture && MaterialFlags.BumpTextureEnabled) {
          if (!this.bumpTexture.isReady()) {
            return false;
          } else {
            defines._needUVs = true;
            defines.BUMP = true;
          }
        }
        if (MaterialFlags.ReflectionTextureEnabled) {
          defines.REFLECTION = true;
        }
      }
    }

    PrepareDefinesForFrameBoundValues(scene, engine, this, defines, !!useInstances);
    PrepareDefinesForMisc(
      mesh,
      scene,
      this._useLogarithmicDepth,
      this.pointsCloud,
      this.fogEnabled,
      this.needAlphaTestingForMesh(mesh),
      defines,
      undefined,
      undefined,
      undefined,
      this._isVertexOutputInvariant
    );

    if (defines._areMiscDirty) {
      defines.FRESNELSEPARATE = this._fresnelSeparate;
      // 我们用 normalLayerCount 来控制多层法线，因此不再依赖 WaterMaterial 内部的 _bumpSuperimpose
      defines.BUMPSUPERIMPOSE = (this.normalLayerCount | 0) >= 2;
      defines.BUMPAFFECTSREFLECTION = this._bumpAffectsReflection;
      defines.USE_WORLD_COORDINATES = this._useWorldCoordinatesForWaveDeformation;
      // 允许点光/聚光在水面形成“光点”高光；没有它会看起来像“只乘 shadow，不吃灯光”
      defines.SPECULARTERM = !!this.enableSpecular;
      // 第三层法线需要额外 varying
      defines.NORMAL_LAYER3 = (this.normalLayerCount | 0) >= 3;
    }

    defines._needNormals = PrepareDefinesForLights(scene, mesh, defines, true, this._maxSimultaneousLights, this._disableLighting);

    const ipc = this._imageProcessingConfiguration;
    if (defines._areImageProcessingDirty && ipc) {
      if (!ipc.isReady()) {
        return false;
      }
      ipc.prepareDefines(defines);
      defines.IS_REFLECTION_LINEAR = this.reflectionTexture != null && !this.reflectionTexture.gammaSpace;
      defines.IS_REFRACTION_LINEAR = this.refractionTexture != null && !this.refractionTexture.gammaSpace;
    }

    PrepareDefinesForAttributes(mesh, defines, true, true);

    this._mesh = mesh;
    if (this._waitingRenderList) {
      for (let i = 0; i < this._waitingRenderList.length; i++) {
        this.addToRenderList(scene.getNodeById(this._waitingRenderList[i]));
      }
      this._waitingRenderList = null;
    }

    if (defines.isDirty) {
      defines.markAsProcessed();
      scene.resetCachedMaterial();

      const fallbacks = new EffectFallbacks();
      if (defines.FOG) {
        fallbacks.addFallback(1, "FOG");
      }
      if (defines.LOGARITHMICDEPTH) {
        fallbacks.addFallback(0, "LOGARITHMICDEPTH");
      }
      HandleFallbacksForShadows(defines, fallbacks, this.maxSimultaneousLights);
      if (defines.NUM_BONE_INFLUENCERS > 0) {
        fallbacks.addCPUSkinningFallback(0, mesh);
      }

      const attribs = [VertexBuffer.PositionKind];
      if (defines.NORMAL) attribs.push(VertexBuffer.NormalKind);
      if (defines.UV1) attribs.push(VertexBuffer.UVKind);
      if (defines.UV2) attribs.push(VertexBuffer.UV2Kind);
      if (defines.VERTEXCOLOR) attribs.push(VertexBuffer.ColorKind);
      PrepareAttributesForBones(attribs, mesh, defines, fallbacks);
      PrepareAttributesForInstances(attribs, defines);

      const shaderName = "shadowWater";
      const join = defines.toString();

      const uniforms = [
        "world",
        "view",
        "viewProjection",
        "vEyePosition",
        "vLightsType",
        "vDiffuseColor",
        "vSpecularColor",
        "vFogInfos",
        "vFogColor",
        "pointSize",
        "vNormalInfos",
        "mBones",
        "normalMatrix",
        "logarithmicDepthConstant",
        "reflectionViewProjection",
        "windDirection",
        "waveLength",
        "time",
        "windForce",
        "cameraPosition",
        "bumpHeight",
        "waveHeight",
        "waterColor",
        "waterColor2",
        "colorBlendFactor",
        "colorBlendFactor2",
        "waveSpeed",
        "waveCount",
        "shadowDarkness",
        "reflectionEdgeFade",
        "reflectionEdgeFadeY",
        "reflectionBumpMultiplier",
        "directLightContribution",
        "directLightScale",
        "directLightFalloffPower",
        "shadowCombinePower",
        "localLightRangeMax",
        "normalStrength",
        "enableFallbackTonemapping",
        "baseWaterIntensity",
        "specularIntensity",
        "specularF0",
        "lightingNormalStrength",
        "turbidityDensity",
        "enableSparkle",
        "sparkleThreshold",
        "sparkleSoftness",
        "sparkleIntensity",
        "sparklePower",
        "sparkleSpecularScale",
        "sparkleDirectionalBoost",
        "sparkleMinFresnel",
        "sparkleNoiseScale",
        "sparkleNoiseSpeed",
        "sparkleNoiseThreshold",
        "sparkleNoiseAmount",
        "sparkleNoiseSoftness",
        "sparkleLumaScale",
        "sparkleAAStrength",
        "sparkleNoiseDetail",
        "sparkleWaveLengthRef",
        "sparkleWaveLengthAAMax",
        "sunDirection",
        "sunColor",
        "enableSunGlint",
        "sunGlintIntensity",
        "sunGlintPower",
        "sunGlintDiskSize",
        "sunGlintFresnelPower",
        "sunGlintThreshold",
        "sunGlintSoftness",
        "sunGlintNoiseScale",
        "sunGlintNoiseSpeed",
        "sunGlintNoiseThreshold",
        "sunGlintNoiseAmount",
        "normalLayer2Scale",
        "normalLayer2Speed",
        "normalLayer2Weight",
        "normalLayer3Scale",
        "normalLayer3Speed",
        "normalLayer3Weight",
      ];

      const samplers = ["normalSampler", "refractionSampler", "reflectionSampler"];
      const uniformBuffers = [];

      if (ImageProcessingConfiguration) {
        ImageProcessingConfiguration.PrepareUniforms(uniforms, defines);
        ImageProcessingConfiguration.PrepareSamplers(samplers, defines);
      }
      AddClipPlaneUniforms(uniforms);

      PrepareUniformsAndSamplersList({
        uniformsNames: uniforms,
        uniformBuffersNames: uniformBuffers,
        samplers,
        defines,
        maxSimultaneousLights: this.maxSimultaneousLights,
      });

      subMesh.setEffect(
        scene.getEngine().createEffect(
          shaderName,
          {
            attributes: attribs,
            uniformsNames: uniforms,
            uniformBuffersNames: uniformBuffers,
            samplers,
            defines: join,
            fallbacks,
            onCompiled: this.onCompiled,
            onError: this.onError,
            indexParameters: { maxSimultaneousLights: this._maxSimultaneousLights },
          },
          engine
        ),
        defines,
        this._materialContext
      );
    }

    if (!subMesh.effect || !subMesh.effect.isReady()) {
      return false;
    }

    defines._renderId = scene.getRenderId();
    drawWrapper._wasPreviouslyReady = true;
    drawWrapper._wasPreviouslyUsingInstances = !!useInstances;
    return true;
  }

  bindForSubMesh(world, mesh, subMesh) {
    super.bindForSubMesh(world, mesh, subMesh);
    if (this._activeEffect) {
      // 用高精度计时器重写 time，避免 time 过大导致 float 精度不足引发“抽动”
      const nowMs = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      let t = ((nowMs - this._timeStartMs) * 0.001) * (this.timeScale ?? 1.0);
      const wrap = this.timeWrapSeconds ?? 0.0;
      if (wrap > 0.0) {
        t = t % wrap;
      }
      this._activeEffect.setFloat("time", t);

      this._activeEffect.setFloat("shadowDarkness", this.shadowDarkness);
      this._activeEffect.setFloat("reflectionEdgeFade", this.reflectionEdgeFade);
      this._activeEffect.setFloat("reflectionEdgeFadeY", this.reflectionEdgeFadeY);
      this._activeEffect.setFloat("reflectionBumpMultiplier", this.reflectionBumpMultiplier);
      this._activeEffect.setFloat("directLightContribution", this.directLightContribution);
      this._activeEffect.setFloat("directLightScale", this.directLightScale);
      this._activeEffect.setFloat("directLightFalloffPower", this.directLightFalloffPower);
      this._activeEffect.setFloat("shadowCombinePower", this.shadowCombinePower);
      this._activeEffect.setFloat("localLightRangeMax", this.localLightRangeMax);
      this._activeEffect.setFloat("normalStrength", this.normalStrength);
      this._activeEffect.setFloat("lightingNormalStrength", this.lightingNormalStrength);
      this._activeEffect.setFloat("enableFallbackTonemapping", this.enableFallbackTonemapping ? 1.0 : 0.0);
      this._activeEffect.setFloat("baseWaterIntensity", this.baseWaterIntensity);
      this._activeEffect.setFloat("specularIntensity", this.specularIntensity);
      this._activeEffect.setFloat("specularF0", this.specularF0);
      this._activeEffect.setFloat("turbidityDensity", this.turbidityDensity);
      this._activeEffect.setFloat("enableSparkle", this.enableSparkle ? 1.0 : 0.0);
      this._activeEffect.setFloat("sparkleThreshold", this.sparkleThreshold);
      this._activeEffect.setFloat("sparkleSoftness", this.sparkleSoftness);
      this._activeEffect.setFloat("sparkleIntensity", this.sparkleIntensity);
      this._activeEffect.setFloat("sparklePower", this.sparklePower);
      this._activeEffect.setFloat("sparkleSpecularScale", this.sparkleSpecularScale);
      this._activeEffect.setFloat("sparkleDirectionalBoost", this.sparkleDirectionalBoost);
      this._activeEffect.setFloat("sparkleMinFresnel", this.sparkleMinFresnel);
      this._activeEffect.setFloat("sparkleNoiseScale", this.sparkleNoiseScale);
      this._activeEffect.setFloat("sparkleNoiseSpeed", this.sparkleNoiseSpeed);
      this._activeEffect.setFloat("sparkleNoiseThreshold", this.sparkleNoiseThreshold);
      this._activeEffect.setFloat("sparkleNoiseAmount", this.sparkleNoiseAmount);
      this._activeEffect.setFloat("sparkleNoiseSoftness", this.sparkleNoiseSoftness);
      this._activeEffect.setFloat("sparkleLumaScale", this.sparkleLumaScale);
      this._activeEffect.setFloat("sparkleAAStrength", this.sparkleAAStrength);
      this._activeEffect.setFloat("sparkleNoiseDetail", this.sparkleNoiseDetail);
      this._activeEffect.setFloat("sparkleWaveLengthRef", this.sparkleWaveLengthRef);
      this._activeEffect.setFloat("sparkleWaveLengthAAMax", this.sparkleWaveLengthAAMax);
      this._activeEffect.setVector3("sunDirection", this.sunDirection);
      // sunColor 是 Color3（r/g/b），必须用 setColor3（而不是 setVector3 的 x/y/z），否则会传入 NaN 导致整片发黑
      this._activeEffect.setColor3("sunColor", this.sunColor);
      this._activeEffect.setFloat("enableSunGlint", this.enableSunGlint ? 1.0 : 0.0);
      this._activeEffect.setFloat("sunGlintIntensity", this.sunGlintIntensity);
      this._activeEffect.setFloat("sunGlintPower", this.sunGlintPower);
      this._activeEffect.setFloat("sunGlintDiskSize", this.sunGlintDiskSize);
      this._activeEffect.setFloat("sunGlintFresnelPower", this.sunGlintFresnelPower);
      this._activeEffect.setFloat("sunGlintThreshold", this.sunGlintThreshold);
      this._activeEffect.setFloat("sunGlintSoftness", this.sunGlintSoftness);
      this._activeEffect.setFloat("sunGlintNoiseScale", this.sunGlintNoiseScale);
      this._activeEffect.setFloat("sunGlintNoiseSpeed", this.sunGlintNoiseSpeed);
      this._activeEffect.setFloat("sunGlintNoiseThreshold", this.sunGlintNoiseThreshold);
      this._activeEffect.setFloat("sunGlintNoiseAmount", this.sunGlintNoiseAmount);
      this._activeEffect.setFloat("normalLayer2Scale", this.normalLayer2Scale);
      this._activeEffect.setFloat("normalLayer2Speed", this.normalLayer2Speed);
      this._activeEffect.setFloat("normalLayer2Weight", this.normalLayer2Weight);
      this._activeEffect.setFloat("normalLayer3Scale", this.normalLayer3Scale);
      this._activeEffect.setFloat("normalLayer3Speed", this.normalLayer3Speed);
      this._activeEffect.setFloat("normalLayer3Weight", this.normalLayer3Weight);
      if (this.enableSpecular) {
        const c = this.specularColor ?? Color3.White();
        this._activeEffect.setVector4("vSpecularColor", new Vector4(c.r, c.g, c.b, this.specularPower));
      }
    }
  }
}

RegisterClass("BABYLON.ShadowWaterMaterial", ShadowWaterMaterial);

// -----------------------------------------------------------------------------
// Shaders: shadowWaterVertexShader / shadowWaterPixelShader
// -----------------------------------------------------------------------------

const shadowWaterVertexShader = `precision highp float;
attribute vec3 position;
#ifdef NORMAL
attribute vec3 normal;
#endif
#ifdef UV1
attribute vec2 uv;
#endif
#ifdef UV2
attribute vec2 uv2;
#endif
#ifdef VERTEXCOLOR
attribute vec4 color;
#endif

#include<bonesDeclaration>
#include<bakedVertexAnimationDeclaration>
#include<instancesDeclaration>

uniform mat4 view;
uniform mat4 viewProjection;

#ifdef BUMP
varying vec2 vNormalUV;
#ifdef BUMPSUPERIMPOSE
varying vec2 vNormalUV2;
#endif
#ifdef NORMAL_LAYER3
varying vec2 vNormalUV3;
#endif
uniform mat4 normalMatrix;
uniform vec2 vNormalInfos;
#endif

#ifdef POINTSIZE
uniform float pointSize;
#endif

varying vec3 vPositionW;
#ifdef NORMAL
varying vec3 vNormalW;
#endif

#if defined(VERTEXCOLOR) || defined(INSTANCESCOLOR) && defined(INSTANCES)
varying vec4 vColor;
#endif

#include<clipPlaneVertexDeclaration>
#include<fogVertexDeclaration>
#include<__decl__lightFragment>[0..maxSimultaneousLights]
#include<logDepthDeclaration>

uniform mat4 reflectionViewProjection;
uniform vec2 windDirection;
uniform float waveLength;
uniform float time;
uniform float windForce;
uniform float waveHeight;
uniform float waveSpeed;
uniform float waveCount;
// 多层法线参数（layer1 使用现有 windDirection/windForce/waveLength）
uniform float normalLayer2Scale;
uniform float normalLayer2Speed;
uniform float normalLayer3Scale;
uniform float normalLayer3Speed;

varying vec3 vRefractionMapTexCoord;
varying vec3 vReflectionMapTexCoord;

#if defined(CLUSTLIGHT_BATCH) && CLUSTLIGHT_BATCH>0
varying float vViewDepth;
#endif

#define CUSTOM_VERTEX_DEFINITIONS
void main(void) {
#define CUSTOM_VERTEX_MAIN_BEGIN

#ifdef VERTEXCOLOR
vec4 colorUpdated = color;
#endif

#include<instancesVertex>
#include<bonesVertex>
#include<bakedVertexAnimation>

vec4 worldPos = finalWorld * vec4(position,1.0);
vPositionW = vec3(worldPos);

#ifdef NORMAL
vNormalW = normalize(vec3(finalWorld * vec4(normal,0.0)));
#endif

#ifndef UV1
vec2 uv = vec2(0.,0.);
#endif
#ifndef UV2
vec2 uv2 = vec2(0.,0.);
#endif

#ifdef BUMP
if (vNormalInfos.x == 0.) {
  vec2 d1 = normalize(windDirection);
  vec2 d2 = normalize(vec2(-d1.y, d1.x)); // 垂直方向，形成干涉
  vec2 d3 = normalize(d1 * 0.7 + d2 * 0.7);
  vNormalUV = vec2(normalMatrix * vec4((uv*1.0)/waveLength + time*windForce*d1, 1.0, 0.0));
  #ifdef BUMPSUPERIMPOSE
  vNormalUV2 = vec2(normalMatrix * vec4((uv*normalLayer2Scale)/waveLength + time*normalLayer2Speed*windForce*d2, 1.0, 0.0));
  #endif
  #ifdef NORMAL_LAYER3
  vNormalUV3 = vec2(normalMatrix * vec4((uv*normalLayer3Scale)/waveLength + time*normalLayer3Speed*windForce*d3, 1.0, 0.0));
  #endif
} else {
  vec2 d1 = normalize(windDirection);
  vec2 d2 = normalize(vec2(-d1.y, d1.x));
  vec2 d3 = normalize(d1 * 0.7 + d2 * 0.7);
  vNormalUV = vec2(normalMatrix * vec4((uv2*1.0)/waveLength + time*windForce*d1, 1.0, 0.0));
  #ifdef BUMPSUPERIMPOSE
  vNormalUV2 = vec2(normalMatrix * vec4((uv2*normalLayer2Scale)/waveLength + time*normalLayer2Speed*windForce*d2, 1.0, 0.0));
  #endif
  #ifdef NORMAL_LAYER3
  vNormalUV3 = vec2(normalMatrix * vec4((uv2*normalLayer3Scale)/waveLength + time*normalLayer3Speed*windForce*d3, 1.0, 0.0));
  #endif
}
#endif

#include<clipPlaneVertex>
#include<fogVertex>
#include<shadowsVertex>[0..maxSimultaneousLights]
#include<vertexColorMixing>

#if defined(POINTSIZE) && !defined(WEBGPU)
gl_PointSize = pointSize;
#endif

float finalWaveCount = 1.0/(waveCount*0.5);
#ifdef USE_WORLD_COORDINATES
vec3 p = worldPos.xyz;
#else
vec3 p = position;
#endif

float newY =
  (sin(((p.x/finalWaveCount)+time*waveSpeed))*waveHeight*windDirection.x*5.0) +
  (cos(((p.z/finalWaveCount)+time*waveSpeed))*waveHeight*windDirection.y*5.0);
p.y += abs(newY);

#ifdef USE_WORLD_COORDINATES
gl_Position = viewProjection * vec4(p,1.0);
#else
gl_Position = viewProjection * finalWorld * vec4(p,1.0);
#endif

#ifdef REFLECTION
vRefractionMapTexCoord.x = 0.5*(gl_Position.w + gl_Position.x);
vRefractionMapTexCoord.y = 0.5*(gl_Position.w + gl_Position.y);
vRefractionMapTexCoord.z = gl_Position.w;

worldPos = reflectionViewProjection * finalWorld * vec4(position,1.0);
vReflectionMapTexCoord.x = 0.5*(worldPos.w + worldPos.x);
vReflectionMapTexCoord.y = 0.5*(worldPos.w + worldPos.y);
vReflectionMapTexCoord.z = worldPos.w;
#endif

#include<logDepthVertex>
#define CUSTOM_VERTEX_MAIN_END
}`;

const shadowWaterPixelShader = `#ifdef LOGARITHMICDEPTH
#extension GL_EXT_frag_depth : enable
#endif
precision highp float;

uniform vec4 vEyePosition;
uniform vec4 vDiffuseColor;
#ifdef SPECULARTERM
uniform vec4 vSpecularColor;
#endif

varying vec3 vPositionW;
#ifdef NORMAL
varying vec3 vNormalW;
#endif

#if defined(VERTEXCOLOR) || defined(INSTANCESCOLOR) && defined(INSTANCES)
varying vec4 vColor;
#endif

#include<helperFunctions>
#include<imageProcessingDeclaration>
#include<imageProcessingFunctions>
#include<__decl__lightFragment>[0..maxSimultaneousLights]
#include<lightsFragmentFunctions>
#include<shadowsFragmentFunctions>

#ifdef BUMP
varying vec2 vNormalUV;
#ifdef BUMPSUPERIMPOSE
varying vec2 vNormalUV2;
#endif
#ifdef NORMAL_LAYER3
varying vec2 vNormalUV3;
#endif
uniform sampler2D normalSampler;
uniform vec2 vNormalInfos;
#endif

uniform sampler2D refractionSampler;
uniform sampler2D reflectionSampler;

uniform vec3 cameraPosition;
uniform vec4 waterColor;
uniform float colorBlendFactor;
uniform vec4 waterColor2;
uniform float colorBlendFactor2;
uniform float bumpHeight;
uniform float time;
uniform float waveLength;

uniform float shadowDarkness;
uniform float reflectionEdgeFade;
uniform float reflectionEdgeFadeY;
uniform float reflectionBumpMultiplier;
uniform float directLightContribution;
uniform float directLightScale;
uniform float directLightFalloffPower;
uniform float shadowCombinePower;
uniform float localLightRangeMax;
uniform float normalStrength;
uniform float enableFallbackTonemapping;
uniform float baseWaterIntensity;
uniform float specularIntensity;
uniform float specularF0;
uniform float lightingNormalStrength;
uniform float turbidityDensity;
uniform float enableSparkle;
uniform float sparkleThreshold;
uniform float sparkleSoftness;
uniform float sparkleIntensity;
uniform float sparklePower;
uniform float sparkleSpecularScale;
uniform float sparkleDirectionalBoost;
uniform float sparkleMinFresnel;
uniform float sparkleNoiseScale;
uniform float sparkleNoiseSpeed;
uniform float sparkleNoiseThreshold;
uniform float sparkleNoiseAmount;
uniform float sparkleNoiseSoftness;
uniform float sparkleLumaScale;
uniform float sparkleAAStrength;
uniform float sparkleNoiseDetail;
uniform float sparkleWaveLengthRef;
uniform float sparkleWaveLengthAAMax;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float enableSunGlint;
uniform float sunGlintIntensity;
uniform float sunGlintPower;
uniform float sunGlintDiskSize;
uniform float sunGlintFresnelPower;
uniform float sunGlintThreshold;
uniform float sunGlintSoftness;
uniform float sunGlintNoiseScale;
uniform float sunGlintNoiseSpeed;
uniform float sunGlintNoiseThreshold;
uniform float sunGlintNoiseAmount;
uniform float normalLayer2Weight;
uniform float normalLayer3Weight;

varying vec3 vRefractionMapTexCoord;
varying vec3 vReflectionMapTexCoord;

#include<clipPlaneFragmentDeclaration>
#include<logDepthDeclaration>
#include<fogFragmentDeclaration>

#if defined(CLUSTLIGHT_BATCH) && CLUSTLIGHT_BATCH>0
varying float vViewDepth;
#endif

#define CUSTOM_FRAGMENT_DEFINITIONS
void main(void) {
#define CUSTOM_FRAGMENT_MAIN_BEGIN

#include<clipPlaneFragment>

vec3 viewDirectionW = normalize(vEyePosition.xyz - vPositionW);

vec4 baseColor = vec4(1.,1.,1.,1.);
float alpha = vDiffuseColor.a;

#ifdef BUMP
  #ifdef BUMPSUPERIMPOSE
    // 多层法线混合（使用同一张 normal 贴图，多次采样不同滚动 UV）
    float w2 = clamp(normalLayer2Weight, 0.0, 1.0);
    float w3 = clamp(normalLayer3Weight, 0.0, 1.0);
    float w1 = max(1.0 - w2 - w3, 0.0);
    vec4 n1 = texture2D(normalSampler, vNormalUV);
    vec4 n2 = texture2D(normalSampler, vNormalUV2);
    vec4 n3 = vec4(0.0);
    #ifdef NORMAL_LAYER3
      n3 = texture2D(normalSampler, vNormalUV3);
    #endif
    baseColor = n1 * w1 + n2 * w2 + n3 * w3;
  #else
    baseColor = texture2D(normalSampler, vNormalUV);
  #endif
  #ifdef ALPHATEST
    if (baseColor.a < 0.4) discard;
  #endif
  baseColor.rgb *= vNormalInfos.y;
#endif

#ifdef NORMAL
  // 让 lighting 与 UV 扰动都吃到法线波浪：不管是否启用 BUMPAFFECTSREFLECTION，都用 normal map 对 world normal 做扰动。
  // （water 的 normalSampler 常用 rg 编码偏移，这里用它来扰动 XZ 平面）
  vec2 perturbationUV = bumpHeight * normalStrength * (baseColor.rg - 0.5);
  vec2 perturbationN = bumpHeight * lightingNormalStrength * (baseColor.rg - 0.5);
  vec3 normalW = normalize(vNormalW + vec3(perturbationN.x * 8.0, 0.0, perturbationN.y * 8.0));
  if (normalW.y < 0.0) normalW.y = -normalW.y;
#else
vec3 normalW = vec3(1.0,1.0,1.0);
vec2 perturbationUV = bumpHeight * normalStrength * (vec2(1.0,1.0) - 0.5);
#endif

vec3 refractionContribution = vec3(0.0);
vec3 reflectionContribution = vec3(0.0);

#ifdef REFLECTION
  #ifdef FRESNELSEPARATE
    vec2 projectedRefractionTexCoords = clamp(
      vRefractionMapTexCoord.xy / vRefractionMapTexCoord.z + (perturbationUV * reflectionBumpMultiplier) * 0.5,
      0.0,
      1.0
    );
    vec4 refractiveColor = texture2D(refractionSampler, projectedRefractionTexCoords);
    #ifdef IS_REFRACTION_LINEAR
      refractiveColor.rgb = toGammaSpace(refractiveColor.rgb);
    #endif

    // 浑浊度：近似把“水底/折射画面”按视线穿过水体的路径长度做指数衰减，并趋向 waterColor
    // 没有真实水深信息时，用视角来估计水中光程：角度越平（掠射）路径越长 -> 更浑浊。
    float _NoVt = clamp(dot(viewDirectionW, vec3(0.0, 1.0, 0.0)), 0.05, 1.0);
    float _thickness = 1.0 / _NoVt;
    float _transmittance = exp(-max(turbidityDensity, 0.0) * _thickness);
    refractiveColor.rgb = mix(waterColor.rgb, refractiveColor.rgb, _transmittance);

    vec2 projectedReflectionTexCoords = vec2(
      vReflectionMapTexCoord.x / vReflectionMapTexCoord.z + (perturbationUV.x * reflectionBumpMultiplier) * 0.3,
      vReflectionMapTexCoord.y / vReflectionMapTexCoord.z + (perturbationUV.y * reflectionBumpMultiplier)
    );
    // 原版 WaterMaterial 的 reflection RTT wrapU/V = MIRROR，若 UV 超出 [0,1] 会产生“倒立/翻折”的采样伪影。
    // 这里对 reflection UV 做边缘渐隐 + clamp，避免屏幕下半部分出现不该出现的倒影条带。
    float edgeX = reflectionEdgeFade;
    float edgeY = reflectionEdgeFadeY;
    float maskX = smoothstep(0.0, edgeX, projectedReflectionTexCoords.x) * (1.0 - smoothstep(1.0 - edgeX, 1.0, projectedReflectionTexCoords.x));
    float maskY = smoothstep(0.0, edgeY, projectedReflectionTexCoords.y) * (1.0 - smoothstep(1.0 - edgeY, 1.0, projectedReflectionTexCoords.y));
    float reflectionMask = maskX * maskY;
    projectedReflectionTexCoords = clamp(projectedReflectionTexCoords, 0.0, 1.0);
    vec4 reflectiveColor = texture2D(reflectionSampler, projectedReflectionTexCoords);
    #ifdef IS_REFLECTION_LINEAR
      reflectiveColor.rgb = toGammaSpace(reflectiveColor.rgb);
    #endif

    vec3 upVector = vec3(0.0, 1.0, 0.0);
    float fresnelTerm = clamp(abs(pow(dot(viewDirectionW, upVector), 3.0)), 0.05, 0.65);
    float IfresnelTerm = 1.0 - fresnelTerm;

    refractiveColor = colorBlendFactor * waterColor + (1.0 - colorBlendFactor) * refractiveColor;
    reflectiveColor = IfresnelTerm * colorBlendFactor2 * waterColor + (1.0 - colorBlendFactor2 * IfresnelTerm) * reflectiveColor;

    // 当 reflection UV 越界时，不“乘黑”，而是把反射逐渐退化为折射，避免出现大黑边/黑条。
    reflectiveColor.rgb = mix(refractiveColor.rgb, reflectiveColor.rgb, reflectionMask);
    refractionContribution = refractiveColor.rgb * fresnelTerm;
    reflectionContribution = reflectiveColor.rgb * IfresnelTerm;
  #else
    vec2 projectedRefractionTexCoords = clamp(
      vRefractionMapTexCoord.xy / vRefractionMapTexCoord.z + (perturbationUV * reflectionBumpMultiplier),
      0.0,
      1.0
    );
    vec4 refractiveColor = texture2D(refractionSampler, projectedRefractionTexCoords);
    #ifdef IS_REFRACTION_LINEAR
      refractiveColor.rgb = toGammaSpace(refractiveColor.rgb);
    #endif

    float _NoVt2 = clamp(dot(viewDirectionW, vec3(0.0, 1.0, 0.0)), 0.05, 1.0);
    float _thickness2 = 1.0 / _NoVt2;
    float _transmittance2 = exp(-max(turbidityDensity, 0.0) * _thickness2);
    refractiveColor.rgb = mix(waterColor.rgb, refractiveColor.rgb, _transmittance2);

    vec2 projectedReflectionTexCoords =
      vReflectionMapTexCoord.xy / vReflectionMapTexCoord.z + (perturbationUV * reflectionBumpMultiplier);
    float edgeX = reflectionEdgeFade;
    float edgeY = reflectionEdgeFadeY;
    float maskX = smoothstep(0.0, edgeX, projectedReflectionTexCoords.x) * (1.0 - smoothstep(1.0 - edgeX, 1.0, projectedReflectionTexCoords.x));
    float maskY = smoothstep(0.0, edgeY, projectedReflectionTexCoords.y) * (1.0 - smoothstep(1.0 - edgeY, 1.0, projectedReflectionTexCoords.y));
    float reflectionMask = maskX * maskY;
    projectedReflectionTexCoords = clamp(projectedReflectionTexCoords, 0.0, 1.0);
    vec4 reflectiveColor = texture2D(reflectionSampler, projectedReflectionTexCoords);
    #ifdef IS_REFLECTION_LINEAR
      reflectiveColor.rgb = toGammaSpace(reflectiveColor.rgb);
    #endif

    vec3 upVector = vec3(0.0, 1.0, 0.0);
    float fresnelTerm = max(dot(viewDirectionW, upVector), 0.0);

    reflectiveColor.rgb = mix(refractiveColor.rgb, reflectiveColor.rgb, reflectionMask);

    refractionContribution =
      colorBlendFactor * waterColor.rgb +
      (1.0 - colorBlendFactor) * (refractiveColor.rgb * fresnelTerm);

    reflectionContribution =
      (1.0 - colorBlendFactor) * (reflectiveColor.rgb * (1.0 - fresnelTerm));
  #endif
#else
  refractionContribution = clamp(vDiffuseColor.rgb, 0.0, 1.0);
#endif

// 由 lightFragment 计算灯光衰减(diffuseBase/specularBase) + 统计 shadow（只统计真正启用 shadow 的灯光）
vec3 diffuseBase = vec3(0.,0.,0.);
lightingInfo info;
// 这些变量是 Babylon 的 <lightFragment> include 可能会读写的“约定字段”：
// 即使本材质不直接使用全局平均 shadow，也保留它们以确保 include 在不同 Babylon 版本下都能编译通过。
float shadow = 1.;
float aggShadow = 0.;
float numLights = 0.;
float globalShadow = 0.;
float shadowLightCount = 0.;

#ifdef SPECULARTERM
float glossiness = vSpecularColor.a;
vec3 specularBase = vec3(0.,0.,0.);
vec3 specularColor = vSpecularColor.rgb;
#else
float glossiness = 0.;
#endif

// 光照：diffuseBase/specularBase 会按 Babylon 标准流程计算：
// - 方向/点/聚光的 N·L、衰减、强度
// - 阴影仅作用于“该灯光自己的贡献”（不会把点光阴影扩散到无限远）
#include<lightFragment>[0..maxSimultaneousLights]

// 水面“底色”主要来自 RTT（折射/反射）。为了让灯光类型与强度真正参与结果：
// - 点光/聚光会形成随距离衰减的亮区（diffuseBase）
// - 高光(光点)来自 specularBase（需要 SPECULARTERM）
// - 阴影只会遮挡该灯光自己的 diffuse/specular，不会把点光阴影扩散到无限远
// 注意：这里不要提前 clamp 到 [0,1]，否则强光下会直接“压成纯白”，丢失 RTT 里的反射/折射/法线细节。
// 让颜色先保持 HDR，再交给（Babylon 的）ImageProcessing / Tonemapping 或我们下面的 fallback tonemap 去压缩高光。
vec3 albedo = refractionContribution * vDiffuseColor.rgb * max(baseWaterIntensity, 0.0);
vec3 baseRTT = albedo + reflectionContribution;
// additive 很容易在强光下把 RTT 细节“冲成纯白”，这里改为以 RTT 为基底的乘性增亮以保留反射/折射/波浪细节
vec3 finalDiffuse = baseRTT * (1.0 + diffuseBase * max(directLightContribution, 0.0));

#if defined(VERTEXALPHA) || defined(INSTANCESCOLOR) && defined(INSTANCES)
alpha *= vColor.a;
#endif

#ifdef SPECULARTERM
// 用 Schlick Fresnel 降低“塑料感”：正视角高光更弱、掠射角更强，更像水面
float NoV = clamp(dot(normalW, viewDirectionW), 0.0, 1.0);
float fresnel = specularF0 + (1.0 - specularF0) * pow(1.0 - NoV, 5.0);
vec3 baseSpecularNoFresnel = (specularBase * specularColor) * max(specularIntensity, 0.0);
vec3 baseSpecular = baseSpecularNoFresnel * fresnel;

// 用 waveLength 自适应抗锯齿的缩放因子（会被 sparkle 与 sunGlint 共同使用）
float wlRef = max(sparkleWaveLengthRef, 1e-3);
float wlFactor = clamp(waveLength / wlRef, 0.5, max(sparkleWaveLengthAAMax, 0.5));

// 额外“波光/闪光”：仅当高光足够亮时才出现，避免半亮高光造成塑料感
// - 先用亮度(luma)做门限（smoothstep + 幂）得到 mask
// - 再把 baseSpecular 按 mask 进行放大叠加
float sparkleMask = 0.0;
if (enableSparkle > 0.5) {
  // 用“未乘 Fresnel 的高光能量”做阈值判断，避免正视角下 Fresnel 过小导致点光波光直接看不见。
  // 同时：波光能量使用 sparkleSpecularScale 独立放大，避免为去塑料感降低 specularIntensity 后波光也变淡。
  float _dirBoost = 1.0;
  #if defined(DIRLIGHT0) || defined(DIRLIGHT1) || defined(DIRLIGHT2) || defined(DIRLIGHT3)
    _dirBoost = max(sparkleDirectionalBoost, 1.0);
  #endif
  vec3 sparkleSource = (specularBase * specularColor) * max(sparkleSpecularScale, 0.0) * _dirBoost;
  float lumaRaw = dot(sparkleSource, vec3(0.2126, 0.7152, 0.0722));
  // 把能量映射到 0..1（HDR 兼容），让远距离/高空光源的高光也能稳定触发阈值
  float lumaS = 1.0 - exp(-max(sparkleLumaScale, 0.0) * lumaRaw);
  float t0 = clamp(sparkleThreshold, 0.0, 1.0);
  // 用 fwidth 做阈值抗锯齿：减少高亮处“像素点/闪烁”
  float aaL = max(sparkleSoftness, 1e-4);
  #ifdef GL_OES_standard_derivatives
    aaL = max(aaL, fwidth(lumaS) * max(sparkleAAStrength, 0.0) * wlFactor);
  #else
    // WebGL2/WebGPU 一般都有导数；没有的话就退化成 softness
    // fwidth 在 glslang/webgpu 中可用，不需要 extension
    aaL = max(aaL, fwidth(lumaS) * max(sparkleAAStrength, 0.0) * wlFactor);
  #endif
  sparkleMask = smoothstep(t0 - aaL, t0 + aaL, lumaS);
  sparkleMask = pow(sparkleMask, max(sparklePower, 1.0));

  // 若存在方向光：对波光做“碎化”，让日光波光更像许多小闪点
  #if defined(DIRLIGHT0) || defined(DIRLIGHT1) || defined(DIRLIGHT2) || defined(DIRLIGHT3)
    // 平滑 value-noise + 第二层高频细节：进一步打散“像素格/棋盘格”观感
    // 用波浪扰动参与 noise 坐标，让 pattern 随波浪“漂移”，更像 three.js 的水面法线效果
    vec2 p = vPositionW.xz * sparkleNoiseScale + vec2(time * sparkleNoiseSpeed) + perturbationUV * 20.0;
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float n1 = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);

    vec2 p2 = p * 2.07 + vec2(19.1, 7.7);
    vec2 i2 = floor(p2);
    vec2 f2 = fract(p2);
    f2 = f2 * f2 * (3.0 - 2.0 * f2);
    float a2 = fract(sin(dot(i2, vec2(127.1, 311.7))) * 43758.5453);
    float b2 = fract(sin(dot(i2 + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c2 = fract(sin(dot(i2 + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d2 = fract(sin(dot(i2 + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float n2 = mix(mix(a2, b2, f2.x), mix(c2, d2, f2.x), f2.y);

    float nd = clamp(sparkleNoiseDetail, 0.0, 1.0);
    float n = mix(n1, n2, nd);
    float nt = clamp(sparkleNoiseThreshold, 0.0, 1.0);
    float ns = max(sparkleNoiseSoftness, 1e-4);
    float aaN = ns;
    #ifdef GL_OES_standard_derivatives
      aaN = max(aaN, fwidth(n) * max(sparkleAAStrength, 0.0) * wlFactor);
    #else
      aaN = max(aaN, fwidth(n) * max(sparkleAAStrength, 0.0) * wlFactor);
    #endif
    float speck = smoothstep(nt - aaN, nt + aaN, n);
    sparkleMask *= mix(1.0, speck, clamp(sparkleNoiseAmount, 0.0, 1.0));
  #endif
}
float sparkleF = max(fresnel, max(sparkleMinFresnel, 0.0));
// 最终波光：仍然受 Fresnel（并带正视角兜底 sparkleMinFresnel）控制，不会变成金属“全反”
float _sparkleDirBoost = 1.0;
#if defined(DIRLIGHT0) || defined(DIRLIGHT1) || defined(DIRLIGHT2) || defined(DIRLIGHT3)
  _sparkleDirBoost = max(sparkleDirectionalBoost, 1.0);
#endif
vec3 sparkle =
  (specularBase * specularColor) *
  max(sparkleSpecularScale, 0.0) *
  sparkleF *
  sparkleMask *
  max(sparkleIntensity, 0.0) *
  _sparkleDirBoost;

// ------------------------------------------------------------
// 太阳独立波光（不依赖 Babylon Light 的 specularBase 形状）
// 核心：反射向量 R 与太阳方向的一致性（R·L），再用 Fresnel 与噪声做调制
// 目标：背对/侧对太阳时也能出现更多“细碎闪点”，而不是只有一个圆盘
// ------------------------------------------------------------
vec3 sunGlint = vec3(0.0);
if (enableSunGlint > 0.5) {
  vec3 sunDirW = normalize(sunDirection);
  vec3 reflectDir = reflect(-viewDirectionW, normalW);
  float RdotL = clamp(dot(reflectDir, sunDirW), 0.0, 1.0);

  // “圆盘大小”：通过调整指数来改变亮斑半径
  float disk = clamp(sunGlintDiskSize, 0.25, 4.0);
  float sunExp = max(1.0, sunGlintPower / disk);
  float g = pow(RdotL, sunExp);

  // Fresnel：更接近 three.js 水面观感（掠射更强）
  float fresG = pow(1.0 - NoV, max(sunGlintFresnelPower, 0.0));
  g *= fresG;

  // 噪声稀疏化（用平滑 value-noise，避免格子）
  vec2 p = vPositionW.xz * sunGlintNoiseScale + vec2(time * sunGlintNoiseSpeed) + perturbationUV * 20.0;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float n = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);

  float nt = clamp(sunGlintNoiseThreshold, 0.0, 1.0);
  float aaN = max(sunGlintSoftness, 1e-4);
  aaN = max(aaN, fwidth(n) * max(sparkleAAStrength, 0.0) * wlFactor);
  float speck = smoothstep(nt - aaN, nt + aaN, n);
  g *= mix(1.0, speck, clamp(sunGlintNoiseAmount, 0.0, 1.0));

  // 最终阈值：只在足够亮时才显示，避免半亮塑料感
  float gt = clamp(sunGlintThreshold, 0.0, 1.0);
  float aaG = max(sunGlintSoftness, 1e-4);
  aaG = max(aaG, fwidth(g) * max(sparkleAAStrength, 0.0) * wlFactor);
  float mask = smoothstep(gt - aaG, gt + aaG, g);
  sunGlint = sunColor * (mask * max(sunGlintIntensity, 0.0));
}

vec3 finalSpecular = baseSpecular + sparkle + sunGlint;
#else
vec3 finalSpecular = vec3(0.0);
#endif

vec4 color = vec4(finalDiffuse + finalSpecular, alpha);

#include<logDepthFragment>
#include<fogFragment>

#ifdef IMAGEPROCESSINGPOSTPROCESS
  // image processing postprocess 下，shader 这里通常只需要输出 linear
  color.rgb = toLinearSpace(color.rgb);
  // 若场景没开 Tonemapping，强光会把 0..1 LDR 帧缓冲夹成纯白 -> 细节丢失；这里做一个温和的 HDR 压缩作为兜底
  #if !defined(TONEMAPPING) || (TONEMAPPING==0)
    color.rgb = color.rgb / (1.0 + color.rgb); // Reinhard
  #endif
#elif defined(IMAGEPROCESSING)
  color.rgb = toLinearSpace(color.rgb);
  #if !defined(TONEMAPPING) || (TONEMAPPING==0)
    color.rgb = color.rgb / (1.0 + color.rgb); // Reinhard
  #endif
  color = applyImageProcessing(color);
#else
  // 没有 image processing 的情况下，强光可能被 LDR 帧缓冲夹白。
  // 用开关控制一个轻量 tonemap 兜底，优先保证 RTT(反射/折射/波浪)细节不被“冲没”。
  if (enableFallbackTonemapping > 0.5) {
    color.rgb = color.rgb / (1.0 + color.rgb); // Reinhard
  }
#endif

gl_FragColor = color;
#define CUSTOM_FRAGMENT_MAIN_END
}`;

// 与 engine.createEffect("shadowWater") 对应：
if (!ShaderStore.ShadersStore.shadowWaterVertexShader) {
  ShaderStore.ShadersStore.shadowWaterVertexShader = shadowWaterVertexShader;
}
if (!ShaderStore.ShadersStore.shadowWaterPixelShader) {
  ShaderStore.ShadersStore.shadowWaterPixelShader = shadowWaterPixelShader;
}
