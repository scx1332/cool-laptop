/** `import x from './y.ps1' with { type: 'file' }` yields the path to the file,
 *  which in a compiled binary points inside the embedded bundle. */
declare module '*.ps1' {
  const path: string;
  export default path;
}
