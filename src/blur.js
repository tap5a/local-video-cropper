// WebGL two-pass separable Gaussian blur for the fit-mode background.
//
// Pipeline per frame: the caller draws the background layer into a small 2D
// staging canvas (long side ≤ 480px — this both caps kernel cost and avoids
// every texImage2D-from-video compatibility quirk), the staging canvas is
// uploaded as a texture, blurred horizontally into an FBO and vertically into
// the WebGL canvas, which the caller then drawImage()s up to output size.
//
// Values are blurred in gamma space (plain RGBA, no sRGB linearization) to
// visually match ctx.filter = 'blur()' — which is the fallback path.
//
// Sigma on the working canvas is blurPx × workLong/outLong; since blurPx is
// slider × outLong/1080 in both callers, this collapses to slider × 480/1080,
// giving a constant σ ≤ ~44.5 regardless of output resolution — so preview
// and export produce identical blur for a given slider value.

const WORK_LONG = 480;
const MAX_PAIRS = 68; // merged linear-sampling taps per side; covers radius 135
const LRU_CAP = 3;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aPos * 0.5 + 0.5;
}`;

// One program for both passes; uTexelDir selects the axis. Weights are true
// discrete Gaussians computed in-shader (no uniform-array size limits, zero
// per-frame JS allocation), normalized by the accumulated sum so truncation
// never causes brightness drift. Adjacent taps are merged into single
// bilinear fetches (standard linear-sampling optimization).
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexelDir;
uniform float uSigma;
uniform int uPairCount;
varying vec2 vUv;
const int MAX_PAIRS = ${MAX_PAIRS};
void main() {
  vec4 sum = texture2D(uTex, vUv);
  float wsum = 1.0;
  float s2 = 2.0 * uSigma * uSigma;
  for (int i = 1; i <= MAX_PAIRS; i++) {
    if (i > uPairCount) break;
    float d1 = float(2 * i - 1);
    float d2 = float(2 * i);
    float w1 = exp(-d1 * d1 / s2);
    float w2 = exp(-d2 * d2 / s2);
    float w = w1 + w2;
    float off = (d1 * w1 + d2 * w2) / w;
    sum += w * (texture2D(uTex, vUv + off * uTexelDir)
              + texture2D(uTex, vUv - off * uTexelDir));
    wsum += 2.0 * w;
  }
  gl_FragColor = vec4(sum.rgb / wsum, 1.0);
}`;

let glState = null;      // { gl, program, u: {...}, resources: Map }
let glBroken = false;    // deterministic failure (compile/link) — off for good
let initFails = 0;
let lastInitFail = 0;
let warned = false;
let pathOverride = null; // 'webgl' | 'filter' | 'scale' | null — test hook

export function setBlurPathOverride(mode) {
  pathOverride = mode;
}

export function getBlurPathOverride() {
  return pathOverride;
}

export function blurAvailable() {
  try {
    return !!ensureGl();
  } catch {
    return false;
  }
}

// debug hook for context-loss testing
export function getDebugGl() {
  return glState?.gl ?? null;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const err = new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
    err.permanent = true;
    throw err;
  }
  return sh;
}

function createGlState() {
  const canvas = new OffscreenCanvas(4, 4);
  const opts = {
    alpha: false, depth: false, stencil: false, antialias: false,
    preserveDrawingBuffer: false, powerPreference: 'low-power',
  };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) throw new Error('WebGL unavailable');

  // On loss, discard everything; the next call re-creates a fresh context
  // (with a cooldown), which doubles as the recovery path.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    disposeGlState();
  });

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const err = new Error(`link: ${gl.getProgramInfoLog(program)}`);
    err.permanent = true;
    throw err;
  }
  gl.useProgram(program);

  // fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {
    tex: gl.getUniformLocation(program, 'uTex'),
    texelDir: gl.getUniformLocation(program, 'uTexelDir'),
    sigma: gl.getUniformLocation(program, 'uSigma'),
    pairs: gl.getUniformLocation(program, 'uPairCount'),
  };
  gl.uniform1i(u.tex, 0);

  const state = { gl, program, u, resources: new Map() };

  // sanity render: blur a red 2×2 and confirm non-black pixels come out
  const probe = new OffscreenCanvas(2, 2);
  const pctx = probe.getContext('2d');
  pctx.fillStyle = '#f00';
  pctx.fillRect(0, 0, 2, 2);
  runBlur(state, probe, 2, 2, 1.0);
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (px[0] < 200) {
    const err = new Error('sanity render failed');
    err.permanent = true;
    throw err;
  }

  return state;
}

function disposeGlState() {
  glState = null; // GL objects die with the context; let GC take the canvas
}

function ensureGl() {
  if (glState) return glState;
  if (glBroken) return null;
  if (Date.now() - lastInitFail < 3000) return null; // cooldown after failure
  try {
    glState = createGlState();
    initFails = 0;
    return glState;
  } catch (err) {
    lastInitFail = Date.now();
    initFails++;
    if (err.permanent || initFails >= 3) glBroken = true;
    warnOnce(err);
    return null;
  }
}

function warnOnce(err) {
  if (!warned) {
    warned = true;
    console.warn('WebGL blur unavailable, falling back:', err);
  }
}

// per-dimensions GPU resources, LRU-capped so interleaved preview + export
// (different aspects) don't thrash reallocation
function getResources(state, workW, workH) {
  const key = `${workW}x${workH}`;
  const { gl, resources } = state;
  let res = resources.get(key);
  if (res) {
    // refresh LRU position
    resources.delete(key);
    resources.set(key, res);
    return res;
  }

  const makeTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  const staging = new OffscreenCanvas(workW, workH);
  const stagingCtx = staging.getContext('2d');
  stagingCtx.imageSmoothingEnabled = true;
  stagingCtx.imageSmoothingQuality = 'high';

  const texA = makeTex();
  const texB = makeTex();
  gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, workW, workH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texB, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  res = { staging, stagingCtx, texA, texB, fbo };
  resources.set(key, res);

  if (resources.size > LRU_CAP) {
    const [oldKey, old] = resources.entries().next().value;
    gl.deleteTexture(old.texA);
    gl.deleteTexture(old.texB);
    gl.deleteFramebuffer(old.fbo);
    resources.delete(oldKey);
  }
  return res;
}

function runBlur(state, sourceCanvas, workW, workH, sigma) {
  const { gl, u } = state;
  const res = getResources(state, workW, workH);

  if (gl.canvas.width !== workW || gl.canvas.height !== workH) {
    gl.canvas.width = workW;
    gl.canvas.height = workH;
  }

  const radius = Math.min(135, Math.ceil(3 * sigma));
  const pairs = Math.max(1, Math.min(MAX_PAIRS, Math.ceil(radius / 2)));

  gl.useProgram(state.program);
  gl.viewport(0, 0, workW, workH);
  gl.uniform1f(u.sigma, Math.max(0.1, sigma));
  gl.uniform1i(u.pairs, pairs);

  // upload; FLIP_Y so the flip from rendering the final pass into the default
  // framebuffer cancels out and the result is upright
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, res.texA);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

  // pass 1: horizontal → FBO(texB)
  gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
  gl.uniform2f(u.texelDir, 1 / workW, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // pass 2: vertical → default framebuffer (the WebGL canvas)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, res.texB);
  gl.uniform2f(u.texelDir, 0, 1 / workH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  return res;
}

/**
 * Blurs the background layer. `drawSource(stagingCtx)` must draw the layer
 * using OUTPUT-space coordinates — the staging context's transform is
 * pre-scaled to the working resolution. Returns a canvas at working
 * resolution (caller drawImage()s it up to output size), or null when the
 * caller should fall back to another blur path. The returned canvas is only
 * valid until the next blurBackground() call — consume it synchronously.
 */
export function blurBackground(drawSource, outW, outH, blurPx) {
  if (pathOverride && pathOverride !== 'webgl') return null;
  try {
    const state = ensureGl();
    if (!state) return null;
    const { gl } = state;
    if (gl.isContextLost()) {
      disposeGlState();
      return null;
    }

    const scale = Math.min(1, WORK_LONG / Math.max(outW, outH));
    const workW = Math.max(2, Math.round(outW * scale));
    const workH = Math.max(2, Math.round(outH * scale));

    const res = getResources(state, workW, workH);
    const sctx = res.stagingCtx;
    sctx.setTransform(workW / outW, 0, 0, workH / outH, 0, 0);
    drawSource(sctx); // cover rect + overscan fills every pixel — no clear needed
    sctx.setTransform(1, 0, 0, 1, 0, 0);

    runBlur(state, res.staging, workW, workH, blurPx * scale);
    return gl.canvas;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}
