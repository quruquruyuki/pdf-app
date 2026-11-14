// HarfBuzz（hb-subset）で、使う文字だけのフォントを作る。
// pdf-lib標準のサブセット化は日本語フォントで文字が欠けるため、こちらを使う。
let exportsP = null;

async function hb(wasmUrl) {
  if (!exportsP) {
    exportsP = (async () => {
      const res = await fetch(wasmUrl);
      const bytes = await res.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })().catch(e => { exportsP = null; throw e; });
  }
  return exportsP;
}

export async function subsetFont(fontBytes, text, wasmUrl) {
  const ex = await hb(wasmUrl);
  const src = new Uint8Array(fontBytes);
  const ptr = ex.malloc(src.byteLength);
  new Uint8Array(ex.memory.buffer).set(src, ptr);
  const blob = ex.hb_blob_create(ptr, src.byteLength, 2 /* WRITABLE */, 0, 0);
  const face = ex.hb_face_create(blob, 0);
  ex.hb_blob_destroy(blob);
  const input = ex.hb_subset_input_create_or_fail();
  const set = ex.hb_subset_input_unicode_set(input);
  const cps = new Set([0x20, 0x3f]);
  for (const ch of text) cps.add(ch.codePointAt(0));
  for (const cp of cps) ex.hb_set_add(set, cp);
  const sub = ex.hb_subset_or_fail(face, input);
  ex.hb_subset_input_destroy(input);
  if (!sub) { ex.hb_face_destroy(face); ex.free(ptr); throw new Error('フォントのサブセット化に失敗しました'); }
  const outBlob = ex.hb_face_reference_blob(sub);
  const off = ex.hb_blob_get_data(outBlob, 0);
  const len = ex.hb_blob_get_length(outBlob);
  const out = new Uint8Array(ex.memory.buffer).slice(off, off + len);
  ex.hb_blob_destroy(outBlob);
  ex.hb_face_destroy(sub);
  ex.hb_face_destroy(face);
  ex.free(ptr);
  return out;
}
