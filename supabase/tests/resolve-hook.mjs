// Resolve hook: edge files import supabase-js from esm.sh (Deno style).
// Under node we stub it — unit tests never touch the network client.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://')) {
    return {
      url: new URL('./supabase-stub.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
