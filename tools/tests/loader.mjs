// テスト用の読み込み設定：@/ を src/ に、拡張子なしの相対 import を .ts に解決する
// （依存関係を増やさず、Node 22 の型除去で src/lib の TypeScript をそのまま読むため）
const SRC = new URL("../../src/", import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) spec = SRC + spec.slice(2);
  try {
    return await next(spec, ctx);
  } catch (e) {
    if (spec.startsWith(".") || spec.startsWith("file:")) return next(spec + ".ts", ctx);
    throw e;
  }
}
