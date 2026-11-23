// Resolves the app's gpui-kit and gpui-base to the test stand-in (gpui-stub.mjs).
const STUB = new URL("./gpui-stub.mjs", import.meta.url).href;
export async function resolve(spec, ctx, next) {
  return spec === "gpui-kit" || spec === "gpui-base" ? { url: STUB, shortCircuit: true } : next(spec, ctx);
}
