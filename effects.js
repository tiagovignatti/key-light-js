'use strict';

// Camera effects, one WebGL fragment shader each. A shader reads the camera with
// cam(uv), which crops it to a centered square (mirrored for cameras that face you),
// and can animate with:
//   u_time   a phase in seconds that runs faster on beats
//   u_beat   1 on a beat, decaying to 0 (always 0 without DJ sync)
//   u_beats  a count that steps on every beat (every 2 seconds without DJ sync)
const EFFECTS = {
  none: 'gl_FragColor = cam(v_uv);',

  // Four tiles, each posterized into its own three inks; the inks rotate on beats.
  pop: `
    vec2 tile = floor(v_uv * 2.0);
    float y = luma(cam(fract(v_uv * 2.0)).rgb);
    float hue = fract((tile.x + tile.y * 2.0 + u_beats) * 0.25 + 0.05);
    vec3 c = mix(hsv(hue + 0.5, 0.85, 0.3), hsv(hue, 0.95, 1.0), smoothstep(0.36, 0.42, y));
    c = mix(c, hsv(hue + 0.12, 0.35, 1.0), smoothstep(0.66, 0.72, y));
    gl_FragColor = vec4(c, 1.0);`,

  // Brightness mapped onto a heat-camera palette.
  thermal: `
    float t = clamp(luma(cam(v_uv).rgb) + 0.12 * u_beat, 0.0, 1.0);
    vec3 c = mix(vec3(0.02, 0.0, 0.2), vec3(0.4, 0.0, 0.8), smoothstep(0.0, 0.3, t));
    c = mix(c, vec3(0.95, 0.1, 0.35), smoothstep(0.25, 0.55, t));
    c = mix(c, vec3(1.0, 0.65, 0.0), smoothstep(0.5, 0.8, t));
    c = mix(c, vec3(1.0, 1.0, 0.8), smoothstep(0.8, 1.0, t));
    gl_FragColor = vec4(c, 1.0);`,

  // Ink outlines (Sobel edges), flat punchy colors and halftone dots in the shadows.
  comic: `
    vec2 px = vec2(1.0 / 400.0);
    float tl = luma(cam(v_uv + px * vec2(-1.0, -1.0)).rgb);
    float tc = luma(cam(v_uv + px * vec2(0.0, -1.0)).rgb);
    float tr = luma(cam(v_uv + px * vec2(1.0, -1.0)).rgb);
    float ml = luma(cam(v_uv + px * vec2(-1.0, 0.0)).rgb);
    float mr = luma(cam(v_uv + px * vec2(1.0, 0.0)).rgb);
    float bl = luma(cam(v_uv + px * vec2(-1.0, 1.0)).rgb);
    float bc = luma(cam(v_uv + px * vec2(0.0, 1.0)).rgb);
    float br = luma(cam(v_uv + px * vec2(1.0, 1.0)).rgb);
    float gx = tr + 2.0 * mr + br - tl - 2.0 * ml - bl;
    float gy = bl + 2.0 * bc + br - tl - 2.0 * tc - tr;
    float ink = smoothstep(0.25, 0.5, length(vec2(gx, gy)));
    vec3 c = cam(v_uv).rgb;
    float y = luma(c);
    c = floor(clamp(mix(vec3(y), c, 1.8), 0.0, 1.0) * 4.0 + 0.5) / 4.0;
    float halftone = 1.0 - smoothstep(0.0, 0.08, length(fract(v_uv * 90.0) - 0.5) - (1.0 - y) * 0.45);
    c *= 1.0 - 0.3 * halftone;
    gl_FragColor = vec4(mix(c, vec3(0.06), ink), 1.0);`,

  // Eight mirrored wedges that turn, and sweep across the face, with the music.
  kaleido: `
    vec2 p = v_uv - 0.5;
    float wedge = 6.2831853 / 8.0;
    float a = abs(mod(atan(p.y, p.x) + u_time * 0.25, wedge) - wedge * 0.5) + u_time * 0.1;
    float r = length(p) * (1.0 - 0.15 * u_beat);
    gl_FragColor = cam(0.5 + r * vec2(cos(a), sin(a)));`,

  // Funhouse mirror: magnifies the middle, harder on every beat.
  bulge: `
    vec2 p = v_uv - 0.5;
    float k = 1.6 + 0.8 * u_beat;
    gl_FragColor = cam(0.5 + p * pow(length(p) * 2.0, k - 1.0));`,

  // Torn scanlines and split color channels that kick on beats.
  glitch: `
    float n = hash(vec2(floor(v_uv.y * 28.0), floor(u_time * 10.0)));
    float jolt = 0.15 + 0.85 * u_beat;
    vec2 uv = v_uv + vec2(step(0.82, n) * (n - 0.82) * 1.6 * jolt, 0.0);
    float split = 0.006 + 0.035 * u_beat;
    vec3 c = vec3(cam(uv + vec2(split, 0.0)).r, cam(uv).g, cam(uv - vec2(split, 0.0)).b);
    c *= 0.9 + 0.1 * sin(v_uv.y * 900.0);
    gl_FragColor = vec4(c, 1.0);`,

  // Chunky pixels with a small palette; the pixels grow on beats.
  pixel: `
    float cells = floor(48.0 - 24.0 * u_beat);
    vec2 grid = v_uv * cells;
    vec3 c = floor(cam((floor(grid) + 0.5) / cells).rgb * 4.0 + 0.5) / 4.0;
    c *= 0.85 + 0.15 * step(0.08, min(fract(grid.x), fract(grid.y)));
    gl_FragColor = vec4(c, 1.0);`,
};

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_video;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform float u_mirror;
uniform float u_time;
uniform float u_beat;
uniform float u_beats;
varying vec2 v_uv;

vec4 cam(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  return texture2D(u_video, u_offset + vec2(mix(uv.x, 1.0 - uv.x, u_mirror), uv.y) * u_scale);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;

// Returns draw(video, effect, { time, beat, beats, mirrored }), which renders one frame into
// the canvas, or null when WebGL isn't available. The canvas is square and as
// large as the camera's short side (up to 1440px), so recordings stay sharp.
function createEffectRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const programs = {};

  // Effects compile the first time they're used.
  function program(name) {
    if (programs[name]) return programs[name];
    const p = gl.createProgram();
    gl.attachShader(p, vertex);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, `${FRAGMENT_PRELUDE}void main() {${EFFECTS[name]}\n}`));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    for (const u of ['u_video', 'u_scale', 'u_offset', 'u_mirror', 'u_time', 'u_beat', 'u_beats']) uniforms[u] = gl.getUniformLocation(p, u);
    programs[name] = { p, uniforms };
    return programs[name];
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return function draw(video, effect, { time, beat, beats, mirrored = true }) {
    const { videoWidth: w, videoHeight: h } = video;
    if (!w || !h) return;
    const size = Math.min(w, h, 1440);
    if (canvas.width !== size) canvas.width = canvas.height = size;
    gl.viewport(0, 0, size, size);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);

    const { p, uniforms: u } = program(effect);
    gl.useProgram(p);
    // Crop to a centered square, like object-fit: cover.
    const sx = Math.min(1, h / w);
    const sy = Math.min(1, w / h);
    gl.uniform1i(u.u_video, 0);
    gl.uniform2f(u.u_scale, sx, sy);
    gl.uniform2f(u.u_offset, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform1f(u.u_mirror, mirrored ? 1 : 0);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_beat, beat);
    gl.uniform1f(u.u_beats, beats);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}
