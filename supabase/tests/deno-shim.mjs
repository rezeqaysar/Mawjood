// Deno env shim for running edge code under node (tests only).
// Backs Deno.env with the LIVE process.env so tests can set secrets.
globalThis.Deno = {
  env: {
    get: (k) => process.env[k] ?? undefined,
    set: (k, v) => { process.env[k] = v; },
    delete: (k) => { delete process.env[k]; },
  },
};
