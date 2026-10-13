/**
 * MultiStarSkyMaterial (Babylon.js 9.1.0 / ES6)
 * - 继承自 SkyMaterial
 * - 支持多星（多太阳）参与同一套大气散射：通过 sunPositions[] push Vector3
 * - 强制 useSunPosition = true，不使用 azimuth / inclination
 * - 支持 absorptionColor（Color3）：对每个太阳的透射率 Fex 额外乘一个吸收项，用于“毒气变色”效果
 *
 * 用法示例：
 *   import { MultiStarSkyMaterial } from "./MultiStarSkyMaterial.js";
 *   const mat = new MultiStarSkyMaterial("sky", scene, { maxSuns: 4 });
 *   mat.sunPositions.push(new Vector3(0, 100, 0));
 *   mat.sunPositions.push(new Vector3(200, 120, -50));
 *   mat.absorptionColor = new Color3(0.1, 0.05, 0.5); // 吸收蓝光 -> 偏黄
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, TmpVectors, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { EffectFallbacks } from "@babylonjs/core/Materials/effectFallbacks";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { AddClipPlaneUniforms, BindClipPlane } from "@babylonjs/core/Materials/clipPlaneMaterialHelper";
import {
  BindFogParameters,
  BindLogDepth,
  PrepareDefinesForAttributes,
  PrepareDefinesForMisc,
} from "@babylonjs/core/Materials/materialHelper.functions";
import { Scene } from "@babylonjs/core/scene";

import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";

class MultiStarSkyMaterialDefines extends MaterialDefines {
  CLIPPLANE = false;
  CLIPPLANE2 = false;
  CLIPPLANE3 = false;
  CLIPPLANE4 = false;
  CLIPPLANE5 = false;
  CLIPPLANE6 = false;
  POINTSIZE = false;
  FOG = false;
  VERTEXCOLOR = false;
  VERTEXALPHA = false;
  IMAGEPROCESSINGPOSTPROCESS = false;
  SKIPFINALCOLORCLAMP = false;
  DITHER = false;
  LOGARITHMICDEPTH = false;

  // 数值 define：会输出为 "#define MAX_SUNS 4"
  MAX_SUNS = 4;

  constructor() {
    super();
    this.rebuild();
  }
}

/**
 * 多星系统大气散射材质
 */
export class MultiStarSkyMaterial extends SkyMaterial {
  /**
   * 你期望的列表：直接 push Vector3 即可
   * @type {Vector3[]}
   */
  sunPositions = [];

  /**
   * 可选：每个太阳颜色（不填默认白色）
   * @type {Color3[]}
   */
  sunColors = [];

  /**
   * 可选：每个太阳强度（不填默认 1）
   * @type {number[]}
   */
  sunIntensities = [];

  /**
   * 吸收颜色（每通道 0~1）：数值越大代表该通道吸收越强（剩下的光越少）
   * - 黄色毒气（吸收蓝光）：new Color3(0.1, 0.05, 0.5)
   * - 绿色毒气（吸收红+蓝）：new Color3(0.8, 0.1, 0.8)
   * @type {Color3}
   */
  absorptionColor = new Color3(0, 0, 0);

  /**
   * @param {string} name
   * @param {import("@babylonjs/core/scene").Scene} scene
   * @param {{ maxSuns?: number }} [options]
   */
  constructor(name, scene, options = {}) {
    super(name, scene);

    this.maxSuns = Math.max(1, options.maxSuns ?? 4);

    // 强制只走 sunPosition / sunPositions 路线，不走 azimuth/inclination
    this.useSunPosition = true;

    MultiStarSkyMaterial._ensureShadersRegistered();
  }

  /** @private */
  static _ensureShadersRegistered() {
    if (MultiStarSkyMaterial._shadersReady) return;

    // 顶点 shader：复用 sky.vertex.fx
    ShaderStore.ShadersStore["multiSkyVertexShader"] = `
precision highp float;
// Attributes
attribute vec3 position;
#ifdef VERTEXCOLOR
attribute vec4 color;
#endif
// Uniforms
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
#ifdef POINTSIZE
uniform float pointSize;
#endif
// Output
varying vec3 vPositionW;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif
#include<logDepthDeclaration>
#include<clipPlaneVertexDeclaration>
#include<fogVertexDeclaration>
#define CUSTOM_VERTEX_DEFINITIONS
void main(void) {
#define CUSTOM_VERTEX_MAIN_BEGIN
  gl_Position = viewProjection * world * vec4(position, 1.0);
  vec4 worldPos = world * vec4(position, 1.0);
  vPositionW = vec3(worldPos);
  // Clip plane
#include<clipPlaneVertex>
#include<logDepthVertex>
  // Fog
#include<fogVertex>
  // Vertex color
#ifdef VERTEXCOLOR
  vColor = color;
#endif
  // Point size
#if defined(POINTSIZE) && !defined(WEBGPU)
  gl_PointSize = pointSize;
#endif
#define CUSTOM_VERTEX_MAIN_END
}
`;

    // 片元 shader：基于 sky.fragment.fx 改造为多太阳累加，并加入 absorptionColor
    ShaderStore.ShadersStore["multiSkyPixelShader"] = `
precision highp float;
// Input
varying vec3 vPositionW;
#ifdef VERTEXCOLOR
varying vec4 vColor;
#endif
#include<clipPlaneFragmentDeclaration>

// Sky
uniform vec3 cameraPosition;
uniform vec3 cameraOffset;
uniform vec3 up;
uniform float luminance;
uniform float turbidity;
uniform float rayleigh;
uniform float mieCoefficient;
uniform float mieDirectionalG;

// 兼容保留：单 sunPosition（不依赖也没问题）
uniform vec3 sunPosition;

// 多太阳
#ifndef MAX_SUNS
  #define MAX_SUNS 4
#endif
uniform int sunCount;
uniform vec3 sunPositions[MAX_SUNS];
uniform vec3 sunColors[MAX_SUNS];
uniform float sunIntensities[MAX_SUNS];

// 吸收项（毒气变色）
uniform vec3 absorptionColor;

#ifdef LOGARITHMICDEPTH
#extension GL_EXT_frag_depth : enable
#endif
#include<logDepthDeclaration>

// Fog
#include<fogFragmentDeclaration>

// Constants
const float pi = 3.141592653589793238462643383279502884197169;
const float N = 2.545E25;
const float pn = 0.035;
const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
const vec3 K = vec3(0.686, 0.678, 0.666);
const float v = 4.0;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float EE = 1000.0;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
const float cutoffAngle = pi/1.95;
const float steepness = 1.5;

vec3 simplifiedRayleigh() {
  return 0.0005 / vec3(94, 40, 18);
}

float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0*pi)) * (1.0 + pow(cosTheta, 2.0));
}

vec3 totalMie(vec3 lambda, vec3 K, float T) {
  float c = (0.2 * T ) * 10E-18;
  return 0.434 * c * pi * pow((2.0 * pi) / lambda, vec3(v - 2.0)) * K;
}

float hgPhase(float cosTheta, float g) {
  return (1.0 / (4.0*pi)) * ((1.0 - pow(g, 2.0)) / pow(1.0 - 2.0*g*cosTheta + pow(g, 2.0), 1.5));
}

float sunIntensity(float zenithAngleCos) {
  return EE * max(0.0, 1.0 - exp((-(cutoffAngle - acos(zenithAngleCos))/steepness)));
}

float A = 0.15;
float B = 0.50;
float C = 0.10;
float D = 0.20;
float EEE = 0.02;
float F = 0.30;
float W = 1000.0;
vec3 Uncharted2Tonemap(vec3 x) {
  return ((x*(A*x+C*B)+D*EEE)/(x*(A*x+B)+D*F))-EEE/F;
}

#if DITHER
#include<helperFunctions>
#endif

#define CUSTOM_FRAGMENT_DEFINITIONS
void main(void) {
#define CUSTOM_FRAGMENT_MAIN_BEGIN
  // Clip plane
#include<clipPlaneFragment>

  // 视线方向/天顶角相关：对所有太阳共享
  vec3 viewDir = normalize(vPositionW - cameraPosition);
  float zenithAngle = acos(max(0.0, dot(up, normalize(vPositionW - cameraPosition + cameraOffset))));
  float sR = rayleighZenithLength / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sM = mieZenithLength / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));

  vec3 betaM = totalMie(lambda, K, turbidity) * mieCoefficient;

  // 吸收项：absorptionColor 越大，透过越少
  vec3 absorption = clamp(vec3(1.0) - absorptionColor, 0.0, 1.0);

  vec3 LinSum = vec3(0.0);
  vec3 L0Sum  = vec3(0.0);

  for (int i = 0; i < MAX_SUNS; i++) {
    if (i >= sunCount) { break; }

    vec3 sp = sunPositions[i];
    vec3 sc = sunColors[i];
    float si = sunIntensities[i];

    vec3 sunDir = normalize(sp);

    // 原版 sky.shader 用 sunPosition.y 做日落衰减，这里按每个太阳分别计算
    float sunfade = 1.0 - clamp(1.0 - exp((sp.y / 450000.0)), 0.0, 1.0);
    float rayleighCoefficient = rayleigh - (1.0 * (1.0 - sunfade));
    vec3 betaR = simplifiedRayleigh() * rayleighCoefficient;

    // 透射率：大气散射 + 颜色吸收
    vec3 Fex = exp(-(betaR * sR + betaM * sM));
    Fex *= absorption;

    float cosTheta = dot(viewDir, sunDir);
    float sunE = sunIntensity(dot(sunDir, up)) * si;

    float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaRTheta = betaR * rPhase;

    float mPhase = hgPhase(cosTheta, mieDirectionalG);
    vec3 betaMTheta = betaM * mPhase;

    vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(
      vec3(1.0),
      pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(1.0 / 2.0)),
      clamp(pow(1.0 - dot(up, sunDir), 5.0), 0.0, 1.0)
    );

    vec3 L0 = vec3(0.1) * Fex;
    float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
    L0 += (sunE * 19000.0 * Fex) * sundisk;

    LinSum += Lin * sc;
    L0Sum  += L0  * sc;
  }

  vec3 whiteScale = 1.0 / Uncharted2Tonemap(vec3(W));
  vec3 texColor = (LinSum + L0Sum);

  texColor *= 0.04;
  texColor += vec3(0.0, 0.001, 0.0025) * 0.3;

  vec3 curr = Uncharted2Tonemap((log2(2.0 / pow(luminance, 4.0))) * texColor);
  vec3 retColor = curr * whiteScale;

  // Alpha
  float alpha = 1.0;
#ifdef VERTEXCOLOR
  retColor.rgb *= vColor.rgb;
#endif
#if defined(VERTEXALPHA) || defined(INSTANCESCOLOR) && defined(INSTANCES)
  alpha *= vColor.a;
#endif
#if DITHER
  retColor.rgb += dither(gl_FragCoord.xy, 0.5);
#endif

  vec4 color = clamp(vec4(retColor.rgb, alpha), 0.0, 1.0);

#include<logDepthFragment>
  // Fog
#include<fogFragment>
  gl_FragColor = color;
#include<imageProcessingCompatibility>
#define CUSTOM_FRAGMENT_MAIN_END
}
`;

    MultiStarSkyMaterial._shadersReady = true;
  }

  /** @override */
  isReadyForSubMesh(mesh, subMesh) {
    const drawWrapper = subMesh._drawWrapper;
    if (this.isFrozen) {
      if (drawWrapper.effect && drawWrapper._wasPreviouslyReady) {
        return true;
      }
    }

    if (!subMesh.materialDefines) {
      subMesh.materialDefines = new MultiStarSkyMaterialDefines();
    }

    const defines = /** @type {MultiStarSkyMaterialDefines} */ (subMesh.materialDefines);
    const scene = this.getScene();

    if (this._isReadyForSubMesh(subMesh)) {
      return true;
    }

    // 同步 MAX_SUNS define
    if (defines.MAX_SUNS !== this.maxSuns) {
      defines.MAX_SUNS = this.maxSuns;
      defines.markAsMiscDirty();
    }

    PrepareDefinesForMisc(
      mesh,
      scene,
      this._useLogarithmicDepth,
      this.pointsCloud,
      this.fogEnabled,
      false,
      defines,
      undefined,
      undefined,
      undefined,
      this._isVertexOutputInvariant
    );

    PrepareDefinesForAttributes(mesh, defines, true, false);

    if (defines.IMAGEPROCESSINGPOSTPROCESS !== scene.imageProcessingConfiguration.applyByPostProcess) {
      defines.markAsMiscDirty();
    }
    if (defines.DITHER !== this.dithering) {
      defines.markAsMiscDirty();
    }

    if (defines.isDirty) {
      defines.markAsProcessed();
      scene.resetCachedMaterial();

      const fallbacks = new EffectFallbacks();
      if (defines.FOG) {
        fallbacks.addFallback(1, "FOG");
      }

      defines.IMAGEPROCESSINGPOSTPROCESS = scene.imageProcessingConfiguration.applyByPostProcess;
      defines.DITHER = this.dithering;

      const attribs = [VertexBuffer.PositionKind];
      if (defines.VERTEXCOLOR) {
        attribs.push(VertexBuffer.ColorKind);
      }

      const uniforms = [
        "world",
        "viewProjection",
        "view",
        "vFogInfos",
        "vFogColor",
        "logarithmicDepthConstant",
        "pointSize",

        "luminance",
        "turbidity",
        "rayleigh",
        "mieCoefficient",
        "mieDirectionalG",

        // 兼容保留
        "sunPosition",

        // 多太阳
        "sunCount",
        "sunPositions",
        "sunColors",
        "sunIntensities",

        // 吸收项
        "absorptionColor",

        "cameraPosition",
        "cameraOffset",
        "up",
      ];
      AddClipPlaneUniforms(uniforms);

      const join = defines.toString();
      const effect = scene
        .getEngine()
        .createEffect("multiSky", attribs, uniforms, [], join, fallbacks, this.onCompiled, this.onError);

      subMesh.setEffect(effect, defines, this._materialContext);
    }

    if (!subMesh.effect || !subMesh.effect.isReady()) {
      return false;
    }

    defines._renderId = scene.getRenderId();
    drawWrapper._wasPreviouslyReady = true;
    return true;
  }

  /** @override */
  bindForSubMesh(world, mesh, subMesh) {
    const scene = this.getScene();
    const defines = subMesh.materialDefines;
    if (!defines) return;

    const effect = subMesh.effect;
    if (!effect) return;

    this._activeEffect = effect;

    // Matrices
    this.bindOnlyWorldMatrix(world);
    this._activeEffect.setMatrix("viewProjection", scene.getTransformMatrix());

    if (this._mustRebind(scene, effect, subMesh)) {
      BindClipPlane(effect, this, scene);

      if (this.pointsCloud) {
        this._activeEffect.setFloat("pointSize", this.pointSize);
      }
      if (this._useLogarithmicDepth) {
        BindLogDepth(defines, effect, scene);
      }
    }

    // View (fog)
    if (scene.fogEnabled && mesh.applyFog && scene.fogMode !== Scene.FOGMODE_NONE) {
      this._activeEffect.setMatrix("view", scene.getViewMatrix());
    }
    BindFogParameters(scene, mesh, this._activeEffect);

    // Camera
    const camera = scene.activeCamera;
    if (camera) {
      const m = camera.getWorldMatrix();
      this._cameraPosition.x = m.m[12];
      this._cameraPosition.y = m.m[13];
      this._cameraPosition.z = m.m[14];
      this._activeEffect.setVector3(
        "cameraPosition",
        TmpVectors.Vector3[0].copyFrom(this._cameraPosition).subtractInPlace(scene.floatingOriginOffset)
      );
    }

    // Sky params
    this._activeEffect.setVector3("cameraOffset", this.cameraOffset);
    this._activeEffect.setVector3("up", this.up);

    if (this.luminance > 0) this._activeEffect.setFloat("luminance", this.luminance);
    this._activeEffect.setFloat("turbidity", this.turbidity);
    this._activeEffect.setFloat("rayleigh", this.rayleigh);
    this._activeEffect.setFloat("mieCoefficient", this.mieCoefficient);
    this._activeEffect.setFloat("mieDirectionalG", this.mieDirectionalG);

    // 强制不走 azimuth/inclination
    this.useSunPosition = true;

    // 吸收项
    this._activeEffect.setColor3("absorptionColor", this.absorptionColor);

    // --- 多太阳 uniforms ---
    const maxSuns = this.maxSuns;
    const count = Math.min(this.sunPositions.length, maxSuns);

    // 兼容：给父类 sunPosition 填第一个太阳的位置（如果外部还有读这个字段）
    if (count > 0) {
      this.sunPosition.copyFrom(this.sunPositions[0]);
    }
    this._activeEffect.setVector3("sunPosition", this.sunPosition);

    this._activeEffect.setInt("sunCount", count);

    // 打包 vec3[] / float[] 给 shader
    // setArray3 需要 [x0,y0,z0,x1,y1,z1,...]
    if (!this._packedSunPositions || this._packedSunPositions.length !== maxSuns * 3) {
      this._packedSunPositions = new Array(maxSuns * 3).fill(0);
      this._packedSunColors = new Array(maxSuns * 3).fill(1);
      this._packedSunIntensities = new Array(maxSuns).fill(1);
    }

    for (let i = 0; i < maxSuns; i++) {
      const p = this.sunPositions[i];
      const c = this.sunColors[i];
      const inten = this.sunIntensities[i];

      const base3 = i * 3;

      if (i < count && p) {
        this._packedSunPositions[base3 + 0] = p.x;
        this._packedSunPositions[base3 + 1] = p.y;
        this._packedSunPositions[base3 + 2] = p.z;

        const col = c ?? Color3.White();
        this._packedSunColors[base3 + 0] = col.r;
        this._packedSunColors[base3 + 1] = col.g;
        this._packedSunColors[base3 + 2] = col.b;

        this._packedSunIntensities[i] = inten ?? 1.0;
      } else {
        // padding：避免 normalize(0) 造成奇怪数值
        this._packedSunPositions[base3 + 0] = 0;
        this._packedSunPositions[base3 + 1] = -1;
        this._packedSunPositions[base3 + 2] = 0;

        this._packedSunColors[base3 + 0] = 1;
        this._packedSunColors[base3 + 1] = 1;
        this._packedSunColors[base3 + 2] = 1;

        this._packedSunIntensities[i] = 0.0;
      }
    }

    this._activeEffect.setArray3("sunPositions", this._packedSunPositions);
    this._activeEffect.setArray3("sunColors", this._packedSunColors);
    this._activeEffect.setFloatArray("sunIntensities", this._packedSunIntensities);

    this._afterBind(mesh, this._activeEffect, subMesh);
  }

  /** @private */
  _packedSunPositions = null;
  /** @private */
  _packedSunColors = null;
  /** @private */
  _packedSunIntensities = null;

  /** @private */
  static _shadersReady = false;
}

