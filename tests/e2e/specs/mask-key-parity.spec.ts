/**
 * MK6.3 — the key gate from `plan/background-removal-ai/06-PRECISION-AND-EVAL.md`:
 *
 *   > Engine vs preview keyed alpha ≤ 1/255 on colour charts in BT.601/709, full/limited range.
 *
 * The preview's key is a fragment shader, so the only honest way to measure it is to run it on a
 * real GPU and read the bytes back. This spec compiles the shipped shader source in a browser,
 * uploads the colour charts `engine/python/tests/key_mask_vectors.py` generated, runs the same
 * pass chain the compositor runs (qualifier → clean levels → in/out ratio → invert/opacity →
 * quantise), and compares each byte with the engine's.
 *
 * WHY THE CHARTS ARE WHAT THEY ARE: a keyer only ever sees RGB, but the RGB it sees is what the
 * decode produced, and BT.601 vs BT.709 and full vs limited range put different numbers there
 * for the same light. Each patch was taken to Y'CbCr in that encoding, quantised to 8 bits as a
 * decoded frame is, and brought back — so these are colours that actually come out of a decoder,
 * including the ones limited range cannot represent.
 *
 * The uniforms come from the fixture rather than from the mask schema, so this harness needs no
 * workspace packages; `key-mask.test.ts` asserts that the TypeScript packer produces the same
 * numbers, which is what keeps the two descriptions of a mask in step.
 *
 * Runs in the default `chromium` project. On a machine (or CI runner) whose Chromium has no
 * WebGL2 or no float render targets, the test FAILS rather than skipping: a gate that quietly
 * disappears is not a gate. CPU GL (SwiftShader) is fine — it supports both.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  MASK_KEY_FRAGMENT,
  MASK_LEVELS_FRAGMENT,
  MASK_QUANTIZE_FRAGMENT,
} from './mask-key-shaders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CHARTS = join(REPO, 'tests', 'fixtures', 'mask-key', 'charts.json');

/** The gate, in 8-bit levels. Tightened, never loosened. */
const MAX_ALPHA_DELTA = 1;

interface KeyUniforms {
  readonly sampled: number;
  readonly rangeCount: number;
  readonly ranges: number[];
  readonly sampleCount: number;
  readonly samples: number[];
  readonly tolerance: number;
  readonly shadowRetention: number;
  readonly cleanBlack: number;
  readonly cleanWhite: number;
  readonly invert: number;
  readonly opacity: number;
  readonly inOutRatio: number;
}

interface Charts {
  readonly charts: {
    readonly matrix: string;
    readonly range: string;
    readonly colours: [number, number, number][];
  }[];
  readonly cases: {
    readonly mask: { readonly id: string };
    readonly uniforms: KeyUniforms;
    readonly expected: { readonly matrix: string; readonly range: string; readonly alpha8: number[] }[];
  }[];
}

const vectors = JSON.parse(readFileSync(CHARTS, 'utf8')) as Charts;

/** What the page returns for one (mask, chart): the keyed byte per patch, or why it could not. */
interface Measured {
  readonly alpha8?: number[];
  readonly error?: string;
}

test.describe('MK6.3 key gate: engine vs preview keyed alpha', () => {
  test('is within 1/255 on colour charts in BT.601/709, full and limited range', async ({
    page,
  }) => {
    await page.goto('about:blank');
    const colours = new Map(
      vectors.charts.map((chart) => [`${chart.matrix}/${chart.range}`, chart.colours]),
    );

    const worst: { where: string; delta: number } = { where: 'none', delta: 0 };
    const measuredPerEncoding = new Map<string, number>();
    let checked = 0;

    for (const vectorCase of vectors.cases) {
      for (const expected of vectorCase.expected) {
        const key = `${expected.matrix}/${expected.range}`;
        const patches = colours.get(key)!;
        const measured: Measured = await page.evaluate(runKeyPass, {
          shaders: {
            key: MASK_KEY_FRAGMENT,
            levels: MASK_LEVELS_FRAGMENT,
            quantize: MASK_QUANTIZE_FRAGMENT,
          },
          uniforms: vectorCase.uniforms,
          colours: patches,
        });
        expect(measured.error ?? null, `${vectorCase.mask.id} ${key}`).toBeNull();
        const alpha8 = measured.alpha8!;
        expect(alpha8.length, `${vectorCase.mask.id} ${key}`).toBe(expected.alpha8.length);
        alpha8.forEach((value, index) => {
          const delta = Math.abs(value - expected.alpha8[index]!);
          checked += 1;
          if (delta > worst.delta) {
            worst.delta = delta;
            worst.where = `${vectorCase.mask.id} ${key} patch ${String(index)} (${String(value)} vs ${String(expected.alpha8[index])})`;
          }
          measuredPerEncoding.set(key, Math.max(measuredPerEncoding.get(key) ?? 0, delta));
        });
      }
    }

    // Recorded in the run log whether it passes or not: a gate's number is the evidence.
    for (const [encoding, delta] of [...measuredPerEncoding].sort()) {
      test.info().annotations.push({ type: 'key-gate', description: `${encoding}: ≤ ${String(delta)}/255` });
    }
    expect(checked).toBe(vectors.cases.length * 4 * vectors.charts[0]!.colours.length);
    expect(
      worst.delta,
      `worst keyed-alpha difference at ${worst.where}; gate is ${String(MAX_ALPHA_DELTA)}/255`,
    ).toBeLessThanOrEqual(MAX_ALPHA_DELTA);
  });
});

/**
 * Run the compositor's key chain over a 1 × N strip of colours and read the quantised alpha.
 *
 * Declared at module scope (not inline) so it is one serialisable function: everything it needs
 * arrives in its argument, because it executes in the page, not here.
 */
function runKeyPass(input: {
  shaders: { key: string; levels: string; quantize: string };
  uniforms: KeyUniforms;
  colours: [number, number, number][];
}): Measured {
  const { shaders, uniforms, colours } = input;
  const width = colours.length;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (gl === null) return { error: 'WebGL2 is unavailable in this browser.' };
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    return { error: 'EXT_color_buffer_float is unavailable, so the key chain cannot run.' };
  }

  const VERTEX = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

  const compile = (type: number, source: string): WebGLShader | string => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      return gl.getShaderInfoLog(shader) ?? 'shader failed to compile';
    }
    return shader;
  };
  const link = (fragment: string): WebGLProgram | string => {
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    if (typeof vs === 'string') return `vertex: ${vs}`;
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    if (typeof fs === 'string') return `fragment: ${fs}`;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return gl.getProgramInfoLog(program) ?? 'program failed to link';
    }
    return program;
  };

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const target = (internal: number): { texture: WebGLTexture; framebuffer: WebGLFramebuffer } => {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer };
  };

  const draw = (
    program: WebGLProgram,
    framebuffer: WebGLFramebuffer,
    bind: (program: WebGLProgram) => void,
  ): void => {
    gl.useProgram(program);
    bind(program);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // The picture: one row of patches, exactly as the decode would hand them over.
  const picture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, picture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, 1);
  const pixels = new Uint8Array(width * 4);
  colours.forEach((colour, index) => {
    pixels[index * 4] = colour[0];
    pixels[index * 4 + 1] = colour[1];
    pixels[index * 4 + 2] = colour[2];
    pixels[index * 4 + 3] = 255;
  });
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const keyProgram = link(shaders.key);
  if (typeof keyProgram === 'string') return { error: `key ${keyProgram}` };
  const levelsProgram = link(shaders.levels);
  if (typeof levelsProgram === 'string') return { error: `levels ${levelsProgram}` };
  const quantizeProgram = link(shaders.quantize);
  if (typeof quantizeProgram === 'string') return { error: `quantize ${quantizeProgram}` };

  const qualified = target(gl.RGBA32F);
  draw(keyProgram, qualified.framebuffer, (program) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, picture);
    gl.uniform1i(gl.getUniformLocation(program, 'u_picture'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_sampled'), uniforms.sampled);
    gl.uniform1i(gl.getUniformLocation(program, 'u_rangeCount'), uniforms.rangeCount);
    gl.uniform1i(gl.getUniformLocation(program, 'u_sampleCount'), uniforms.sampleCount);
    gl.uniform4fv(gl.getUniformLocation(program, 'u_ranges'), new Float32Array(uniforms.ranges));
    gl.uniform4fv(gl.getUniformLocation(program, 'u_samples'), new Float32Array(uniforms.samples));
    gl.uniform1f(gl.getUniformLocation(program, 'u_tolerance'), uniforms.tolerance);
    gl.uniform1f(gl.getUniformLocation(program, 'u_shadow'), uniforms.shadowRetention);
  });

  /** One pointwise pass, as `keyFinesse` runs them: levels first, then the layer's tail. */
  const levelsPass = (
    source: { texture: WebGLTexture },
    stage: { levels: boolean; ratio: number; layer: boolean },
  ): { texture: WebGLTexture; framebuffer: WebGLFramebuffer } => {
    const out = target(gl.RGBA32F);
    draw(levelsProgram, out.framebuffer, (program) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_alpha'), 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_cleanBlack'), uniforms.cleanBlack);
      gl.uniform1f(gl.getUniformLocation(program, 'u_cleanWhite'), uniforms.cleanWhite);
      gl.uniform1f(gl.getUniformLocation(program, 'u_ratio'), stage.ratio);
      gl.uniform1f(gl.getUniformLocation(program, 'u_invert'), stage.layer ? uniforms.invert : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), stage.layer ? uniforms.opacity : 1);
      gl.uniform1i(gl.getUniformLocation(program, 'u_levels'), stage.levels ? 1 : 0);
    });
    return out;
  };

  let current: { texture: WebGLTexture } = qualified;
  if (uniforms.cleanBlack !== 0 || uniforms.cleanWhite !== 1) {
    current = levelsPass(current, { levels: true, ratio: 0, layer: false });
  }
  current = levelsPass(current, { levels: false, ratio: uniforms.inOutRatio, layer: true });

  const quantised = target(gl.R8UI);
  draw(quantizeProgram, quantised.framebuffer, (program) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, current.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'u_alpha'), 0);
  });

  const out = new Uint8Array(width * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, quantised.framebuffer);
  gl.readPixels(0, 0, width, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, out);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) return { error: `GL error ${String(error)} after read-back` };
  return { alpha8: Array.from({ length: width }, (_value, index) => out[index * 4]!) };
}
