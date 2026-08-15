/**
 * Entry point and subcommand dispatcher.
 *
 * The compiled build is one executable that has to be able to act as three
 * things: the server, the load generator the server pins to a core set, and the
 * single-threaded burner processes the load generator spawns. A compiled binary
 * cannot be handed a script to run, so those roles are selected by argv instead
 * and the whole program re-invokes itself.
 *
 * Dispatching here rather than in index.ts keeps the child roles cheap: they
 * never import the server, the database, or anything that touches powercfg.
 */
export {}; // this file is a module: every role below is a dynamic import

const [sub, ...rest] = process.argv.slice(2);

if (sub === '--burn') {
  const { burnMain } = await import('./bench/burn.ts');
  burnMain(rest);
} else if (sub === '--loadgen') {
  const { loadgenMain } = await import('./bench/loadgen.ts');
  await loadgenMain(rest);
} else {
  await import('./index.ts');
}
