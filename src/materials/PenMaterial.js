/**
 * PenMaterial - Custom ShaderMaterial for anti-aliased pen line rendering.
 *
 * Based on the pen line shader from leopard/scratch-render:
 *   - Vertex shader builds a rotated bounding quad per line from per-vertex attributes.
 *   - Fragment shader uses a distance-field technique for round-capped anti-aliased lines.
 *
 * Each line is represented by 6 vertices (2 triangles forming a quad).
 * Vertex attributes:
 *   a_corner  (vec2) - quad corner position in 0..1 range
 *   lineStart (vec2) - line start point in stage coordinates
 *   lineEnd   (vec2) - line end point in stage coordinates
 *   a_color   (vec4) - RGBA color of the line
 *   lineSize  (float)- line width in pixels
 *
 * Uniforms:
 *   u_stageBounds (vec4) - stage bounds: left, right, bottom, top
 *   u_stageSize   (vec2) - pre-computed stage dimensions: width, height
 */

import { Effect } from "@babylonjs/core/Materials/effect.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Vector2 } from "@babylonjs/core/Maths/math.vector.js";
import { Vector4 } from "@babylonjs/core/Maths/math.vector.js";

const penLineVertexShader = /* glsl */`
precision highp float;

attribute vec2 a_corner;
attribute vec2 lineStart;
attribute vec2 lineEnd;
attribute vec4 a_color;
attribute float lineSize;

uniform vec4 u_stageBounds;
uniform vec2 u_stageSize;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_lineLength;
varying float v_penSize;

const float epsilon = 1e-3;

void main() {
    vec2 pt1 = lineStart;
    vec2 pt2 = lineEnd;
    vec2 lineDiff = pt2 - pt1;
    float lineLen = length(lineDiff);
    float expandedRadius = (lineSize * 0.5) + 1.4142135623730951;

    // Ensure line has nonzero length for normalisation
    vec2 pointDiff = lineDiff;
    pointDiff.x = (abs(pointDiff.x) < epsilon && abs(pointDiff.y) < epsilon) ? epsilon : pointDiff.x;
    float safeLen = max(lineLen, epsilon);

    // texCoord: X increases along the line (pixel space), Y perpendicular
    v_texCoord.x = mix(0.0, lineLen + (expandedRadius * 2.0), a_corner.x) - expandedRadius;
    v_texCoord.y = ((a_corner.y - 0.5) * expandedRadius) + 0.5;

    // Build rotated bounding quad (same math as leopard/scratch-render PenSkin)
    vec2 pos = a_corner;
    pos.x *= lineLen + (2.0 * expandedRadius);
    pos.y *= 2.0 * expandedRadius;
    pos -= expandedRadius;

    vec2 normalized = pointDiff / safeLen;
    pos = mat2(normalized.x, normalized.y, -normalized.y, normalized.x) * pos;
    pos += pt1;

    // Map stage coordinates to clip space [-1, 1]
    vec2 stageOffset = vec2(-u_stageBounds.x, -u_stageBounds.z);
    pos = (pos + stageOffset) / u_stageSize;
    pos = pos * 2.0 - 1.0;

    gl_Position = vec4(pos, 0.5, 1.0);

    v_color = a_color;
    v_lineLength = lineLen;
    v_penSize = lineSize;
}
`;

const penLineFragmentShader = /* glsl */`
precision highp float;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_lineLength;
varying float v_penSize;

void main() {
    // Hard pixel line with round caps via distance field.
    // step() gives binary on/off instead of smooth anti-aliased edges.

    float d = ((v_texCoord.x - clamp(v_texCoord.x, 0.0, v_lineLength)) * 0.5) + 0.5;
    float line = distance(vec2(0.5), vec2(d, v_texCoord.y)) * 2.0;
    line -= ((v_penSize - 1.0) * 0.5);

    gl_FragColor = v_color * step(line, 1.0);
}
`;

Effect.ShadersStore["penLineVertexShader"] = penLineVertexShader;
Effect.ShadersStore["penLineFragmentShader"] = penLineFragmentShader;

export class PenMaterial extends ShaderMaterial {
    /**
     * @param {string} name
     * @param {import("@babylonjs/core").Scene} scene
     * @param {{ left: number, right: number, bottom: number, top: number }} stageBounds
     */
    constructor(name, scene, stageBounds) {
        super(name, scene, "penLine", {
            attributes: ["a_corner", "lineStart", "lineEnd", "a_color", "lineSize"],
            uniforms: ["u_stageBounds", "u_stageSize"],
            needAlphaBlending: true,
            needAlphaTesting: false,
        });

        this.disableLighting = true;
        this.backFaceCulling = false;
        this.forceDepthWrite = false;

        // WebGPU兼容：使用 setVector4/setVector2 而非 setArray4/setArray2
        // setArray* 路径在 WebGPU 后端会走 UniformBuffer.updateUniformArray，
        // 该调用需要从 uniform buffer layout 查找 strideSize，但
        // ShaderMaterial 在 WebGPU 下的 buffer layout 注册方式导致查找失败。
        // setVector* 路径底层走 UniformBuffer.updateFloat*，不依赖 stride 查找。
        this.setVector4(
            "u_stageBounds",
            new Vector4(
                stageBounds.left,
                stageBounds.right,
                stageBounds.bottom,
                stageBounds.top
            )
        );

        this.setVector2(
            "u_stageSize",
            new Vector2(
                stageBounds.right - stageBounds.left,
                stageBounds.top - stageBounds.bottom
            )
        );
    }
}

export default PenMaterial;
