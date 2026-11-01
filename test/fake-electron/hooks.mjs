const FAKE = new URL('./index.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
}
