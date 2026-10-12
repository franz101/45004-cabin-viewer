/* 3D sauna viewer - raw WebGL2, no dependencies, no CDN.
 *
 * Renders the D3Q19 lattice-Boltzmann field from /api/volume:
 *   - volume-raymarched air temperature inside a 3D texture
 *   - GPU-drawn room shell (floor, walls, hipped ceiling) and furniture
 *   - particle "steam" advected through the velocity field on the CPU
 *   - game controls: orbit, or fly with WASD + mouse look (pointer lock)
 *
 * The room shell is built single-sided facing INWARD and back-face culled, so
 * the walls never hide the interior - the classic cutaway that lets you see the
 * flow from outside without a clipping plane.
 */
(function () {
  'use strict';

  const VERT_GEOM = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec3 aCol;
  uniform mat4 uMVP; uniform mat4 uModel;
  out vec3 vNrm; out vec3 vPos; out vec3 vCol;
  void main(){ vNrm = mat3(uModel) * aNrm; vCol = aCol;
    vPos = vec3(uModel * vec4(aPos,1.0));
    gl_Position = uMVP * vec4(aPos,1.0); }`;

  const FRAG_GEOM = `#version 300 es
  precision highp float;
  precision highp sampler3D;
  in vec3 vNrm; in vec3 vPos; in vec3 vCol;
  uniform vec3 uEye; uniform float uEmissive;
  out vec4 o;
  void main(){
    vec3 n = normalize(vNrm);
    vec3 L = normalize(uEye - vPos);
    // two-sided: the room shell faces inward, the furniture outward
    float d = abs(dot(n, L));
    vec3 c = vCol * (0.30 + 0.70 * d);
    c += vCol * uEmissive;
    o = vec4(c, 1.0);
  }`;

  // --- volume raymarch: draw the box's back faces, march to the fragment ---
  const VERT_VOL = `#version 300 es
  in vec3 aPos;
  uniform mat4 uMVP; uniform mat4 uModel;
  out vec3 vWorld;
  void main(){ vWorld = vec3(uModel * vec4(aPos,1.0));
    gl_Position = uMVP * vec4(aPos,1.0); }`;

  const FRAG_VOL = `#version 300 es
  precision highp float;
  precision highp sampler3D;
  in vec3 vWorld;
  uniform vec3 uEye;
  uniform vec3 uBoxMin, uBoxMax;      // world-space AABB of the volume
  uniform sampler3D uTexA, uTexB;     // two animation frames
  uniform float uMix;                 // 0 -> A, 1 -> B
  uniform vec3 uTMin, uTSpan;         // volume AABB in TEXTURE (x,y,z) order
  uniform float uTlo, uThi;
  uniform float uDensity, uStep;
  out vec4 outColor;

  vec3 inferno(float t){
    t = clamp(t, 0.0, 1.0);
    const vec3 c0 = vec3(0.001,0.000,0.014);
    const vec3 c1 = vec3(0.087,0.044,0.224);
    const vec3 c2 = vec3(0.258,0.039,0.406);
    const vec3 c3 = vec3(0.416,0.090,0.432);
    const vec3 c4 = vec3(0.578,0.148,0.404);
    const vec3 c5 = vec3(0.735,0.215,0.330);
    const vec3 c6 = vec3(0.865,0.316,0.226);
    const vec3 c7 = vec3(0.953,0.471,0.098);
    const vec3 c8 = vec3(0.988,0.645,0.039);
    const vec3 c9 = vec3(0.965,0.843,0.275);
    const vec3 c10= vec3(0.988,1.000,0.645);
    float x = t * 10.0; int i = int(floor(x)); float f = fract(x);
    if(i==0) return mix(c0,c1,f);  if(i==1) return mix(c1,c2,f);
    if(i==2) return mix(c2,c3,f);  if(i==3) return mix(c3,c4,f);
    if(i==4) return mix(c4,c5,f);  if(i==5) return mix(c5,c6,f);
    if(i==6) return mix(c6,c7,f);  if(i==7) return mix(c7,c8,f);
    if(i==8) return mix(c8,c9,f);  return mix(c9,c10,f);
  }

  // slab intersection of a ray with an AABB
  vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax){
    vec3 inv = 1.0 / rd;
    vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
    vec3 tsm = min(t0, t1), tbg = max(t0, t1);
    return vec2(max(max(tsm.x, tsm.y), tsm.z),
                min(min(tbg.x, tbg.y), tbg.z));
  }

  void main(){
    vec3 ro = uEye;
    vec3 rd = normalize(vWorld - uEye);
    vec2 h = hitBox(ro, rd, uBoxMin, uBoxMax);
    if(h.y <= h.x) discard;
    float t = max(h.x, 0.0);
    float tend = h.y;
    vec3 span = uBoxMax - uBoxMin;
    vec4 acc = vec4(0.0);
    // march front-to-back with early ray termination
    for(int i = 0; i < 512; i++){
      if(t > tend || acc.a > 0.985) break;
      vec3 p = ro + rd * t;
      // the scene is drawn Y-up (CAD y and z are swapped), but the 3D texture
      // is stored in CAD (x, y, z) order - so undo the swap before sampling
      vec3 sw = vec3(p.x, p.z, p.y);
      vec3 uvw = (sw - uTMin) / uTSpan;
      float a = texture(uTexA, uvw).r;
      float b = texture(uTexB, uvw).r;
      float v = clamp(mix(a, b, uMix), 0.0, 1.0);
      // map temperature to a normalised ramp for the transfer function
      float tn = (uTlo + v * (uThi - uTlo) - uTlo) / max(uThi - uTlo, 1e-3);
      // skip the cold end so the walls do not turn the whole box opaque
      // The air is fairly uniform (60-89 C over most of the room), so a dense
      // volume just saturates into a blob.  Keep it as a warm tint over the
      // geometry and let the steam particles carry the structure.
      float d = pow(clamp(tn, 0.0, 1.0), 1.0) * uDensity;
      if(d > 0.002){
        vec3 c = inferno(tn);
        float al = 1.0 - exp(-d * uStep);
        acc.rgb += (1.0 - acc.a) * al * c;
        acc.a   += (1.0 - acc.a) * al;
      }
      t += uStep;
    }
    outColor = acc;
  }`;

  const VERT_PT = `#version 300 es
  in vec3 aPos; in float aAge;
  uniform mat4 uMVP; uniform float uPx;
  out float vAge;
  void main(){ vAge = aAge;
    gl_Position = uMVP * vec4(aPos, 1.0);
    gl_PointSize = uPx; }`;

  const FRAG_PT = `#version 300 es
  precision highp float;
  precision highp sampler3D;
  in float vAge; out vec4 o;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if(r > 0.5) discard;
    float a = (1.0 - r * 2.0) * 0.42 * (1.0 - vAge * 0.75);
    o = vec4(0.86, 0.93, 1.0, a);
  }`;

  // ------------------------------------------------------------- maths
  const M4 = {
    ident: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
    mul(a, b) {
      const o = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+j] * b[i*4+k];
        o[i*4+j] = s;
      }
      return o;
    },
    persp(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
      o[0] = t/asp; o[5] = t; o[10] = (f+n)/(n-f); o[11] = -1;
      o[14] = 2*f*n/(n-f); return o;
    },
    lookAt(eye, ctr, up) {
      let z = norm(sub(eye, ctr)), x = norm(cross(up, z)), y = cross(z, x);
      return new Float32Array([
        x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
    },
  };
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const norm=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];};

  // ------------------------------------------------------------- state
  const V = {
    gl: null, progGeom: null, progVol: null, progPt: null,
    geom: null, box: null, nBox: 0, meshes: [],
    vol: null, texA: null, texB: null, dims: [1,1,1],
    parts: null, nParts: 0, Tlo: 0, Thi: 1,
    cam: { yaw: -0.7, pitch: 0.42, dist: 3.4, target: [0,0,0],
           pos: [3,2,3], fly: false },
    keys: {}, mix: 1.0, playing: true, t0: performance.now(),
    density: 0.42, step: 0.005, mode: 'both', loaded: false,
  };

  function compile(gl, vs, fs, name) {
    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(name + ': ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  function attr(gl, p, n) { const l = gl.getAttribLocation(p, n);
    return l < 0 ? null : l; }

  // ------------------------------------------------------------- geometry
  function roofHeight(x, y, R) {
    const d = Math.min(x - R.ROOF_X0, R.ROOF_X1 - x,
                       y - R.ROOF_Y0, R.ROOF_Y1 - y);
    return Math.max(R.WALL_H, R.WALL_H + Math.max(d, 0) * R.TAN_PITCH
                    - R.CEIL_OFFSET);
  }

  function buildScene(payload) {
    // the solver metadata is nested under `meta`; `box` is duplicated at the
    // top level so the viewer does not have to know which is which
    const M = payload.meta || {};
    const b = payload.box || M.box;
    const R = M.roof;
    const solids = M.solids || [];
    if (!b || !R) throw new Error('volume payload is missing box/roof');
    const cx = (b.x0+b.x1)/2, cy = (b.y0+b.y1)/2, cz = (b.z0+b.z1)/2;
    const dim = Math.max(b.x1-b.x0, b.y1-b.y0, b.z1-b.z0);
    const sc = 2.0 / dim;
    const W = (x,y,z) => [(x-cx)*sc, (z-cz)*sc, (y-cy)*sc];  // z-up -> gl y-up
    V.toWorld = W;
    V.scale = sc; V.center = [cx, cy, cz];

    const pos = [], nrm = [], col = [], idx = [];
    let base = 0;
    const tri = (p, n, c) => {
      for (let i = 0; i < 3; i++) {
        pos.push(p[i][0], p[i][1], p[i][2]);
        nrm.push(n[0], n[1], n[2]);
        col.push(c[0], c[1], c[2]);
      }
      idx.push(base, base+1, base+2); base += 3;
    };
    // quad facing `n`
    const quad = (a, b2, c, d, n, cc) => { tri([a,b2,c], n, cc); tri([a,c,d], n, cc); };

    const zf = b.z0, CC = [0.30, 0.30, 0.34], WC = [0.55, 0.44, 0.34];
    // floor (faces up)
    quad(W(b.x0,b.y0,zf), W(b.x1,b.y0,zf), W(b.x1,b.y1,zf), W(b.x0,b.y1,zf),
         [0,1,0], [0.36,0.30,0.24]);
    // four walls, tops following the hipped ceiling; normals face inward
    const NX = 14;
    const wallStrip = (p0, p1, n) => {
      for (let i = 0; i < NX; i++) {
        const f0 = i/NX, f1 = (i+1)/NX;
        const a = [p0[0]+(p1[0]-p0[0])*f0, p0[1]+(p1[1]-p0[1])*f0];
        const c = [p0[0]+(p1[0]-p0[0])*f1, p0[1]+(p1[1]-p0[1])*f1];
        const ha = roofHeight(a[0], a[1], R), hc = roofHeight(c[0], c[1], R);
        quad(W(a[0],a[1],zf), W(a[0],a[1],ha), W(c[0],c[1],hc), W(c[0],c[1],zf),
             n, WC);
      }
    };
    wallStrip([b.x0,b.y0], [b.x0,b.y1], [ 1,0,0]);
    wallStrip([b.x1,b.y0], [b.x1,b.y1], [-1,0,0]);
    wallStrip([b.x0,b.y0], [b.x1,b.y0], [0, 1,0]);
    wallStrip([b.x0,b.y1], [b.x1,b.y1], [0,-1,0]);
    // hipped ceiling, grid sampled (normal points down/inward)
    const NC = 20;
    for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) {
      const x0 = b.x0+(b.x1-b.x0)*i/NC, x1 = b.x0+(b.x1-b.x0)*(i+1)/NC;
      const y0 = b.y0+(b.y1-b.y0)*j/NC, y1 = b.y0+(b.y1-b.y0)*(j+1)/NC;
      const h00 = roofHeight(x0,y0,R), h10 = roofHeight(x1,y0,R),
            h11 = roofHeight(x1,y1,R), h01 = roofHeight(x0,y1,R);
      quad(W(x0,y0,h00), W(x0,y1,h01), W(x1,y1,h11), W(x1,y0,h10),
           [0,-1,0], [0.42,0.32,0.26]);
    }
    // furniture as closed boxes
    for (const s of solids) {
      const c = s.color, x0=s.x0,x1=s.x1,y0=s.y0,y1=s.y1,z0=s.z0,z1=s.z1;
      quad(W(x0,y0,z0),W(x1,y0,z0),W(x1,y1,z0),W(x0,y1,z0),[0,0,-1],c);
      quad(W(x0,y0,z1),W(x0,y1,z1),W(x1,y1,z1),W(x1,y0,z1),[0,0, 1],c);
      quad(W(x0,y0,z0),W(x0,y0,z1),W(x1,y0,z1),W(x1,y0,z0),[0,-1,0],c);
      quad(W(x0,y1,z0),W(x1,y1,z0),W(x1,y1,z1),W(x0,y1,z1),[0, 1,0],c);
      quad(W(x0,y0,z0),W(x0,y1,z0),W(x0,y1,z1),W(x0,y0,z1),[-1,0,0],c);
      quad(W(x1,y0,z0),W(x1,y0,z1),W(x1,y1,z1),W(x1,y1,z0),[ 1,0,0],c);
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm),
             col: new Float32Array(col), idx: new Uint32Array(idx) };
  }

  // ------------------------------------------------------------- volume
  function b64bytes(s) {
    const bin = atob(s), n = bin.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function tex3d(gl, data, dims) {
    const t = gl.createTexture();
    // a 35-pixel-wide R8 row is 35 bytes, not a multiple of 4, so the default
    // UNPACK_ALIGNMENT of 4 makes the driver expect padded rows and reject the
    // buffer with "ArrayBufferView not big enough for request"
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, dims[0], dims[1], dims[2], 0,
                  gl.RED, gl.UNSIGNED_BYTE, data);
    return t;
  }

  function loadVolume(payload) {
    const gl = V.gl;
    V.dims = payload.shape;
    V.Tlo = payload.T_lo; V.Thi = payload.T_hi;
    const d = payload.T_frames.map(f => b64bytes(f.data));
    V.texA = tex3d(gl, d[0], V.dims);
    V.texB = tex3d(gl, d[d.length - 1], V.dims);
    V.nFrames = d.length;
    // velocity field for the particles
    const u = b64bytes(payload.u), v = b64bytes(payload.v),
          w = b64bytes(payload.w), m = b64bytes(payload.mask);
    V.mask = m;
    V.vel = { u, v, w };
    V.meta = payload;
    V.box = payload.box || (payload.meta && payload.meta.box);
    const b = V.box;
    const W = V.toWorld;
    V.volMin = W(b.x0, b.y0, b.z0);
    V.volMax = W(b.x1, b.y1, b.z1);
    // texture-space bounds: the CAD box, in CAD axis order
    V.texMin = new Float32Array([b.x0, b.y0, b.z0]);
    V.texSpan = new Float32Array([b.x1-b.x0, b.y1-b.y0, b.z1-b.z0]);
    spawnParticles(2600);
    V.loaded = true;
  }

  function sampleField(arr, x, y, z) {
    const [gx, gy, gz] = V.dims;
    // Math.floor is required: a TypedArray indexed with 12.7 returns
    // undefined, and `undefined > 127` is false, so every fluid test silently
    // failed and no particle was ever spawned.
    const xi = Math.min(Math.max(Math.floor(x), 0), gx - 1);
    const yi = Math.min(Math.max(Math.floor(y), 0), gy - 1);
    const zi = Math.min(Math.max(Math.floor(z), 0), gz - 1);
    return arr[(xi * gy + yi) * gz + zi];
  }
  function fluidAt(x, y, z) { return sampleField(V.mask, x, y, z) > 127; }

  function spawnParticles(n) {
    const [gx, gy, gz] = V.dims;
    const p = new Float32Array(n * 3), age = new Float32Array(n);
    let k = 0, guard = 0;
    while (k < n && guard < n * 400) {
      guard++;
      const x = Math.random() * (gx - 1), y = Math.random() * (gy - 1),
            z = Math.random() * (gz - 1);
      if (!fluidAt(x, y, z)) continue;
      p[k*3] = x; p[k*3+1] = y; p[k*3+2] = z;
      age[k] = Math.random();
      k++;
    }
    V.parts = p; V.ages = age; V.nParts = k;
  }

  const DIRS = [
    [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
    [1,1,0],[-1,-1,0],[1,-1,0],[-1,1,0],
    [1,0,1],[-1,0,-1],[1,0,-1],[-1,0,1],
    [0,1,1],[0,-1,-1],[0,1,-1],[0,-1,1]];

  function advect(dt) {
    if (!V.vel) return;
    const [gx, gy, gz] = V.dims;
    const p = V.parts, age = V.ages;
    const spd = 9.0 * dt;
    for (let k = 0; k < V.nParts; k++) {
      let x = p[k*3], y = p[k*3+1], z = p[k*3+2];
      let ux = sampleField(V.vel.u, x, y, z) / 255 * 2 - 1;
      let uy = sampleField(V.vel.v, x, y, z) / 255 * 2 - 1;
      let uz = sampleField(V.vel.w, x, y, z) / 255 * 2 - 1;
      const L = Math.hypot(ux, uy, uz) || 1;
      const nx = x + ux / L * spd, ny = y + uy / L * spd, nz = z + uz / L * spd;
      age[k] += dt * 0.22;
      if (age[k] > 1 || !fluidAt(nx, ny, nz)) {
        // respawn somewhere in the fluid
        let g = 0;
        do { x = Math.random()*(gx-1); y = Math.random()*(gy-1);
             z = Math.random()*(gz-1); g++; } while (!fluidAt(x,y,z) && g < 60);
        p[k*3]=x; p[k*3+1]=y; p[k*3+2]=z; age[k]=0;
      } else { p[k*3]=nx; p[k*3+1]=ny; p[k*3+2]=nz; }
    }
    V.dirtyParts = true;
  }

  // ------------------------------------------------------------- render
  // Cap the drawing buffer.  Volume raymarching costs ~300 texture fetches per
  // pixel, so a Retina-sized canvas is 3-4 MP of marching and drops the frame
  // rate for no visible gain.  Capping keeps it interactive.
  const MAX_PIXELS = 1_300_000;
  function resize(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth || 800, ch = cv.clientHeight || 600;
    let w = Math.floor(cw * dpr), h = Math.floor(ch * dpr);
    const px = w * h;
    if (px > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / px);
      w = Math.max(2, Math.floor(w * k)); h = Math.max(2, Math.floor(h * k));
    }
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    V.gl.viewport(0, 0, cv.width, cv.height);
    return cv.width / cv.height;
  }

  function eyePos() {
    const c = V.cam;
    if (c.fly) return c.pos;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    return [c.target[0] + c.dist*cp*Math.sin(c.yaw),
            c.target[1] + c.dist*sp,
            c.target[2] + c.dist*cp*Math.cos(c.yaw)];
  }

  function frame(now) {
    const cv = document.getElementById('c3d');
    if (!cv || !V.gl) return;
    const gl = V.gl, asp = resize(cv);
    gl.clearColor(0.055, 0.06, 0.075, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const dt = Math.min((now - V.t0) / 1000, 0.05); V.t0 = now;
    if (V.playing) { V.mix = (Math.sin(now / 5200) + 1) / 2; advect(dt); }

    const eye = eyePos();
    const view = M4.lookAt(eye, V.cam.target, [0,1,0]);
    const proj = M4.persp(0.85, asp, 0.05, 60);
    const model = M4.ident();
    const mvp = M4.mul(proj, M4.mul(view, model));

    if (!V.loaded) {
      requestAnimationFrame(frame); return;
    }

    // --- opaque geometry
    if (V.mode === 'both' || V.mode === 'temp') {
      const pg = V.progGeom;
      gl.useProgram(pg);
      gl.uniformMatrix4fv(pg.u('uMVP'), false, mvp);
      gl.uniformMatrix4fv(pg.u('uModel'), false, model);
      gl.uniform3fv(pg.u('uEye'), eye);
      gl.bindVertexArray(V.vao);
      gl.uniform1f(pg.u('uEmissive'), 0.0);
      gl.drawElements(gl.TRIANGLES, V.nBox, gl.UNSIGNED_INT, 0);
    }

    // --- volume
    if (V.mode === 'both' || V.mode === 'temp' || V.mode === 'vol') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.cullFace(gl.FRONT);          // draw back faces, march forward
      const pv = V.progVol;
      gl.useProgram(pv);
      gl.uniformMatrix4fv(pv.u('uMVP'), false, mvp);
      gl.uniformMatrix4fv(pv.u('uModel'), false, model);
      gl.uniform3fv(pv.u('uEye'), eye);
      gl.uniform3fv(pv.u('uBoxMin'), V.volMin);
      gl.uniform3fv(pv.u('uBoxMax'), V.volMax);
      gl.uniform3fv(pv.u('uTMin'), V.texMin);
      gl.uniform3fv(pv.u('uTSpan'), V.texSpan);
      gl.uniform1f(pv.u('uTlo'), V.Tlo);
      gl.uniform1f(pv.u('uThi'), V.Thi);
      gl.uniform1f(pv.u('uMix'), V.mix);
      gl.uniform1f(pv.u('uDensity'), V.density);
      gl.uniform1f(pv.u('uStep'), V.step);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, V.texA);
      gl.uniform1i(pv.u('uTexA'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, V.texB);
      gl.uniform1i(pv.u('uTexB'), 1);
      gl.bindVertexArray(V.vaoVol);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.cullFace(gl.BACK);
    }

    // --- particles
    if ((V.mode === 'both' || V.mode === 'flow') && V.nParts) {
      const b = V.box;
      const dst = V.ptBuf;
      for (let k = 0; k < V.nParts; k++) {
        const w = V.toWorld(V.parts[k*3], V.parts[k*3+1], V.parts[k*3+2]);
        dst[k*4] = w[0]; dst[k*4+1] = w[1]; dst[k*4+2] = w[2];
        dst[k*4+3] = V.ages[k];
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.useProgram(V.progPt);
      gl.uniformMatrix4fv(V.progPt.u('uMVP'), false, mvp);
      const px = Math.max(cv.height / 150, 1.6);
      gl.uniform1f(V.progPt.u('uPx'), px);
      gl.bindVertexArray(V.vaoPt);
      gl.bindBuffer(gl.ARRAY_BUFFER, V.ptBufGl);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dst);
      gl.drawArrays(gl.POINTS, 0, V.nParts);
      gl.disable(gl.BLEND);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- controls
  function bindControls(cv) {
    let drag = false, lx = 0, ly = 0;
    cv.addEventListener('mousedown', e => {
      if (V.cam.fly) cv.requestPointerLock();
      drag = true; lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('mouseup', () => drag = false);
    window.addEventListener('mousemove', e => {
      const c = V.cam;
      if (c.fly && document.pointerLockElement === cv) {
        c.yaw -= e.movementX * 0.0026; c.pitch -= e.movementY * 0.0026;
        c.pitch = Math.max(-1.5, Math.min(1.5, c.pitch));
        const d = 0.35;
        const fwd = [Math.sin(c.yaw)*Math.cos(c.pitch), -Math.sin(c.pitch),
                     Math.cos(c.yaw)*Math.cos(c.pitch)];
        const right = [Math.cos(c.yaw), 0, -Math.sin(c.yaw)];
        for (const [k, v] of Object.entries(V.keys)) if (v) {
          for (let i = 0; i < 3; i++) c.pos[i] += (fwd[i]*({w:1,s:-1}[k]||0)
            + right[i]*({d:1,a:-1}[k]||0)) * d;
        }
        if (V.keys.q) c.pos[1] += d; if (V.keys.e) c.pos[1] -= d;
        return;
      }
      if (!drag) return;
      if (c.fly) {
        c.yaw -= (e.clientX - lx) * 0.005; c.pitch -= (e.clientY - ly) * 0.005;
        c.pitch = Math.max(-1.4, Math.min(1.4, c.pitch));
      } else {
        c.yaw -= (e.clientX - lx) * 0.007;
        c.pitch = Math.max(-1.35, Math.min(1.35, c.pitch + (e.clientY - ly) * 0.006));
      }
      lx = e.clientX; ly = e.clientY;
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      V.cam.dist = Math.max(0.6, Math.min(12, V.cam.dist * (1 + e.deltaY * 0.0012)));
    }, { passive: false });
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      V.keys[k] = true;
      if (k === 'f') { V.cam.fly = !V.cam.fly;
        V.cam.pos = eyePos(); if (V.cam.fly) cv.requestPointerLock(); }
      if (k === 'r') { V.cam.yaw = -0.7; V.cam.pitch = 0.42; V.cam.dist = 3.4; }
      if (k === ' ') { V.playing = !V.playing; e.preventDefault(); }
    });
    window.addEventListener('keyup', e => { V.keys[e.key.toLowerCase()] = false; });
  }

  // ------------------------------------------------------------- init
  async function init() {
    const cv = document.getElementById('c3d');
    if (!cv) return;
    const gl = cv.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) { cv.insertAdjacentHTML('afterend',
        '<div class="note bad">WebGL2 is not available in this browser.</div>'); return; }
    V.gl = gl;
    const P = compile(gl, VERT_GEOM, FRAG_GEOM, 'geom');
    const Pv = compile(gl, VERT_VOL, FRAG_VOL, 'vol');
    const Pp = compile(gl, VERT_PT, FRAG_PT, 'pt');
    // returns a *lookup function* over pre-fetched locations.  Returning the
    // map itself and then calling pg.u('name') is the bug that threw
    // "pg.u is not a function" and left the canvas black.
    const U = p => {
      const m = {};
      for (const n of ['uMVP','uModel','uEye','uEmissive','uBoxMin','uBoxMax',
                       'uTexA','uTexB','uMix','uTlo','uThi','uDensity','uStep',
                       'uPx','uTMin','uTSpan']) {
        const l = gl.getUniformLocation(p, n);
        if (l) m[n] = l;
      }
      return n => (m[n] === undefined ? null : m[n]);
    };
    V.progGeom = P; P.u = U(P);
    V.progVol = Pv; Pv.u = U(Pv);
    V.progPt = Pp; Pp.u = U(Pp);

    let r;
    try { r = await (await fetch('/api/volume')).json(); }
    catch (e) { document.getElementById('v3dInfo').textContent =
      'could not load the 3D field: ' + e.message; return; }
    if (r.error) { document.getElementById('v3dInfo').innerHTML =
      '<span class="warn">' + r.error + '</span>'; return; }

    // scene geometry
    const S = buildScene(r);
    V.box = r.box;
    V.nBox = S.idx.length;
    const mk = (tgt, data, target) => { const b = gl.createBuffer();
      gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    V.vao = gl.createVertexArray(); gl.bindVertexArray(V.vao);
    let bp = mk(null, S.pos, gl.ARRAY_BUFFER);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    let bn = mk(null, S.nrm, gl.ARRAY_BUFFER);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    let bc2 = mk(null, S.col, gl.ARRAY_BUFFER);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    mk(null, S.idx, gl.ELEMENT_ARRAY_BUFFER);

    // volume box (unit cube, transformed in the shader by the AABB uniforms)
    const cube = new Float32Array([
      -1,-1,-1, 1,-1,-1, 1,1,-1, -1,-1,-1, 1,1,-1, -1,1,-1,
      -1,-1, 1, 1,1, 1, 1,-1, 1, -1,-1, 1, -1,1, 1, 1,1, 1,
      -1,-1,-1, -1,1,-1, -1,1, 1, -1,-1,-1, -1,1, 1, -1,-1, 1,
       1,-1,-1,  1,-1, 1,  1,1, 1,  1,-1,-1,  1,1, 1,  1,1,-1,
      -1,-1,-1, -1,-1, 1,  1,-1, 1, -1,-1,-1,  1,-1, 1,  1,-1,-1,
      -1, 1,-1,  1, 1,-1,  1, 1, 1, -1, 1,-1,  1, 1, 1, -1, 1, 1]);
    // the shader does the AABB test, so scale the unit cube to the AABB
    V.vaoVol = gl.createVertexArray(); gl.bindVertexArray(V.vaoVol);
    const bc = mk(null, cube, gl.ARRAY_BUFFER);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const ci = new Uint16Array([0,1,2,3,4,5, 6,7,8,9,10,11, 12,13,14,15,16,17,
      18,19,20,21,22,23, 24,25,26,27,28,29, 30,31,32,33,34,35]);
    mk(null, ci, gl.ELEMENT_ARRAY_BUFFER);

    V.ptBuf = new Float32Array(2600 * 4);
    V.vaoPt = gl.createVertexArray(); gl.bindVertexArray(V.vaoPt);
    V.ptBufGl = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, V.ptBufGl);
    gl.bufferData(gl.ARRAY_BUFFER, V.ptBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);

    loadVolume(r);
    bindControls(cv);
    const m = r.meta || {};
    document.getElementById('v3dInfo').innerHTML =
      `${r.shape.join('×')} field, ${r.T_frames.length} frames, ` +
      `T ${V.Tlo.toFixed(0)}–${V.Thi.toFixed(0)} °C · ` +
      `Ra ${(m.Ra_eff||0).toExponential(1)} vs physical ` +
      `${(m.Ra_physical||3.9e10).toExponential(1)} · ` +
      `<b>drag</b> orbit, <b>wheel</b> zoom, <b>F</b> fly mode (WASD + mouse), ` +
      `<b>space</b> pause`;
    (r.warnings || []).forEach(w => {
      document.getElementById('v3dInfo').insertAdjacentHTML('beforeend',
        `<div class="warn">⚠ ${w}</div>`);
    });
    requestAnimationFrame(frame);
  }

  window.Viz3D = { init, V };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
