// Static JS wrapper for the sauna WASM module.
//
// Exposes the same JSON shapes as the Python endpoints in sauna/web/server.py:
//   apiModel(query) -> /api/model
//   apiRun(query)   -> /api/run
//   apiSweep(query) -> /api/sweep
// `query` takes the same keys as the server's query string.  Values may be
// strings or numbers.  Works in the browser and under bun/node.
//
// Phase-1 limits (see sauna/wasm/README in the report):
//   * the envelope and geometry are not ported.  They come from the
//     reference fabric JSON (make_reference.py), which is for the default
//     insulation only (wall 0 mm, roof 100 mm, floor 0 mm).  Other insulation
//     values throw.
//   * the geometry, envelope and standards blocks of /api/model are static.

const DEFAULT_INSULATION = { wallins: 0, roofins: 100, floorins: 0 };

function stringifyQuery(query) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}

// server._f: float(value), falling back to the default when the value is
// missing, empty or not a number Python's float() accepts.
function pyFloat(v, def) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  return def;
}

async function fetchOk(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`not found: ${path} (HTTP ${res.status})`);
  return res;
}

function checkInsulation(query) {
  for (const [key, def] of Object.entries(DEFAULT_INSULATION)) {
    if (pyFloat(query[key], def) !== def) {
      throw new Error(
        `${key}=${query[key]} needs the envelope build, which is not in the WASM ` +
          `phase 1 (only ${key}=${def} is available)`,
      );
    }
  }
}

/**
 * @param {object} opts
 * @param {string|URL|BufferSource} opts.wasm   URL of sauna.wasm, or its bytes
 * @param {object} opts.fabricRun   contents of reference/fabric_run.json
 * @param {object} opts.fabricSweep contents of reference/fabric_sweep.json
 * @param {object} opts.staticModel contents of reference/model.json (its `response`
 *                                  supplies the static geometry/envelope blocks)
 */
export async function loadSauna({ wasm, fabricRun, fabricSweep, staticModel }) {
  let bytes;
  if (typeof wasm === "string" || wasm instanceof URL) {
    bytes = await (await fetchOk(wasm)).arrayBuffer();
  } else {
    bytes = wasm;
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function call(fn, payload) {
    const data = enc.encode(JSON.stringify(payload));
    const ptr = ex.sauna_alloc(data.length);
    new Uint8Array(ex.memory.buffer, ptr, data.length).set(data);
    const n = fn(ptr, data.length);
    ex.sauna_free(ptr, data.length);
    const outPtr = ex.sauna_out_ptr();
    const text = dec.decode(new Uint8Array(ex.memory.buffer, outPtr, n));
    const obj = JSON.parse(text);
    if (obj.error) throw new Error(obj.error);
    return obj;
  }

  const ref = staticModel.response;

  return {
    apiModel(query = {}) {
      const q = stringifyQuery(query);
      checkInsulation(q);
      const live = call(ex.sauna_model, { query: q, fabric: fabricRun });
      return {
        geometry: ref.geometry,
        envelope: ref.envelope,
        model: {
          ...live.model,
          fabric_notes: ref.model.fabric_notes,
          bench_notes: ref.model.bench_notes,
        },
        standards: ref.standards,
        builder_drift: ref.builder_drift,
        backends: ["wasm"],
      };
    },

    // `fabric` overrides the default envelope, for verifying a reference case
    // whose insulation differs; the browser never needs it.
    apiRun(query = {}, { fabric = fabricRun } = {}) {
      const q = stringifyQuery(query);
      if (fabric === fabricRun) checkInsulation(q);
      return call(ex.sauna_run, { query: q, fabric });
    },

    apiSweep(query = {}, { fabric = fabricSweep } = {}) {
      const q = stringifyQuery(query);
      const t0 = performance.now();
      const out = call(ex.sauna_sweep, { query: q, fabric });
      out.seconds = (performance.now() - t0) / 1000;
      return out;
    },
  };
}
