// Oodle Kraken, the compression inside Unreal Engine 5 paks and IoStore containers.
// The decoder is ooz-wasm (GPL-3.0-or-later). MomoGram calls it; it does not reimplement it.
// The package export is index.js, which awaits the factory at load time. A classic script
// bundle cannot do that, so the factory file is imported directly and started on first use.
// @ts-expect-error the factory file has no types; the shape used below is the public decoder API
import oozFactory from '../../node_modules/ooz-wasm/build/ooz.js';

type Ooz = {
  _malloc(n: number): number;
  _free(p: number): void;
  _Kraken_Decompress(src: number, srcLen: number, dst: number, dstLen: number): number;
  HEAPU8: Uint8Array;
};

let ready: Promise<Ooz> | null = null;

/** one Oodle block → exactly `rawSize` bytes. */
export async function oodle(data: Uint8Array, rawSize: number): Promise<Uint8Array> {
  if (!ready) ready = oozFactory() as Promise<Ooz>;
  const ooz = await ready;
  const src = ooz._malloc(data.byteLength);
  ooz.HEAPU8.set(data, src);
  const dst = ooz._malloc(rawSize + 64);
  const n = ooz._Kraken_Decompress(src, data.byteLength, dst, rawSize);
  const out = ooz.HEAPU8.slice(dst, dst + (n > 0 ? n : 0));
  ooz._free(src);
  ooz._free(dst);
  if (n !== rawSize) throw new Error('Oodle decompress failed.');
  return out;
}
